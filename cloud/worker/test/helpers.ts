// The shapes every suite needs: a session the worker will accept, and the two
// request kinds the gate branches on.
import { env } from "cloudflare:test"
import { SESSION_COOKIE, mintSession, type SessionConfig } from "../src/session"

// Test-only session MINTER. Not a forger: it calls the very function the
// worker's own callback calls (session.ts mintSession), so a suite cannot pass
// against a token shape the worker has stopped issuing — which is exactly what
// a hand-rolled signer next to the verifier is for.
//
// `sub` is derived from the address rather than fixed, so two identities in one
// test are two subjects. Nothing in the worker reads it — the roster keys on
// email — but a shared sub across tenants would be a misleading fixture.
//
// The signing config DEFAULTS to the pool's rather than capturing it, so a
// suite calling the reader worker with its own env can mint against that one.
export const sessCookie = async (email: string, cfg: SessionConfig = env) =>
   `${SESSION_COOKIE}=${await mintSession(cfg, { sub: `sub-${email}`, email })}`

// A browser navigation (Sec-Fetch-Mode: navigate) vs a programmatic fetch —
// the distinction deny() branches on, so every gate case needs both.
//
// `redirect: "manual"` throughout: SELF.fetch would otherwise FOLLOW the login
// redirect and the assertion would land on the wrong response. It is inert for
// the suites that call a worker's fetch() directly.
export const nav = (extra: Record<string, string> = {}) => ({
   headers: { "sec-fetch-mode": "navigate", accept: "text/html", ...extra },
   redirect: "manual" as const,
})

export const api = (extra: Record<string, string> = {}) => ({
   headers: { ...extra },
   redirect: "manual" as const,
})

/** The bundle's real hashed JS name, discovered from the shell it was built with. */
export const bundleJs = (html: string): string => {
   const m = html.match(/frontend\.[0-9a-f]+\.js/)
   if (!m) throw new Error("no frontend.<hash>.js referenced by index.html")
   return m[0]
}

/**
 * Every file the shipped shell actually asks for — the inventory both workers'
 * asset suites grade `SHELL_ASSET_RE` against.
 *
 * Parcel MINIFIES index.html, so attribute values arrive UNQUOTED (`src=x.js`,
 * not `src="x.js"`). A quoted-only sweep matched nothing at all and the suite
 * still passed on the webmanifest's icons alone — i.e. the JS bundle, the CSS,
 * the touch icon and the service worker could each have fallen out of the
 * grammar with the net still green, which is exactly the blank-page regression
 * it exists to catch. Quotes are optional here for that reason.
 *
 * The service worker is referenced ONLY from the `<script type=importmap>`
 * values, never an attribute, so it needs its own pass or it is never swept.
 */
export function shellRefs(html: string, manifest: { icons?: { src: string }[] }): Set<string> {
   const strip = (s: string) => s.replace(/^\.?\//, "")
   const refs = new Set<string>()
   const ATTR = /(?:href|src)=(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/g
   for (const m of html.matchAll(ATTR)) {
      const v = strip(m[1] ?? m[2] ?? m[3])
      if (/\.(?:js|css|png|svg|webmanifest)$/.test(v)) refs.add(v)
   }
   // The importmap: `{"imports":{"6LsTv":"./sw.<hash>.js"}}`.
   const imports = html.match(/<script[^>]*type=["']?importmap["']?[^>]*>([^<]*)</i)
   if (imports) {
      for (const v of Object.values(JSON.parse(imports[1]).imports as Record<string, string>)) {
         refs.add(strip(v))
      }
   }
   for (const i of manifest.icons ?? []) refs.add(strip(i.src))

   // A sweep that finds nothing is a sweep that cannot fail. The shell always
   // loads at least its own JS and its service worker.
   if (!refs.has(bundleJs(html))) throw new Error(`shellRefs missed the JS bundle: ${[...refs].join(", ")}`)
   if (![...refs].some((r) => /^sw\./.test(r))) throw new Error(`shellRefs missed the service worker: ${[...refs]}`)
   return refs
}
