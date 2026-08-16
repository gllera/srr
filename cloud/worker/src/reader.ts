// The hosted reader's edge worker: one origin that both GATES the reader and
// SERVES it. Its whole surface is this fetch handler executing router.ts's
// classifyReader verdicts.
//
// **Why it serves the bundle instead of proxying one.** The reader used to be a
// static site on its own public origin with a gate in front of it — which meant
// the gate had a documented way around it: the same bytes answered, ungated, at
// the origin behind. Serving the bundle from the Worker's own ASSETS binding
// leaves no second address for the same content, which is the only form of
// "gated" that is true rather than aspirational.
//
// **What the gate does and does not buy.** The packs live on the CDN origin and
// are public there by the operator's explicit choice, and this bundle's bytes
// are a published release artifact. So this is an estate-consistency boundary —
// one identity across the estate's hosts, and a place to stand when something
// here does become private — NOT confidentiality over the articles. Anything
// that needs the latter has to start at the pack origin.
//
// Auth is OIDC against the estate's IdP (oidc.ts) plus this worker's own
// session cookie (session.ts). It is a confidential client: it holds a secret,
// exchanges the code server-side once, and then answers from its own cookie.
import { beginLogin, handleCallback, logout } from "./oidc"
import { getSession } from "./session"
import { classifyReader, type ReaderRoute } from "./router"
import { isNavigation, missingConfig, notFound, serveShellAsset, serveShellIndex } from "./shell"

export interface ReaderEnv {
   ASSETS: Fetcher
   // The issuer to pin; every endpoint is read from the document beneath it.
   OIDC_ISSUER: string
   OIDC_CLIENT_ID: string
   OIDC_CLIENT_SECRET: string
   SESSION_HMAC_SECRET: string
}

// Anonymous → the login (navigations) or a 401 (everything else). The shell
// index is the only gated route, so the 401 branch answers a programmatic fetch
// of index.html and nothing a browser does on its own.
//
// `next` is a same-origin PATH, validated again on the way back out (oidc.ts's
// safeNext), never the absolute URL a cross-origin gate would have needed.
function deny(request: Request, url: URL): Response {
   if (!isNavigation(request)) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), {
         status: 401,
         headers: { "content-type": "application/json", "cache-control": "no-store" },
      })
   }
   const login = new URL("/auth/login", url.origin)
   login.searchParams.set("next", url.pathname + url.search)
   return new Response(null, {
      status: 302,
      headers: { location: login.toString(), "cache-control": "no-store" },
   })
}

export default {
   async fetch(request: Request, env: ReaderEnv): Promise<Response> {
      const url = new URL(request.url)
      const route = classifyReader(url.pathname)

      // GET/HEAD everywhere; POST only on logout, which is the one route a form
      // may reach. Matched by METHOD as well as path so nothing else can be
      // POSTed at.
      const method = request.method === "HEAD" ? "GET" : request.method
      if (method !== "GET" && !(method === "POST" && route.kind === "logout")) {
         const allow = route.kind === "logout" ? "GET, POST" : "GET"
         return new Response("method not allowed", { status: 405, headers: { allow } })
      }

      const missing = missingConfig(env)
      if (missing.length > 0) {
         console.log(`reader worker is misconfigured — unset: ${missing.join(", ")}`)
         return new Response("misconfigured", { status: 500, headers: { "cache-control": "no-store" } })
      }

      // The sign-in legs reach the IdP, so they can fail for reasons that are
      // nobody's fault and nothing's bug: discovery unreachable, JWKS 503, a
      // network blip. Unhandled, that is an exception out of the fetch handler —
      // the runtime's bare 500, no log line, and a visitor who cannot tell it
      // from a broken deployment. 503 says "try again" and means it.
      let res: Response
      try {
         res = await dispatch(request, env, url, route)
      } catch (e) {
         console.log(`reader worker: ${url.pathname} failed: ${e instanceof Error ? e.message : String(e)}`)
         res = new Response("temporarily unavailable", {
            status: 503,
            headers: { "cache-control": "no-store", "retry-after": "30" },
         })
      }
      // HEAD: same logic, body stripped.
      return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res
   },
} satisfies ExportedHandler<ReaderEnv>

async function dispatch(request: Request, env: ReaderEnv, url: URL, route: ReaderRoute): Promise<Response> {
   switch (route.kind) {
      case "login":
         return beginLogin(request, env)
      case "callback":
         return handleCallback(request, env)
      case "logout":
         return logout(request, env)
      case "shell-asset":
         // Deliberately UNAUTHENTICATED, and the service worker is the reason it
         // has to be: the browser fetches `sw.<hash>.js` WITHOUT the session
         // cookie, and the SW spec forbids registering a script served behind a
         // redirect — so gating it does not fail loudly, it silently leaves the
         // reader running with no service worker at all (a real outage,
         // 2026-07-29). The rest of the bundle rides the same rule rather than a
         // one-name exception, because they are the same published bytes and
         // because the manifest's icons are fetched credential-less too.
         return serveShellAsset(request, env, route.name)
      case "shell-index": {
         const session = await getSession(request, env)
         if (!session) return deny(request, url)
         return serveShellIndex(request, env)
      }
      case "none":
         return notFound()
   }
}
