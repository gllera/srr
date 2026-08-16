// SRR Cloud phase-1 edge worker: the whole product surface is this fetch
// handler executing router.ts verdicts. The shell is served virtually under
// each tenant's prefix so the reader's relative PACK_BASE and SW scope land
// per-tenant.
//
// Auth is the same two halves it has always been, with the first half replaced.
// AUTHENTICATION is OIDC against the estate's IdP (oidc.ts) plus this worker's
// own session cookie (session.ts) — the reader worker's machinery, shared
// rather than re-derived. AUTHORIZATION is still roster.ts deciding which
// tenant an authenticated email owns.
//
// What it replaced: a verify-only port of a login app's shared HMAC cookie.
// That scheme ended estate-wide when the IdP's session took the `__Host-`
// prefix — a cookie no consumer can read is a cookie no consumer can verify —
// and this was the last reader of it left anywhere.
import { beginLogin, handleCallback, logout } from "./oidc"
import { getSession } from "./session"
import { rosterLookup, type RosterEntry } from "./roster"
import { classify, type Route } from "./router"

export interface Env {
   ASSETS: Fetcher
   STORE: R2Bucket
   // The issuer to pin; every endpoint is read from the document beneath it.
   OIDC_ISSUER: string
   OIDC_CLIENT_ID: string
   OIDC_CLIENT_SECRET: string
   SESSION_HMAC_SECRET: string
   // email → {uid, active} as JSON; see roster.ts for why it is config, not code.
   ROSTER: string
}

// Mirror of frontend/_headers (the Pages deploy's CSP); index.html also
// carries it as a <meta> fallback, but the header is the real layer here.
const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'"

// no-store because the 401 branch of deny() is one of these: an auth verdict
// that a shared cache could hand to the next visitor is not a verdict.
const json = (status: number, error: string) =>
   new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
   })

const notFound = () => new Response("not found", { status: 404 })

// Store and sync bytes are FEED-SOURCED or client-written, and here they are
// served from the app's OWN origin under the tenant prefix — the one assumption
// backend/assets.go's inert-type rule (sniffedMediaType) explicitly does NOT
// make: it refuses to adopt a sniffed text/html because "the asset store is a
// separate origin a reader loads media from". True of the Pages/CDN deploy,
// false of this Worker. Restore the guarantee at the edge, on every user byte:
//
//   nosniff — no MIME confusion promoting a declared type into a document;
//   sandbox — a NAVIGATED object lands in an opaque origin with scripting off,
//             so an image/svg+xml a feed talked the asset pipeline into storing
//             reaches neither this origin's cookies nor its store.
//
// Both are inert for SUBRESOURCE loads (<img>, <audio>, fetch): CSP sandbox is
// only enforced when the response is a document, so the reader is unaffected.
// Stamped on the way OUT (dispatch), so a cache hit, a fresh R2 read, a 304 and
// an error body all carry them without each return site remembering to.
function userContent(res: Response): Response {
   const headers = new Headers(res.headers)
   headers.set("x-content-type-options", "nosniff")
   headers.set("content-security-policy", "sandbox")
   return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

const isNavigation = (request: Request) =>
   request.headers.get("sec-fetch-mode") === "navigate" || (request.headers.get("accept") || "").includes("text/html")

// Every one of these is operator config supplied out of band (`wrangler secret
// put`), so an unset one is a DEPLOYMENT mistake and not a request the user got
// wrong. Say so with a 500: falling through would send a visitor to a login that
// cannot complete, and they would meet a redirect loop instead of a cause.
function missingConfig(env: Env): string[] {
   const need = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_HMAC_SECRET"] as const
   return need.filter((k) => !env[k])
}

// Anonymous → login redirect (navigations) or 401 (fetches); authenticated
// but unauthorized → 403. The one deny path every gated route shares.
//
// The login is THIS origin's own now, so `next` is a same-origin PATH rather
// than the absolute URL a cross-origin login app had to be handed — and oidc.ts
// validates it again on the way back out (safeNext) instead of trusting the
// cookie it round-tripped through.
function deny(request: Request, url: URL, authenticated: boolean): Response {
   if (authenticated) return json(403, "forbidden")
   if (isNavigation(request)) {
      const login = new URL("/auth/login", url.origin)
      login.searchParams.set("next", url.pathname + url.search)
      return new Response(null, {
         status: 302,
         headers: { location: login.toString(), "cache-control": "no-store" },
      })
   }
   return json(401, "auth required")
}

// The shell gets nosniff but NEVER userContent(): its `sandbox` would drop the
// reader into an opaque origin with scripting off — the app would simply not
// run. Two different jobs sharing one header name is exactly the trap, so the
// shell sets its own and the store keeps its own.
async function serveShellIndex(request: Request, env: Env): Promise<Response> {
   const res = await env.ASSETS.fetch(new URL("/index.html", request.url))
   const headers = new Headers(res.headers)
   headers.set("cache-control", "no-cache")
   headers.set("content-security-policy", CSP)
   headers.set("x-content-type-options", "nosniff")
   return new Response(res.body, { status: res.status, headers })
}

async function serveShellAsset(request: Request, env: Env, name: string): Promise<Response> {
   const res = await env.ASSETS.fetch(new URL(`/${name}`, request.url))
   if (!res.ok) return res
   const headers = new Headers(res.headers)
   // Content-hashed names are immutable; the webmanifest is the one stable name.
   headers.set("cache-control", name === "manifest.webmanifest" ? "no-cache" : "public, max-age=31536000, immutable")
   // Safe only because these are OUR bundle's bytes under correct types: nosniff
   // BLOCKS a script served as anything but a JS MIME type (and a stylesheet as
   // anything but text/css), so the asset test pins the type alongside it.
   headers.set("x-content-type-options", "nosniff")
   return new Response(res.body, { status: res.status, headers })
}

// Serve a store object from R2 with its stored metadata (the engine stamps
// Cache-Control/Content-Type at Put — cacheControlForKey). Immutable objects
// are edge-cached POST-auth via caches.default: the URL embeds the uid and
// every immutable name is write-once, so a cache hit can never cross tenants
// or serve stale bytes. Ranged and conditional requests bypass the cache.
async function serveStore(
   request: Request,
   env: Env,
   ctx: ExecutionContext,
   uid: string,
   key: string,
): Promise<Response> {
   const objectKey = `u/${uid}/${key}`
   const ranged = request.headers.has("range")
   // Two different kinds of condition, and onlyIf below forwards BOTH: cache
   // validators (the conditional GET the reader itself sends) and strong
   // preconditions (If-Match / If-Unmodified-Since). Either one has to bypass
   // the edge cache — answering a precondition out of a cached 200 ignores it —
   // and they fail with different statuses.
   const validator = request.headers.has("if-none-match") || request.headers.has("if-modified-since")
   const precondition = request.headers.has("if-match") || request.headers.has("if-unmodified-since")
   const conditional = validator || precondition

   if (!ranged && !conditional) {
      try {
         const hit = await caches.default.match(request.url)
         if (hit) return hit
      } catch {
         // cache API is best-effort (absent in some local modes)
      }
   }

   let obj: R2Object | R2ObjectBody | null
   try {
      obj = await env.STORE.get(objectKey, {
         range: ranged ? request.headers : undefined,
         onlyIf: request.headers,
      })
   } catch {
      // R2 throws on an unsatisfiable range.
      return ranged ? new Response("range not satisfiable", { status: 416 }) : json(500, "store error")
   }
   if (!obj) return notFound()

   const headers = new Headers()
   obj.writeHttpMetadata(headers)
   headers.set("etag", obj.httpEtag)
   headers.set("accept-ranges", "bytes")

   // R2 answers ANY failed condition with a bodyless object and never says which
   // one failed. Only a strong precondition was sent ⇒ 412; anything carrying a
   // cache validator ⇒ 304. With both present the two are genuinely
   // indistinguishable here (RFC 9110 evaluates If-Match first, so a strict
   // reading would 412) — 304 is the benign answer, and no SRR client sends both.
   if (!("body" in obj) || !obj.body) {
      return new Response(null, { status: precondition && !validator ? 412 : 304, headers })
   }

   let status = 200
   const r = obj.range
   // Gate on the REQUEST being ranged: some runtimes populate obj.range with
   // the full extent on a plain get, which must stay a 200.
   if (ranged && r) {
      let start: number
      let end: number
      if ("suffix" in r && r.suffix !== undefined) {
         start = obj.size - r.suffix
         end = obj.size - 1
      } else {
         const rr = r as { offset?: number; length?: number }
         start = rr.offset ?? 0
         end = rr.length !== undefined ? start + rr.length - 1 : obj.size - 1
      }
      headers.set("content-range", `bytes ${start}-${end}/${obj.size}`)
      status = 206
   }

   const res = new Response(obj.body, { status, headers })
   if (status === 200 && (headers.get("cache-control") || "").includes("immutable")) {
      try {
         ctx.waitUntil(caches.default.put(request.url, res.clone()))
      } catch {
         // best-effort, same as match above
      }
   }
   return res
}

// The ONE write path in the product: the reader's cross-device sync blob
// (sync.ts GET-or-404 / PUT contract). Size-capped; stored no-cache.
const SYNC_MAX_BYTES = 256 * 1024

async function serveSync(request: Request, env: Env, uid: string): Promise<Response> {
   const key = `u/${uid}/sync.json`
   if (request.method === "PUT") {
      // Cap BEFORE buffering: arrayBuffer() makes the whole body resident in the
      // isolate, so an oversized PUT was paid for in full and only then refused.
      // Content-Length is a hint, not the authority — absent under chunked
      // encoding and a client may simply lie — so the post-buffer check stays.
      const declared = Number(request.headers.get("content-length"))
      if (Number.isFinite(declared) && declared > SYNC_MAX_BYTES) return json(413, "sync blob too large")
      const body = await request.arrayBuffer()
      if (body.byteLength > SYNC_MAX_BYTES) return json(413, "sync blob too large")
      await env.STORE.put(key, body, {
         httpMetadata: { contentType: "application/json", cacheControl: "no-cache" },
      })
      return new Response(null, { status: 204 })
   }
   const obj = await env.STORE.get(key)
   if (!obj) return notFound()
   const headers = new Headers()
   obj.writeHttpMetadata(headers)
   headers.set("cache-control", "no-cache")
   return new Response(obj.body, { status: 200, headers })
}

export default {
   async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url)
      const route = classify(url.pathname)

      // Method gate: GET/HEAD everywhere, PUT only on sync, POST only on logout.
      // Matched by METHOD as well as path, so nothing else can be written to.
      const method = request.method === "HEAD" ? "GET" : request.method
      const writable = (method === "PUT" && route.kind === "sync") || (method === "POST" && route.kind === "logout")
      if (method !== "GET" && !writable) {
         return new Response("method not allowed", { status: 405 })
      }

      const missing = missingConfig(env)
      if (missing.length > 0) {
         console.log(`cloud worker is misconfigured — unset: ${missing.join(", ")}`)
         return new Response("misconfigured", { status: 500, headers: { "cache-control": "no-store" } })
      }

      const session = await getSession(request, env)
      // A session with no email claim is authorized for NOTHING: this roster
      // keys on the address, so there is no row such an identity could match.
      // handleCallback refuses a token without one, so this is a guard on the
      // type rather than a reachable state — and it fails closed either way.
      const entry: RosterEntry | null = session?.email ? rosterLookup(env.ROSTER, session.email) : null
      const authorizedFor = (uid: string) => entry !== null && entry.uid === uid

      // The sign-in legs reach the IdP, so they can fail for reasons that are
      // nobody's fault and nothing's bug: discovery unreachable, JWKS 503, a
      // network blip. Unhandled, that is an exception out of the fetch handler —
      // the runtime's bare 500, no log line, and a visitor who cannot tell it
      // from a broken deployment. 503 says "try again" and means it.
      let res: Response
      try {
         res = await dispatch(request, env, ctx, route, url, session !== null, entry, authorizedFor)
      } catch (e) {
         console.log(`cloud worker: ${url.pathname} failed: ${e instanceof Error ? e.message : String(e)}`)
         res = new Response("temporarily unavailable", {
            status: 503,
            headers: { "cache-control": "no-store", "retry-after": "30" },
         })
      }
      // HEAD: same logic, body stripped (R2/asset bodies are cheap at this scale).
      return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res
   },
} satisfies ExportedHandler<Env>

async function dispatch(
   request: Request,
   env: Env,
   ctx: ExecutionContext,
   route: Route,
   url: URL,
   authenticated: boolean,
   entry: RosterEntry | null,
   authorizedFor: (uid: string) => boolean,
): Promise<Response> {
   switch (route.kind) {
      case "login":
         return beginLogin(request, env)
      case "callback":
         return handleCallback(request, env)
      case "logout":
         return logout(request, env)
      case "root":
         if (entry) return Response.redirect(new URL(`/u/${entry.uid}/`, url).toString(), 302)
         return deny(request, url, authenticated)
      case "redirect-slash":
         return Response.redirect(new URL(`${url.pathname}/`, url).toString(), 301)
      case "shell-index":
         if (!authorizedFor(route.uid)) return deny(request, url, authenticated)
         return serveShellIndex(request, env)
      case "shell-asset":
         // Deliberately UNAUTHENTICATED: public bytes, and the SW script fetch
         // carries no cookie (a real hosted-reader outage, 2026-07-29) — gating
         // it silently breaks SW registration.
         return serveShellAsset(request, env, route.name)
      case "sync":
         if (!authorizedFor(route.uid)) return deny(request, url, authenticated)
         return userContent(await serveSync(request, env, route.uid))
      case "denied":
         // Backend-only object classes 404 even for the owner (store-visibility split).
         return notFound()
      case "store":
         if (!authorizedFor(route.uid)) return deny(request, url, authenticated)
         return userContent(await serveStore(request, env, ctx, route.uid, route.key))
      case "none":
         return notFound()
   }
}
