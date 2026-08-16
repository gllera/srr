// The shell-serving pieces both workers share — the reader bundle's response
// headers, the deployment-config guard, and the request-shape helpers. One
// copy, so a cache rule or a header tweak lands on both origins or on neither.
import type { OidcConfig } from "./oidc"
import type { SessionConfig } from "./session"

export interface ShellEnv {
   ASSETS: Fetcher
}

// Mirror of frontend/_headers (the reader's CSP). index.html carries the same
// policy as a <meta> fallback, but the header is the real layer here.
export const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'"

export const notFound = () => new Response("not found", { status: 404 })

export const isNavigation = (request: Request) =>
   request.headers.get("sec-fetch-mode") === "navigate" || (request.headers.get("accept") || "").includes("text/html")

// Every one of these is operator config supplied out of band (`wrangler secret
// put`), so an unset one is a DEPLOYMENT mistake and not a request the user got
// wrong. Say so with a 500: falling through would send a visitor to a login that
// cannot complete, and they would meet a redirect loop instead of a cause.
export function missingConfig(env: OidcConfig & SessionConfig): string[] {
   const need = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_HMAC_SECRET"] as const
   return need.filter((k) => !env[k])
}

// The shell gets nosniff but NEVER index.ts's userContent(): its `sandbox`
// would drop the reader into an opaque origin with scripting off — the app
// would simply not run. Two different jobs sharing one header name is exactly
// the trap, so the shell sets its own and the store keeps its own.
export async function serveShellIndex(request: Request, env: ShellEnv): Promise<Response> {
   const res = await env.ASSETS.fetch(new URL("/index.html", request.url))
   const headers = new Headers(res.headers)
   headers.set("cache-control", "no-cache")
   headers.set("content-security-policy", CSP)
   headers.set("x-content-type-options", "nosniff")
   return new Response(res.body, { status: res.status, headers })
}

export async function serveShellAsset(request: Request, env: ShellEnv, name: string): Promise<Response> {
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
