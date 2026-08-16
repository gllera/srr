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
import { classifyReader, policyReader, type ReaderGate, type ReaderRoute } from "./router"
import { AUTH_CONFIG, denyAnonymous, notFound, runWorker, serveShellAsset, serveShellIndex } from "./shell"

export interface ReaderEnv {
   ASSETS: Fetcher
   // The issuer to pin; every endpoint is read from the document beneath it.
   OIDC_ISSUER: string
   OIDC_CLIENT_ID: string
   OIDC_CLIENT_SECRET: string
   SESSION_HMAC_SECRET: string
}

export default {
   async fetch(request: Request, env: ReaderEnv): Promise<Response> {
      const url = new URL(request.url)
      const route = classifyReader(url.pathname)
      const { gate, methods } = policyReader(route)
      return runWorker({
         name: "reader worker",
         request,
         url,
         env,
         // The sign-in four and nothing else: this worker has no roster.
         needed: AUTH_CONFIG,
         methods,
         dispatch: () => dispatch(request, env, url, route, gate),
      })
   },
} satisfies ExportedHandler<ReaderEnv>

async function dispatch(
   request: Request,
   env: ReaderEnv,
   url: URL,
   route: ReaderRoute,
   gate: ReaderGate,
): Promise<Response> {
   // Enforced ONCE, from the route's policy rather than from each case
   // remembering to ask. The shell index is the only gated route today; the
   // point is that the next one cannot be added without answering the question.
   //
   // Everything else is deliberately UNAUTHENTICATED, and the service worker is
   // why it has to be: the browser fetches `sw.<hash>.js` WITHOUT the session
   // cookie, and the SW spec forbids registering a script served behind a
   // redirect — so gating it does not fail loudly, it silently leaves the reader
   // running with no service worker at all (a real outage, 2026-07-29). The rest
   // of the bundle rides the same rule rather than a one-name exception, because
   // they are the same published bytes and because the manifest's icons are
   // fetched credential-less too.
   if (gate !== "public" && !(await getSession(request, env))) {
      return denyAnonymous(request, url)
   }

   switch (route.kind) {
      case "login":
         return beginLogin(request, env)
      case "callback":
         return handleCallback(request, env)
      case "logout":
         return logout(request, env)
      case "shell-asset":
         return serveShellAsset(request, env, route.name)
      case "shell-index":
         return serveShellIndex(request, env)
      case "none":
         return notFound()
   }
}
