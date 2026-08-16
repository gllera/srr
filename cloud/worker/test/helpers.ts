// Test-only session MINTER. Not a forger any more: it calls the very function
// the worker's own callback calls (session.ts mintSession), so a suite cannot
// pass against a token shape the worker has stopped issuing — which is exactly
// what a hand-rolled signer next to the verifier is for.
import { env } from "cloudflare:test"
import { SESSION_COOKIE, mintSession } from "../src/session"

// `sub` is derived from the address rather than fixed, so two identities in one
// test are two subjects. Nothing in the worker reads it — the roster keys on
// email — but a shared sub across tenants would be a misleading fixture.
export const sessCookie = async (email: string) =>
   `${SESSION_COOKIE}=${await mintSession(env, { sub: `sub-${email}`, email })}`
