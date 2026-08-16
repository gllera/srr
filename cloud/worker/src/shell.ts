// The pieces both workers share — the reader bundle's response headers, the
// request envelope around every dispatch, the deny path, and the
// deployment-config guard. One copy, so a cache rule or a header tweak lands on
// both origins or on neither.
import { SHELL_HASHED_RE } from "./router"

export interface ShellEnv {
   ASSETS: Fetcher
}

// Mirror of frontend/_headers (the reader's CSP). index.html carries the same
// policy as a <meta> fallback, but the header is the real layer here.
export const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'"

// `no-store` like every other verdict here: 404 and 405 are both on RFC 9110's
// heuristically-cacheable list, so without it they are the two responses an
// intermediary may store on its own initiative — and one of them is the answer
// to a backend-only object class.
export const notFound = () => new Response("not found", { status: 404, headers: { "cache-control": "no-store" } })

// Internal to denyAnonymous below — the only question either worker ever asked
// it, now that both deny through one path.
const isNavigation = (request: Request) =>
   request.headers.get("sec-fetch-mode") === "navigate" || (request.headers.get("accept") || "").includes("text/html")

// no-store because the 401/403 branches of deny() are these: an auth verdict a
// shared cache could hand to the next visitor is not a verdict.
export const jsonNoStore = (status: number, error: string) =>
   new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
   })

// Anonymous → login redirect (navigations) or 401 (fetches). Both workers deny
// an anonymous request identically; only the SaaS worker has a second,
// authenticated-but-unauthorized case, which it adds on top of this.
//
// The login is each origin's OWN now, so `next` is a same-origin PATH rather
// than the absolute URL a cross-origin login app had to be handed — and oidc.ts
// validates it again on the way back out (safeNext) instead of trusting the
// cookie it round-tripped through.
export function denyAnonymous(request: Request, url: URL): Response {
   // One verdict, one spelling. The two workers used to answer "auth required"
   // and "unauthenticated" for the identical condition; nothing reads either.
   if (!isNavigation(request)) return jsonNoStore(401, "unauthenticated")
   const login = new URL("/auth/login", url.origin)
   login.searchParams.set("next", url.pathname + url.search)
   return new Response(null, {
      status: 302,
      headers: { location: login.toString(), "cache-control": "no-store" },
   })
}

// Every one of these is operator config supplied out of band (`wrangler secret
// put`), so an unset one is a DEPLOYMENT mistake and not a request the user got
// wrong. Say so with a 500: falling through would send a visitor to a login that
// cannot complete, and they would meet a redirect loop instead of a cause.
//
// The CHECK is shared; the LIST is not, and must not be — it belongs to whoever
// reads the value. These four are the sign-in's, which both workers need. The
// cloud worker also needs ROSTER, and a shared list could not name it: an env
// typed for the sign-in cannot see it, so a deploy that forgot it passed this
// guard, completed the whole handshake, and then answered its own owner
// `forbidden` forever — the exact half-working deployment the 500 exists for.
export const AUTH_CONFIG = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_HMAC_SECRET"] as const

// `object` rather than a keyed type: the two workers' Env shapes differ, and the
// point of this function is that the LIST is the caller's.
const missingConfig = (env: object, needed: readonly string[]): string[] =>
   needed.filter((k) => !(env as Record<string, unknown>)[k])

/**
 * The envelope around every request on both origins: the method gate, the
 * deployment-config guard, the failure floor, and HEAD.
 *
 * It is shared because it had already DRIFTED as two copies — one worker sent
 * `Allow` with its 405 and the other did not (RFC 9110 §15.5.6 requires it),
 * and each suite pinned only its own side. `methods` comes from the route's
 * policy, so the gate and the header now read one array.
 */
export async function runWorker(opts: {
   name: string
   request: Request
   url: URL
   env: object
   /** Every deployment value this worker reads — see AUTH_CONFIG above. */
   needed: readonly string[]
   methods: readonly string[]
   dispatch: () => Promise<Response>
}): Promise<Response> {
   const { name, request, url, env, needed, methods, dispatch } = opts

   // HEAD is a GET whose body is dropped on the way out, so it is gated as one.
   const method = request.method === "HEAD" ? "GET" : request.method
   if (!methods.includes(method)) {
      return new Response("method not allowed", {
         status: 405,
         headers: { allow: methods.join(", "), "cache-control": "no-store" },
      })
   }

   const missing = missingConfig(env, needed)
   if (missing.length > 0) {
      console.log(`${name} is misconfigured — unset: ${missing.join(", ")}`)
      return new Response("misconfigured", { status: 500, headers: { "cache-control": "no-store" } })
   }

   // The sign-in legs reach the IdP, so they can fail for reasons that are
   // nobody's fault and nothing's bug: discovery unreachable, JWKS 503, a
   // network blip. Unhandled, that is an exception out of the fetch handler —
   // the runtime's bare 500, no log line, and a visitor who cannot tell it
   // from a broken deployment. 503 says "try again" and means it.
   let res: Response
   try {
      res = await dispatch()
   } catch (e) {
      console.log(`${name}: ${url.pathname} failed: ${e instanceof Error ? e.message : String(e)}`)
      res = new Response("temporarily unavailable", {
         status: 503,
         headers: { "cache-control": "no-store", "retry-after": "30" },
      })
   }
   // HEAD: same logic, body stripped (R2/asset bodies are cheap at this scale).
   return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res
}

// The shell gets nosniff but NEVER index.ts's userContent(): its `sandbox`
// would drop the reader into an opaque origin with scripting off — the app
// would simply not run. Two different jobs sharing one header name is exactly
// the trap, so the shell sets its own and the store keeps its own.
export async function serveShellIndex(request: Request, env: ShellEnv): Promise<Response> {
   const res = await env.ASSETS.fetch(new URL("/index.html", request.url))
   // Our own 404, same as the asset path below: a staged bundle with no
   // index.html would otherwise hand back the assets layer's raw response with
   // this function's CSP and cache-control stamped onto it.
   if (!res.ok) return notFound()
   const headers = new Headers(res.headers)
   headers.set("cache-control", "no-cache")
   headers.set("content-security-policy", CSP)
   headers.set("x-content-type-options", "nosniff")
   return new Response(res.body, { status: res.status, headers })
}

export async function serveShellAsset(request: Request, env: ShellEnv, name: string): Promise<Response> {
   const res = await env.ASSETS.fetch(new URL(`/${name}`, request.url))
   // Our own 404, not the assets layer's: every other miss on both origins
   // answers notFound(), and a passed-through body would carry neither this
   // worker's shape nor its nosniff.
   if (!res.ok) return notFound()
   const headers = new Headers(res.headers)
   // Which names may be stamped immutable is router.ts's call — it is a fact
   // about the name, and it lives beside the grammar that enumerates them.
   headers.set("cache-control", SHELL_HASHED_RE.test(name) ? "public, max-age=31536000, immutable" : "no-cache")
   // Safe only because these are OUR bundle's bytes under correct types: nosniff
   // BLOCKS a script served as anything but a JS MIME type (and a stylesheet as
   // anything but text/css), so the asset test pins the type alongside it.
   headers.set("x-content-type-options", "nosniff")
   return new Response(res.body, { status: res.status, headers })
}
