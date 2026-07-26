// The localStorage/sessionStorage key-name hub, side-effect-free (no imports).
//
// Multi-store namespacing (docs/MULTI-STORE-SPEC.md §4.1): the PER-STORE keys
// are functions of a mount id (`mid`). The home store's id is the literal "0",
// which maps back to the BARE legacy key name — so a single-store user's
// srr-seen / srr-saved / srr-pins / srr-seen-ts / srr-profile-ts are unchanged
// and there is no migration. Every other mount's keys are suffixed `@<mid>`
// (`srr-seen@s3f9a1c22`), keeping each store's device state strictly separate.
//
// The GLOBAL keys (below) are one-per-device settings that are NOT a property of
// any single store, so they carry no mid. `srr-hash` and `srr-reload-guard`
// moved here from raw string literals in app.ts / data.ts (finding ENG5): a
// literal is by definition un-namespaced, which is invisible under one store and
// silently wrong under N — every persisted key must live here.

export const HOME_MID = "0"

// The home store keeps the bare legacy name; every other mount is suffixed.
const q = (base: string, mid: string): string => (mid === HOME_MID ? base : `${base}@${mid}`)

// Per-store keys (mid-qualified).
export const seenKey = (mid: string): string => q("srr-seen", mid)
export const seenTsKey = (mid: string): string => q("srr-seen-ts", mid)
export const savedKey = (mid: string): string => q("srr-saved", mid)
// The ★ Saved set's per-key ordering map (RDR18) — the saved cousin of
// srr-seen-ts, stamped by saved.ts beside every srr-saved write. A chron is
// stamped whether it was SAVED or UN-SAVED, so an un-save leaves a tombstone
// the merge can order against a peer's older save. Per-store for the same
// reason srr-saved is: chronIdx is only unique WITHIN a mount.
export const savedTsKey = (mid: string): string => q("srr-saved-ts", mid)
export const pinsKey = (mid: string): string => q("srr-pins", mid)
export const profileTsKey = (mid: string): string => q("srr-profile-ts", mid)
// RDR16 podcast mini-player: the persisted episode (chron, index, playback
// position, …). Per-store because chronIdx is only unique WITHIN a mount
// (S38 multi-store) — a playback position keyed on chron alone would be
// ambiguous across two mounts that both have a chron 42.
export const playerStateKey = (mid: string): string => q("srr-player", mid)
// RDR9 picker favorites: the feed ids pinned into the filter picker's
// "★ Favorites" lane. Per-store for the same reason as the player state — a
// favorite IS a feed id, and feed ids are only unique WITHIN a mount (S38
// multi-store), so one shared list would cross-wire two stores' lanes (id 7 is
// a different feed in every store).
export const favoritesKey = (mid: string): string => q("srr-favorites", mid)

// Global keys (one per device, not a property of a store).
export const UNREAD_ONLY_KEY = "srr-unread-only"
export const IMG_PROXY_KEY = "srr-img-proxy"
export const SYNC_URL_KEY = "srr-sync-url"
// The device's one reading cursor (the surface hash). Global: the mount rides
// inside the hash's own token grammar, so the stored string is self-describing
// and a bare-token value already means the home store (§4.2). Moved here — ENG5.
export const HASH_KEY = "srr-hash"
// Guards the stale-tab self-heal reload. Global on purpose: it guards a GLOBAL
// action (location.reload()), so one flag is the correct scope (§4.2). Moved
// here — ENG5. sessionStorage, not localStorage.
export const RELOAD_GUARD_KEY = "srr-reload-guard"
// The mount table (JSON array of mount records). New for the multi-store work;
// consumed by S38's mounts module (§3.3).
export const MOUNTS_KEY = "srr-mounts"
// RDR16 podcast mini-player: the device's preferred playback rate. Global —
// a preferred speed is a device preference, not a property of any one store.
export const PLAYER_RATE_KEY = "srr-player-rate"
// The version of the SHAPE of this device's stored state (finding ENG6) — the
// boot gate and its migration ladder live in schema.ts. Global for the same
// reason as `srr-hash` and `srr-reload-guard` above: it is not a property of any
// one store's content but of the layout every key in this file describes, and a
// migration that renames or restructures a key crosses every mount in one pass.
// A per-mount version would also be self-referential — the `@<mid>` namespacing
// scheme is itself part of the shape a breaking change could move, so the
// version that says whether it moved must not be addressed through it.
export const SCHEMA_KEY = "srr-schema"
