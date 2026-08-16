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
