// The TEST environment's roster and OIDC config — deliberately synthetic, and
// deliberately in one place.
//
// One place because it has two readers that cannot see each other's state:
// vitest.config.ts BINDS these into the worker under test, and the suites ASSERT
// against them. Mutating `env` from a test does not reach `SELF.fetch` (the
// worker runs with the pool's environment), so declaring the roster inside a
// `beforeAll` silently authorizes nobody.
//
// Synthetic because the real roster and IdP are deployment config
// (.dev.vars / wrangler.toml, both gitignored): a suite asserting against those
// would pass or fail depending on whose machine ran it.
//
// The issuer is never DIALLED by the suites that use this file — they exercise
// the gate, which answers out of the session cookie alone. It is bound so the
// worker's missing-config check passes; oidc.test.ts stubs a real one.
export const TEST_OIDC = {
   OIDC_ISSUER: "https://idp.example.com/t/tenant",
   OIDC_CLIENT_ID: "srr-cloud",
   OIDC_CLIENT_SECRET: "test-client-secret",
   SESSION_HMAC_SECRET: "test-hmac-secret",
}

export const TEST_T1_EMAIL = "owner@example.com"
export const TEST_T2_EMAIL = "second@example.com"
// Present but deactivated: pins revocation ⇒ 403, same as an unknown email.
export const TEST_REVOKED_EMAIL = "revoked@example.com"

export const TEST_ROSTER: Record<string, { uid: string; active: boolean }> = {
   [TEST_T1_EMAIL]: { uid: "t1", active: true },
   [TEST_T2_EMAIL]: { uid: "t2", active: true },
   [TEST_REVOKED_EMAIL]: { uid: "t9", active: false },
}
