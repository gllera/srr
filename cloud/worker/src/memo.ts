// One memo, three users: oidc.ts caches the discovery document and the JWKS,
// session.ts caches the imported HMAC key. All three are pure functions of a
// deployment value, so caching them for the life of the isolate saves the work
// on every warm request.
//
// It lives here because the EVICT-ON-REJECTION half is the subtle part and it
// was written out three times to get wrong independently: without it, one
// unreachable-IdP moment poisons the isolate for as long as it lives, and every
// later request in it fails on a network blip that has long since passed.

/**
 * Memoize an async result per key for the life of the isolate. A REJECTION
 * evicts itself, so a transient failure does not persist; a resolution is kept
 * forever. `.clear()` exists for tests that need to re-stub the source.
 *
 * KEYS MUST BE DEPLOYMENT-DERIVED. The map never evicts a success and has no
 * bound, so every caller today keys it on env (the issuer, the JWKS URI that
 * issuer's own document names, the HMAC secret) and holds exactly one entry per
 * isolate. Keying it on anything a client can vary makes it a memory leak, and
 * nothing here would fail to compile.
 */
export function memoAsync<T>(make: (key: string) => Promise<T>) {
   const cache = new Map<string, Promise<T>>()
   const get = (key: string): Promise<T> => {
      let hit = cache.get(key)
      if (hit === undefined) {
         hit = make(key).catch((e: unknown) => {
            cache.delete(key)
            throw e
         })
         cache.set(key, hit)
      }
      return hit
   }
   get.clear = () => cache.clear()
   return get
}
