// A StoreContext is the identity + fetch config of one mounted store. Before
// multi-store (S37) the reader was hard-wired to exactly one store through the
// module-level `PACK_BASE` singleton; the context makes that store one of N.
// The runtime STATE a store accumulates (its db.gz snapshot, resolved names,
// idx/data/meta caches, delta chain) hangs off the richer `Store` record in
// data.ts, which extends this — see data.ts. `mid` is the per-store namespace
// for every device-state key (keys.ts): the home store's is the literal "0",
// which keys.ts maps back to the bare legacy key names so a single-store user's
// srr-seen/srr-saved/srr-pins are unchanged (docs/MULTI-STORE-SPEC.md §3.2, §4).
export interface StoreContext {
   mid: string // "0" for the home store — the namespace for every per-store key
   base: URL // the store root every pack key resolves against (was PACK_BASE)
   cred: RequestCredentials // "same-origin" for a public store, "include" for a credentialed mount
   role: "home" | "peer"
}

// The home store: the one the build points at (SRR_CDN_URL → base), the one that
// always exists and cannot be removed (docs/MULTI-STORE-SPEC.md §3.2). The
// SRR_CDN_URL global is replaced with a string literal at build time (see
// parcel/transformer-define.js, resolved via parcel/resolve-cdn-url.js).
export const HOME: StoreContext = {
   mid: "0",
   base: new URL(SRR_CDN_URL, window.location.href),
   cred: "same-origin",
   role: "home",
}

// PACK_BASE is the home store's base — the URL the home store's keys resolve
// against. It stays exported as the neutral default for the content-URL bounds
// check in fmt.ts (whose functions now take the article's own store base as an
// argument, defaulting to this for the single-store/test path). Computed once at
// module load; neither data.ts (pack addressing) nor fmt.ts is a neutral owner
// (fmt.ts is the sanitizer's home; importing data.ts triggers its eager db.gz
// fetch), which is why the shared base lives here.
export const PACK_BASE = HOME.base

// The build's version label (the settings-menu status footer + anything else that wants to
// name the running build): transformer-define.js inlines SRR_VERSION from the
// $VERSION env — the tag in release.yml's build jobs — else "dev". Exported
// from base.ts because this is the one module the define transformer already
// covers (.parcelrc lists transformers per file).
export const VERSION = SRR_VERSION
