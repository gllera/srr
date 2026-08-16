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
import { rosterUid } from "./roster"
import { classify, policy, type Route } from "./router"
import { denyAnonymous, jsonNoStore, notFound, runWorker, serveShellAsset, serveShellIndex } from "./shell"

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

// Anonymous → login redirect (navigations) or 401 (fetches), which is the half
// both workers share; authenticated but unauthorized → 403, which is this
// worker's alone because it is the only one with a roster to fail.
const deny = (request: Request, url: URL, authenticated: boolean): Response =>
   authenticated ? jsonNoStore(403, "forbidden") : denyAnonymous(request, url, "auth required")

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
         // Only when there is one to evaluate: handing R2 the whole header set
         // on an unconditional GET — the overwhelming majority of pack fetches —
         // makes it marshal and re-extract four headers that are not there.
         onlyIf: conditional ? request.headers : undefined,
      })
   } catch {
      // R2 throws on an unsatisfiable range.
      return ranged ? new Response("range not satisfiable", { status: 416 }) : jsonNoStore(500, "store error")
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
      headers.set("content-range", contentRange(r, obj.size))
      status = 206
   }

   const res = new Response(obj.body, { status, headers })
   // NOT on HEAD: clone() tees the stream, so the cache put would pull the whole
   // object out of R2 and write it — a full object transfer triggered by a
   // request whose body is discarded on the way out.
   if (status === 200 && request.method !== "HEAD" && (headers.get("cache-control") || "").includes("immutable")) {
      try {
         ctx.waitUntil(caches.default.put(request.url, res.clone()))
      } catch {
         // best-effort, same as match above
      }
   }
   return res
}

// R2 reports a satisfied range in one of two shapes. Pure arithmetic, lifted
// out of the I/O around it so it can be read — and tested — on its own.
function contentRange(r: R2Range, size: number): string {
   if ("suffix" in r && r.suffix !== undefined) return `bytes ${size - r.suffix}-${size - 1}/${size}`
   const { offset = 0, length } = r as { offset?: number; length?: number }
   return `bytes ${offset}-${length !== undefined ? offset + length - 1 : size - 1}/${size}`
}

// The ONE write path in the product: the reader's cross-device sync blob
// (sync.ts GET-or-404 / PUT contract).
//
// Both numbers below MIRROR backend/serve_sync.go, which serves the same
// contract to the same reader on a self-hosted `srr serve`. They had drifted —
// a 256 KiB cap here against `maxSyncBody`'s 1 MiB there, so a profile that
// round-tripped self-hosted 413'd on cloud; and `no-cache` here against the
// `no-store` that file argues for, which is the one that matters: the blob is
// mutable device state and a proxy sits between reader and origin in every real
// deployment, so permitting storage at all is the hole.
const SYNC_MAX_BYTES = 1 << 20

async function serveSync(request: Request, env: Env, uid: string): Promise<Response> {
   const key = `u/${uid}/sync.json`
   if (request.method === "PUT") {
      // Cap BEFORE buffering: arrayBuffer() makes the whole body resident in the
      // isolate, so an oversized PUT was paid for in full and only then refused.
      // Content-Length is a hint, not the authority — absent under chunked
      // encoding and a client may simply lie — so the post-buffer check stays.
      const declared = Number(request.headers.get("content-length"))
      if (Number.isFinite(declared) && declared > SYNC_MAX_BYTES) return jsonNoStore(413, "sync blob too large")
      const body = await request.arrayBuffer()
      if (body.byteLength > SYNC_MAX_BYTES) return jsonNoStore(413, "sync blob too large")
      await env.STORE.put(key, body, {
         httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      })
      return new Response(null, { status: 204 })
   }
   const obj = await env.STORE.get(key)
   if (!obj) return notFound()
   const headers = new Headers()
   obj.writeHttpMetadata(headers)
   headers.set("cache-control", "no-store")
   return new Response(obj.body, { status: 200, headers })
}

export default {
   async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url)
      const route = classify(url.pathname)
      // Access, methods and egress guards all come off the route's policy, so
      // the method gate and the 405's Allow header read the same array and the
      // gate below cannot be forgotten for a route added later.
      const p = policy(route)
      return runWorker({
         name: "cloud worker",
         request,
         url,
         env,
         methods: p.methods,
         dispatch: () => dispatch(request, env, ctx, route, url, p),
      })
   },
} satisfies ExportedHandler<Env>

async function dispatch(
   request: Request,
   env: Env,
   ctx: ExecutionContext,
   route: Route,
   url: URL,
   p: ReturnType<typeof policy>,
): Promise<Response> {
   // AUTHORIZATION, enforced once. A gated route needs an active roster row, and
   // one that names a tenant needs THAT row. Nothing below re-asks.
   //
   // The session is read only when the policy needs it — the shell's assets and
   // every 404 are public, and they are the bulk of a cold load, so verifying an
   // HMAC for a result nobody reads was work done on the wrong requests.
   let tenant: string | null = null
   if (p.gate !== "public") {
      const session = await getSession(request, env)
      // A session with no email claim is authorized for NOTHING: this roster
      // keys on the address, so there is no row such an identity could match.
      // handleCallback refuses a token without one, so this is a guard on the
      // type rather than a reachable state — and it fails closed either way.
      tenant = session?.email ? rosterUid(env.ROSTER, session.email) : null
      if (tenant === null) return deny(request, url, session !== null)
      if ("uid" in route && route.uid !== tenant) return deny(request, url, true)
   }

   const res = await handle(request, env, ctx, route, url, tenant)
   // Stamped on the way OUT, once — so a cache hit, a fresh R2 read, a 304 and
   // an error body all carry the guards without each return site remembering to,
   // and a future user-byte route inherits them by answering policy() rather
   // than by finding this line.
   return p.userBytes ? userContent(res) : res
}

async function handle(
   request: Request,
   env: Env,
   ctx: ExecutionContext,
   route: Route,
   url: URL,
   tenant: string | null,
): Promise<Response> {
   switch (route.kind) {
      case "login":
         return beginLogin(request, env)
      case "callback":
         return handleCallback(request, env)
      case "logout":
         return logout(request, env)
      case "root":
         // policy() gates this route on `tenant`, so it is non-null here.
         return Response.redirect(new URL(`/u/${tenant!}/`, url).toString(), 302)
      case "redirect-slash":
         return Response.redirect(new URL(`${url.pathname}/`, url).toString(), 301)
      case "shell-index":
         return serveShellIndex(request, env)
      case "shell-asset":
         return serveShellAsset(request, env, route.name)
      case "sync":
         return serveSync(request, env, route.uid)
      case "denied":
         // Backend-only object classes 404 even for the owner (store-visibility split).
         return notFound()
      case "store":
         return serveStore(request, env, ctx, route.uid, route.key)
      case "none":
         return notFound()
   }
}
