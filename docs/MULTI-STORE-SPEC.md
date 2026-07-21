# Multi-store mounting — design

**Status:** design, 2026-07-21 (S36). Implemented by **S38**; **S37** (the
`PACK_BASE` → store-context refactor) is its mechanical prerequisite and is
specified as a contract in §11.

**Rebased on the post-S33 boot contract.** Everything below addresses a store
through `root → (manifest) → listed names` (`docs/MANIFEST-SPEC.md` §4.5, §8.1),
never through legacy `db.gz` counters. Where the legacy shape still appears it
is *only* as an inbound compatibility surface for a mounted peer that lags
(§8.4) — never as the model.

---

## 1. What this is

Today the reader is hard-wired to exactly one store: `base.ts` computes
`PACK_BASE` once at module load from the build-time `SRR_CDN_URL`, and every
pack key, every device-state key and every service-worker cache entry implicitly
belongs to it.

Multi-store means: **the reader mounts N store roots at once, reads all of them,
and keeps their device state strictly separate.** Because a store is a pile of
immutable objects behind plain HTTP with a published grammar, a mounted store
needs no server, no API and no negotiation beyond fetching its root. That turns
the pack format into a **static, serverless federation protocol**: publishing a
store *is* publishing a feed anyone else's reader can mount, and a person can
split their own reading across a public store and a private one without running
two readers.

Three concrete uses drive the design:

1. **Public/private split** — a public store (the reading list is public, per
   `docs/STORE-VISIBILITY.md`) plus a private one behind Cloudflare Access, both
   in one reader.
2. **Federation** — mounting somebody else's store read-only.
3. **Dev/prod** — mounting a local `packs/` store next to the production one
   without clobbering read state (today this is exactly what happens).

Non-goal, stated up front: this is **not** a merge of two stores into one. Each
mounted store keeps its own chron space, its own feeds and its own generation
line. See §9.

---

## 2. Ground state this builds on

| Fact | Consequence for this design |
|---|---|
| **Boot is root → manifest** (S32/S33 shipped, v4.7.1). `data.ts parseDb` branches on `rootIsLegacy(raw)`; `names.ts` resolves both shapes into one `StoreNames`. | A mount's boot is exactly one root fetch plus (v2) one manifest fetch. Nothing else in the design needs to know which shape a mount is. |
| **S34 makes the v2 root the only shape the *writer* emits.** | The *reader* keeps both branches permanently — a federated peer may run an older binary. §8.4. |
| **Chron addresses are permanent** (`MANIFEST-SPEC.md` §9, invariant M8). §9.6 names store merging (S36–S38) as the plausible future trigger for renumbering and does not permit it. | Two mounts each have a chron space starting at 0. This design never renumbers, never maps, and never lets a chron travel without its mount id. §4, MS1. |
| **The reader origin already differs from the store origin.** `srr.32b.io` (Cloudflare Pages) reads `cdn.llera.eu`; there is no store-root shell (`cdn.llera.eu/index.html` 404s). | Cross-origin is the *normal* case, not the exotic one. CORS on each mounted origin is a live requirement (§7). |
| **Consequence nobody has written down:** `sw.ts` returns early for `url.origin !== sw.location.origin` and for paths outside `SCOPE`. | In the deployed configuration the service worker **does not cache packs at all** — offline reading and offline pinning are live only in the e2e layer, where packs are served same-origin under `/packs/`. Teaching the SW about mounted roots (§5) is therefore also the fix for that gap. Verify this on the live deployment before S38 starts; if it holds, it is the single highest-value side effect of this work. |
| `profile.ts` is `v:2` and replicates `srr-seen`/`srr-saved` across a fleet with no coordinate-space concept ("the multiplier", `MANIFEST-SPEC.md` §9.1). | The blob is the hardest part of namespacing, not localStorage. §4.4. |

---

## 3. The mount table

### 3.1 Record shape

```jsonc
{
  "id":    "s3f9a1c22",          // namespace — see 3.2
  "url":   "https://cdn.example.org/store/",  // normalized root, always trailing "/"
  "label": "Alice's wire",       // user-editable display name
  "ord":   10,                   // sort position in the picker
  "role":  "peer",               // "home" | "peer"
  "cred":  false,                // send credentials (cookies) with every fetch
  "added": 1753120000,           // unix sec, first mount (informational + tie-break)
  "ts":    1753120000,           // unix sec of the last mutation of THIS record (LWW)
  "del":   false                 // tombstone flag
}
```

Nothing else. In particular the record carries **no secret**: `cred` is a
boolean, not a token (§7.3), and no per-mount sync endpoint exists (§4.2).

### 3.2 Identity — decided

- **The home mount's id is the literal `"0"`**, always, independent of its URL.
  It is the store the build points at (`SRR_CDN_URL` → `PACK_BASE`), it always
  exists, and it cannot be removed (only re-pointed).
- **Every other mount's id is `s` + FNV-1a-32 of its normalized URL, lowercase
  hex, zero-padded to 8** (`s3f9a1c22`). Deterministic, so two devices that
  mount the same URL independently agree on the namespace with zero
  coordination — which is what makes the synced mount table converge (§3.4).

Normalization before hashing: parse with the `URL` API (punycodes the host,
lowercases scheme+host, drops default ports), reject anything but `https:`
(and `http:` on `localhost`/`127.0.0.1` for dev), reject embedded credentials
(`user:pass@`), drop query and fragment, and ensure exactly one trailing `/`.

Why the URL and not something the store publishes: nothing in the store carries
an identity today, and S38 is a frontend-only step. **If a future manifest ever
carries a `store_id`, prefer it over the URL hash** — a re-hosted store would
then keep its device state for free. Until then, §3.5.

**Home-collision rule.** A device may receive (via sync) a mount record whose
normalized URL equals its own home URL. It must **collapse that record into
mount `0`**: drop the record locally, merge its per-store substate into the home
substate under the ordinary per-key rules, and keep a local alias note so it does
not re-add it on the next pull. Without this, a device served *from* the store
and a device that mounted the same store by hand would keep two disjoint read
frontiers for the same articles.

### 3.3 Where it lives

- **Device:** `localStorage["srr-mounts"]` — a JSON array of records (all of
  them, tombstones included). Absent ⇒ synthesized as
  `[{id:"0", url:PACK_BASE.href, label:"", ord:0, role:"home", cred:false, …}]`,
  which is exactly today's behavior.
- **Backup / sync:** the profile blob's additive `mnt` field (§4.4). The mount
  set is fleet state: subscriptions follow the person, not the device.

### 3.4 Merge across devices — an OR-set with LWW records

The mount table is an **add/remove set**, which is the one shape a naive
last-write-wins map gets wrong: without tombstones, device A's unmount is undone
by device B's next push, forever.

Rules, applied per `id`:

1. Union by `id`.
2. Both sides present ⇒ take the record with the **strictly greater `ts`**
   wholesale (label, ord, cred, del — one record, one clock: a mount's
   presentation fields are never edited on two devices in the same second in a
   way worth splitting).
3. Equal `ts` ⇒ **the deleted record wins** (removal is the conservative
   direction; re-adding is one tap, un-losing is not).
4. A tombstone (`del:true`) is retained forever. A record is ~120 bytes; a
   fleet's lifetime unmounts are noise next to the seen map.
5. Any local edit (label, order, cred, mount, unmount) sets `ts = now` on that
   record only.

**Different mount sets between devices** are therefore transient by
construction: they converge on the next cycle each way. Between cycles:

- A device holding mount `X` that the other has not yet seen keeps pushing
  `ms["X"]` (§4.4); the other device ignores it until it adopts the record.
- **A store substate is never deleted because its mount record is absent** —
  absent means "no opinion", never "empty" (this is the existing
  missing-`saved`-field rule from `profile.ts`, generalized; MS8).
- **Unmount does not delete read state.** Unmounting hides the lanes and stops
  the fetches; the namespaced keys and the blob substate survive, so a
  mis-tapped unmount costs nothing. A separate, explicitly-worded **"Remove and
  forget this store's reading history"** action deletes the local keys and
  writes an empty substate. (Only that path is destructive, and it is the only
  path that can be.)

### 3.5 Re-hosting a store

A store that moves origin is, under §3.2, a different mount. The UI offers the
migration explicitly rather than guessing: mounting URL B while mount `s<A>`
exists offers **"Move <label> here (keep reading history)"**, which:

1. renames every local `…@s<A>` key to `…@s<B>`,
2. writes both records with a fresh `ts` — `s<A>` as `del:true` carrying
   `moved_to:"s<B>"`, `s<B>` as the live one,
3. lets peers replay the same rename deterministically when they adopt the pair
   (a device that sees a tombstone with `moved_to` and holds `…@s<A>` keys
   performs the identical rename before merging).

This is the only state-migrating operation in the design, it is user-initiated,
and it is idempotent.

---

## 4. Namespacing device state

### 4.1 The scheme — decided

**Key-per-store, with the home mount keeping the legacy bare names.**

```
mount "0"        →  srr-seen        srr-seen-ts        srr-saved        srr-pins        srr-profile-ts
mount s3f9a1c22  →  srr-seen@s3f9a1c22   srr-seen-ts@s3f9a1c22   srr-saved@s3f9a1c22   …
```

Why this and not a single key holding a `{mid: {...}}` map:

- **The migration is empty.** Today's keys already *are* mount 0's keys, by
  definition. No read frontier, no ★-Saved queue, no pin registry is ever
  rewritten — the highest-risk part of this work (real, unrecoverable user
  state) simply does not happen. §4.5.
- Reads and writes stay per-store: a hot `readSeen()` on the active store never
  parses another store's map.
- Quota pressure and corruption stay contained to one store's key.
- Every existing unit test that asserts on `"srr-seen"`/`"srr-saved"`/
  `"srr-pins"` stays valid unchanged.

`keys.ts` becomes a tiny function API, still side-effect-free:

```ts
export const HOME_MID = "0"
const q = (base: string, mid: string) => (mid === HOME_MID ? base : `${base}@${mid}`)
export const seenKey     = (mid: string) => q("srr-seen", mid)
export const seenTsKey   = (mid: string) => q("srr-seen-ts", mid)
export const savedKey    = (mid: string) => q("srr-saved", mid)
export const pinsKey     = (mid: string) => q("srr-pins", mid)
export const profileTsKey= (mid: string) => q("srr-profile-ts", mid)
// global, no mid
export const UNREAD_ONLY_KEY = "srr-unread-only"
export const IMG_PROXY_KEY   = "srr-img-proxy"
export const SYNC_URL_KEY    = "srr-sync-url"
export const MOUNTS_KEY      = "srr-mounts"      // new
export const HASH_KEY        = "srr-hash"        // moved here — ENG5
export const RELOAD_GUARD_KEY= "srr-reload-guard"// moved here — ENG5 (sessionStorage)
```

### 4.2 The complete `keys.ts` classification

Every key in `keys.ts`, plus the three ENG5 bypassers, plus the SW's storage
names. Nothing is left unclassified.

| Key | Today | Scope | Rationale |
|---|---|---|---|
| `SEEN_KEY` `srr-seen` | `{"feed:<id>": chronIdx}` | **per-store** | Values are chrons; feed ids are store-local. Two stores' `feed:3` are different feeds. |
| `SEEN_TS_KEY` `srr-seen-ts` | `{"feed:<id>": unixSec}` | **per-store** | Keys mirror `srr-seen` exactly; must move with it or LWW ordering detaches from the values it orders. |
| `SAVED_KEY` `srr-saved` | `chronIdx[]` in save order | **per-store** | chronIdx *element identity*. A cross-store queue is possible later (§6.5) but the storage stays per store either way. |
| `PINS_KEY` `srr-pins` | filterKey → `{names}` | **per-store** | Values are store-relative pack names (`data/17.gz`) — meaningless without a root. The SW pin protocol already carries a `base`, so this generalizes cleanly (§5.5). |
| `PROFILE_TS_KEY` `srr-profile-ts` | unix sec, LWW ordering | **per-store** | It orders `saved` LWW, and saved is per store. Mount 0 keeps the bare key = the blob's top-level `ts` (wire compatibility, §4.4). |
| `UNREAD_ONLY_KEY` `srr-unread-only` | `"1"`/`"0"` | **global** | A view mode of the reader, not a property of a store. Flipping it per store would be a surprise, not a feature. |
| `IMG_PROXY_KEY` `srr-img-proxy` | URL prefix | **global** | A device-level privacy setting applied to *external* image URLs from any store. Per-store proxies would be config theatre. |
| `SYNC_URL_KEY` `srr-sync-url` | endpoint URL | **global** | One profile, one endpoint. Per-store endpoints would split the mount table from the state it describes and multiply round-trips. The blob carries all stores (§4.4). |
| `srr-hash` (ENG5 — `app.ts:260`, `app.ts:1242`) | last surface hash | **global**, store-qualified *value* | The device has one reading cursor because it has one reader surface. The mount rides inside the hash's token grammar (§6.3), so the stored string is self-describing and today's stored values (bare tokens) already mean mount 0. |
| `srr-reload-guard` (ENG5 — `data.ts:110`, sessionStorage) | `"1"` | **global** | It guards a *global* action (`location.reload()`), so one flag is the correct scope. Its clearing rule changes (§8.5) and it moves into `keys.ts`. |
| `srr-saved` literal (ENG5 — `design.ts:198,201`) | dev harness | — | Dev-only bypasser: must call `savedKey(HOME_MID)`. The harness is single-store by construction. |
| SW `srr-assets-v1` / `srr-packs-v3` / `srr-shell-v1` / `srr-meta-v1` / `srr-pinned-v1` | Cache buckets | **global buckets, per-root entries** | Cache keys are absolute URLs, so two roots cannot collide. Partitioning is a matter of *bounds and GC*, not of bucket names. §5.3. |
| SW `https://srr.invalid/{gen,seq,manifest}` | synthetic META entries | **per-root** | Become `https://srr.invalid/<mid>/{…}`; one-shot seeded from the legacy keys on upgrade (§5.6). |
| SW roots list (new) | — | **global** | `https://srr.invalid/roots` — the mount table the SW routes by (§5.1). |

### 4.3 ENG5 — what it found, verbatim, and why it is load-bearing here

> **ENG5 — Persisted keys bypass the keys.ts convention** · `P3 · S · FE-E4`
> `srr-hash` raw literal (`app.ts:260,1242`), `srr-reload-guard` raw
> sessionStorage literal (`data.ts:85`), `srr-saved` literal in the design
> harness — CLAUDE.md says every persisted key belongs in keys.ts. Move the
> constants; decide whether `srr-hash` should join the profile export while
> there.

Enumerated against the current tree (line numbers as they stand today):

| Site | Literal | Access | Disposition |
|---|---|---|---|
| `frontend/src/js/app.ts:260` | `"srr-hash"` | `localStorage.setItem` | → `HASH_KEY`; value gains the mount-qualified token grammar (§6.3). |
| `frontend/src/js/app.ts:1242` | `"srr-hash"` | `localStorage.getItem` | → `HASH_KEY`; a bare-token value keeps meaning mount 0. |
| `frontend/src/js/data.ts:110` (`RELOAD_GUARD` const, used at `:126,:127,:330,:365`) | `"srr-reload-guard"` | `sessionStorage` get/set/remove | → `RELOAD_GUARD_KEY` in `keys.ts`; clearing rule per §8.5. |
| `frontend/src/js/design.ts:198,201` | `"srr-saved"` | `localStorage` get/set | → `savedKey(HOME_MID)`. |

A P3 tidiness finding under one store is a **correctness hazard under N**: a
literal is by definition unnamespaced, so every bypasser silently reads or writes
*mount 0's* state while the reader believes it is acting on the active mount.
`srr-hash` written bare while a peer lane is active would resume the wrong
store's position on the next boot; the reload guard is the one case where global
really is right, and saying so explicitly is what stops S38 from "fixing" it into
a per-store key that then fails to prevent reload loops.

**S37 must land ENG5's fix** (it is in the same files, and S38 cannot be safe
without it). ENG5's open question — should `srr-hash` join the profile export? —
is answered **no**: a reading *position* is device-local (it is the one thing
`profile.ts` has always excluded on purpose), and under multi-store it would also
teleport a device onto a mount it may not have adopted yet.

### 4.4 The sync blob — additive, `v:2` stays

`profile.ts` rejects any `v` outside `{1,2}`, so a version bump would make every
not-yet-updated device fail sync loudly. Instead, follow the precedent the module
already set for `st` ("additive, so old builds ignore it without a version
bump"):

```jsonc
{
  "v": 2,
  "ts": 1753120000,          // home store's LWW clock  (unchanged)
  "seen": { "feed:3": 41 },  // home store               (unchanged)
  "st":   { "feed:3": 1753119000 },
  "saved": [1201, 87],       // home store               (unchanged)
  "unreadOnly": false, "imgProxy": "",

  "mnt": [ /* §3.1 records, tombstones included */ ],        // NEW, additive
  "ms": {                                                     // NEW, additive
    "s3f9a1c22": { "ts": 1753119500, "seen": {…}, "st": {…}, "saved": [ … ] }
  }
}
```

- **The home store's wire shape does not move.** An old build pulls this blob,
  ignores `mnt`/`ms`, and merges the home store exactly as it does today.
- **Per-store rules are the existing rules, applied per store**: `seen`+`st`
  merge per key by `mergeSeen` (strictly-newer stamp wins in either direction,
  otherwise raise-only max); `saved` + that store's `ts` are LWW; an **absent**
  store key or an absent/malformed `saved` is "no opinion", never a deletion.
  `ms` is merged for every store the local device knows *or* the blob carries —
  a mount not yet adopted still has its substate preserved and pushed on.
- **`mnt` merges per §3.4** before `ms`, so a rename (§3.5) is applied to the
  substates in the same cycle.
- **Old-build regression, honestly:** an old device's PUT contains no
  `mnt`/`ms`, so it strands the multi-store part of the endpoint. A new device
  detects `remote.ms` missing/behind while local holds it and **forces a push** —
  the same self-healing shape as today's "v1 remote → force push" upgrade rule.
  Worst case is one cycle of staleness for peer stores; the home store, the only
  thing an old build can act on, is never corrupted. (MS8.)
- `sync.ts`'s `seenBehind` push trigger extends to "…or the remote is missing a
  store's substate / is behind on any store's per-key stamps".

### 4.5 Migration for existing users — there is none, plus two footnotes

Because mount 0 keeps the bare key names and the blob keeps its top-level
fields, an existing single-store user's read frontiers, ★-Saved queue, pins,
preferences, sync endpoint and stored hash are **already** correct multi-store
state. First boot after S38 synthesizes the one-record mount table (§3.3) and
changes nothing else.

Two things are not free and are handled explicitly:

1. **SW META keys** become per-root (§5.6): seed the home root's entries from
   the legacy global keys once, then delete the legacy keys — otherwise the
   first boot reads gen/seq as 0, decides the store changed, and purges the
   PACKS **and PINNED** buckets, which would silently destroy every user's
   offline copies.
2. **The design harness** writes `srr-saved` directly (§4.3) and must be
   switched to `savedKey(HOME_MID)` or its fixtures land under a key nothing
   reads.

---

## 5. Service worker

### 5.1 Routing across N roots

Replace the two early-outs (`url.origin !== sw.location.origin`,
`!path.startsWith(SCOPE)`) with **longest-prefix matching against the mounted
roots**:

```ts
// roots: [{ mid, base: "https://cdn.example.org/store/", cred: boolean }]
const hit = matchRoot(url)              // longest base that is a prefix of url.href
if (!hit) return                        // not ours — untouched (img proxy, sibling deploys, …)
const key = url.href.slice(hit.base.length)   // store-relative: "data/17.gz", "db.gz", …
```

`key` then goes through the existing grammar unchanged (`parsePackName`,
`RE_ASSET`, `RE_DB`, `RE_SHELL_HASHED` — the last only for the home/scope root,
which is the only one that serves the shell). Longest-prefix keeps two stores on
one origin under different path prefixes (`/packs/` and `/packs2/`, the cheap e2e
arrangement) from bleeding into each other, and keeps a sibling deployment on the
reader's own origin out entirely — the property `SCOPE` provided.

**Where the roots come from.** The page posts `{type:"mounts", roots:[…]}` on
boot and on every mount-table change; the SW persists it as a synthetic META
entry (`https://srr.invalid/roots`) because fetch events can arrive before any
page has spoken to this worker instance. With no stored roots the SW falls back
to today's behavior (own origin + scope), so a cold worker is never worse than
now.

### 5.2 Cross-origin is the point (and the current gap)

Mounted roots are usually cross-origin, so:

- The store origin **must** allow the reader origin (§7.1). Without CORS the
  page's own `fetch` fails anyway; the SW must not paper over it by caching an
  opaque response (status 0, unreadable body) — **never cache a response with
  `type === "opaque"`**, and let the failure surface to the page as a mount
  error (§8.3).
- Credentialed mounts: the SW's own constructed requests (pin fetches,
  `cacheFirst`'s revalidation) must carry `credentials: "include"` when the
  matched root's `cred` is set. Requests forwarded from the page already carry
  the page's mode.

This is also the fix for the deployment gap noted in §2: once the SW knows
`cdn.llera.eu` is a mounted root, production finally gets the pack cache,
offline reading and offline pinning that today only exist in the e2e layer.

### 5.3 Cache partitioning — by key, bounded by root

Cache API entries are keyed by absolute URL, so **no new buckets are needed for
correctness**; the five existing buckets stay. What must become per-root is
everything that *counts* or *evicts*:

- `enforceCacheBounds`: group cached keys by matched root first, then by series,
  then apply `SERIES_KEEP` **within the group**. Otherwise a peer store's archive
  walk evicts the home store's packs.
- Budgets: home keeps today's `PACK_KEEP=100 / META_KEEP=80`; peers get a
  tighter `PEER_PACK_KEEP=40 / PEER_META_KEEP=30` (peers are browsed less, and
  N mounts otherwise multiply the device footprint linearly). `ASSET_KEEP`
  stays one global bound — assets are content-hash-keyed and shared-by-accident
  across stores is harmless. Surface `navigator.storage.estimate()` in the mount
  card so the number is not a mystery.
- `PINNED` stays eviction-exempt and is unaffected by root grouping.

### 5.4 Per-root GC mirroring

`checkManifest` runs off a db.gz response; that response now belongs to a
specific root. Everything it does becomes root-scoped:

- `GEN_KEY`/`SEQ_KEY`/`MAN_KEY` → `https://srr.invalid/<mid>/{gen,seq,manifest}`.
- Every purge and prune filters cached keys by that root's prefix — a peer's
  `gen` change must never purge the home store's packs.
- Post-S34/§8.3 the whole prune becomes "on adopting manifest `m`, evict any
  cached object under this root named by neither `m` nor the previously-cached
  manifest". That rule is per-root by construction, which is one more reason to
  land multi-store *after* the manifest world rather than against `gcs`
  arithmetic.

### 5.5 The pin protocol already anticipated this

`sw.ts`'s `pin`/`unpin` handlers already accept a `base` and resolve names
against it. Two changes:

- The origin/scope guard (`url.origin === sw.location.origin &&
  url.pathname.startsWith(SCOPE)`) becomes **"the resolved URL is under one of
  the mounted roots"** — which keeps the cache-key surface just as closed while
  admitting cross-origin mounts. This is why the SW needs the roots list even for
  pinning.
- `pins-purged` gains the `mid` so the page clears only that store's registry.

The page always passes the active store context's base (S37 removes the
"default to `sw.registration.scope`" fallback, which is only correct for the
self-hosted single-store layout).

### 5.6 Upgrade

One-shot on first activation after S38: for each legacy META key
(`…/gen`, `…/seq`, `…/manifest`), copy its value to
`https://srr.invalid/0/<name>` and delete the legacy entry. Skipping this costs
every user a full PACKS **and PINNED** purge (a `gen` mismatch against a
synthesized 0) — i.e. their offline copies — for no reason.

### 5.7 When one store is unreachable

Nothing structural: `db.gz` is network-first with a cached fallback, and every
pack name is write-once and cache-first. A mount that is offline serves whatever
it served last, from its own cached snapshot — cached root and cached packs are
mutually consistent per-root exactly as they are today per-store. The reader-side
consequences (lane still listed, marked stale; no error popup) are §8.3.

---

## 6. The UX question — merged timeline vs per-store lanes

### 6.1 Decision: per-store lanes

**A navigation lane never spans mounts** (MS3). The store is a first-class axis
*above* tags and feeds in the picker; the reader's prev/next, the list's window,
and every count operate within exactly one mount's context.

### 6.2 Why not a merged timeline

The tempting version — one home list, newest-first across all mounts — fails on
four independent counts, any one of which is disqualifying:

1. **There is no sound merged sort key.** Chron is store-local and, per
   `MANIFEST-SPEC.md` §9, permanently so; there is no cross-store order. The only
   candidate is `IMetaWire.w` (published ?? fetched_at). But **`w` is not
   chron-monotone within a store** — chron order is `fetched_at`-monotone (the
   property `INBOX-SPEC.md` protects), while `published` is whatever the feed
   says. A `w`-ordered merge therefore produces a sequence that is not
   chron-descending *within either store*, which breaks the one identity the
   reader is built on.
2. **It breaks the most-tested machinery in the codebase.** `neighborOlder`/
   `neighborNewer`, `countLeft`/`countAll`, `pendingRight`'s floored tally, the
   seen frontier's very definition ("everything before this chron is read") and
   the badge↔pill differential oracle in `nav.test.ts` are all positional in one
   chron space. A merged walk needs an N-way merge cursor with its own
   counting story — a rewrite of the reader's core, not a mount feature.
3. **It converts a per-mount failure into a global one.** Answering "what is
   next?" would require an answer from every mount; one slow or offline peer
   either stalls the step or silently truncates the timeline. Under lanes, a dead
   peer costs exactly its own lane.
4. **Offline it lies.** With one store cached and another not, a merged list
   shows holes that are indistinguishable from "nothing was published".

### 6.3 What per-store lanes actually change

**Token grammar** (`nav.ts` `tokensSuffix`/`parseHashTokens`, unchanged
mechanics — `encodeURIComponent` already escapes `@` and `:`):

| Lane | Token(s) |
|---|---|
| Home `[ALL]` | *(none)* — `#412` still means what it means today |
| Home feed 5 / tag / saved / search | `5` · `news` · `~saved` · `q:climate` (unchanged) |
| Peer `[ALL]` | `@s3f9a1c22` |
| Peer feed 5 / tag / saved / search | `@s3f9a1c22:5` · `@s3f9a1c22:news` · `@s3f9a1c22:~saved` · `@s3f9a1c22:q:climate` |

Bare tokens mean the home mount, so **every existing deep link and every stored
`srr-hash` keeps working untouched**. All tokens in one hash must share one
mount prefix; a mixed hash keeps the first mount's tokens and drops the rest
(the same forgiving posture as today's malformed-escape handling).

**`picker.ts`** — mount sections. Home first, then peers by `ord`. Each section
header carries the mount label, its rolled-up unread count, and (in Info/stats
mode) opens the **mount card**: label, root URL, format version and manifest
generation, article/feed counts, last-updated, cache footprint, health/error, and
the destructive "Remove and forget" action. The existing `[ALL]` scope chip and
store-wide info card become per-mount instances of what already exists. A new
**Mounts…** row in the settings menu opens add/edit/reorder.

**Toolbar readout / breadcrumb** — prefixed `MOUNT · LANE` **only when more than
one mount is enabled**. A single-store user sees byte-identical chrome; this rule
is what keeps multi-store from taxing the 99% case.

**Cycling** (`W`/`S`, `↑`/`↓`, two-finger) stays **within the active mount**:
`getFilterEntries()` enumerates the active mount's lanes. Bounded sweeps and one
store's fetches per step. Changing mounts is a deliberate pick from the picker —
the same reasoning that keeps ★ Saved out of the cycle today.

**`list.ts` / `nav.ts` / `search.ts` / `refresh.ts`** — semantics unchanged;
they run against the active store context (§11). `refresh.ts` polls **every
enabled mount** per cycle (concurrently, under the one `guardBg` hold, each with
its own snapshot rollback) and applies per-mount backoff (§8.3).

### 6.4 What is honestly lost

There is no single "everything, newest first" surface. The mitigation is the
picker's mount sections with live unread rollups plus the breadcrumb — you can
see at a glance which store has something, in one tap. This is a real cost and
the design accepts it rather than trading it for a broken sort key.

### 6.5 The door, if a merged view is ever wanted

**★ Saved and search are the two modes where merging is structurally cheap** —
both already walk an *explicit materialized set* rather than idx entries, so a
cross-store version is a k-way merge over `(mid, chron)` pairs with no chron
arithmetic, no frontier semantics and no counting rewrite. If cross-store reading
is ever built, it starts there (`~saved@all`, `q:…@all`), not with the home
timeline. A merged *feed* timeline would additionally require: a `w`-keyed N-way
merge cursor, a per-store-partitioned frontier model for "mark all read", a
degraded-mount contract for the list window, and a new counting oracle. That is a
successor spec, not an extension.

---

## 7. Auth, CORS and trust, per mount

### 7.1 CORS requirements (the `srr.32b.io` lesson, generalized)

A mounted origin must allow the reader origin on **every** object class the
reader fetches: `db.gz`, `manifest/*`, `idx/*`, `data/*`, `meta/*`, `assets/*`.

| Header | Requirement |
|---|---|
| `Access-Control-Allow-Origin` | The reader origin (or `*` for a public store with `cred:false`). With `cred:true` it **must** be the exact origin — `*` is illegal with credentials. |
| `Access-Control-Allow-Credentials: true` | Required iff the mount is `cred:true`. |
| `Access-Control-Expose-Headers: ETag` | **Recommended.** `ETag` is *not* CORS-safelisted, so without this the SW's `validator()` shortcut in `dbNetworkFirst` silently degrades to `Last-Modified` (which *is* safelisted). Not fatal — `checkManifest` is best-effort and falls through to the full parse — but it costs a gunzip on every poll. |

Every reader request is a **simple** GET (no custom headers), so **no preflight
is involved** — and the design keeps it that way deliberately (§7.3).

Operationally this is exactly what `cdn.llera.eu`'s R2 CORS policy already does
for `https://srr.32b.io`; mounting a peer means that peer's operator does the
same for your reader origin. A store that does not is simply not mountable, and
the reader says so in those words (§8.3).

### 7.2 Private mounts — cookies, per `docs/STORE-VISIBILITY.md`

`cred:true` makes every fetch for that root `credentials:"include"`. Behind
Cloudflare Access, the browser attaches the Access session cookie automatically
once the user has authenticated to that origin — the store visibility doc's
"least invasive option", now per mount.

Session expiry is the failure that matters: Access answers an unauthenticated
request with a redirect to its login origin, which under CORS surfaces as a
network-class failure. The mount therefore reports **"Sign-in required"** with an
**"Open store to sign in"** action that opens the root URL in a new tab (where
the Access flow can run), and retries on focus return.

### 7.3 Service tokens are for the writer, not the reader — decided

The plan's wording ("private stores via Access service tokens") is refined here:
a **service token is a `CF-Access-Client-Id`/`CF-Access-Client-Secret` header
pair**, which in a browser reader would mean (a) storing a long-lived shared
secret in `localStorage`, readable by any XSS in sanitized third-party article
content, (b) turning every pack GET into a preflighted request, doubling
round-trips on the immutable objects the whole cache design exists to make free,
and (c) syncing that secret through the profile blob or re-entering it per
device. All three are unacceptable. Service tokens stay where they belong — the
**writer's** HTTP store backend (`HTTPConfig.Token`/`Headers`). The browser gets
cookies. The mount record consequently carries no secret at all (§3.1).

### 7.4 Trust model — new, and worth naming

Under one store the operator, the writer and the reader were the same person.
A federated peer changes that. Mounting a store means trusting its operator with:

- **Content.** Article HTML comes from a writer you do not control and may not
  have been sanitized at write time. `fmt.ts`'s reader-side sanitizer stops being
  defense-in-depth and becomes **the** defense. Consequence: the mount dialog
  says so plainly, and TST4's sanitizer fuzzing (findings doc) is promoted from
  nice-to-have to a prerequisite worth pulling forward.
- **Resolution scope.** A peer's relative asset refs must resolve against *its*
  base and are dropped when they escape it (the existing bounds check, now per
  store — MS7). A peer can never address an object in another mount's origin.
- **Observation.** The peer's origin sees your IP and reading pattern. The
  existing `referrerpolicy=no-referrer` / `rel=noreferrer` posture and the
  optional image proxy apply unchanged.

Plus the mechanical rules: `https:` only (mixed content would fail anyway),
no credentials in the URL, and the reader **never writes to any mount** (MS5).

---

## 8. Read-only federation and the version handshake

### 8.1 Read-only, and what that excludes

Every mount is read-only: the reader has never written to a store and does not
start. The distinction that matters is **admin affordances** — the
admin-into-reader work (ARC8 / S39–S40) surfaces operator actions in the reader,
and those must be offered for the **home mount only**, gated on `role === "home"`
plus a configured admin origin. A peer mount shows no admin surface at all, ever,
regardless of whether its admin GUI happens to be reachable.

### 8.2 Per-mount boot (the handshake)

Per mount, in parallel (`Promise.allSettled`), rebased entirely on the S33
contract:

1. `GET <root>db.gz`, `cache:"no-cache"` (+ credentials iff `cred`). Non-OK →
   `error` with the status.
2. Parse. `v > MAX_ROOT_VERSION` → **quarantine**: "This reader is older than
   *<label>* (store format v*N*)." No lanes, no polling until reload; the rest of
   the reader is untouched.
3. **Legacy-complete root** (`rootIsLegacy`: `total_art` present) → `legacyNames`
   path verbatim.
4. **v2 root** → `GET <root>manifest/<m>.gz` `force-cache`; the existing
   generation cross-check (`parsed.m !== m` → refuse) and version check
   (`v > MANIFEST_ROOT_VERSION` → quarantine, same UX as 2) apply per mount.
5. Build the mount's `StoreContext` (§11) and record its handshake result for
   the mount card: format shape, manifest generation, `total_art`, feed count,
   `fetched_at`.

`refresh()` per mount uses the same rules; a mount whose handshake result
*changes shape* (a peer upgraded from legacy to v2 between polls) is simply
re-applied — the branch is per-response, not per-mount-lifetime.

### 8.3 Failure UX — one bad mount must not blank the reader (MS4)

| Situation | Behavior |
|---|---|
| One mount fails to boot | Its lanes vanish from the picker; its section header shows a state chip (Offline / Sign-in required / Not allowed (CORS) / Too new / Error). Other mounts render normally. **No error popup.** |
| The *home* mount fails, others succeed | The reader still opens, on the first healthy mount, with the home section showing its error chip and a retry action. |
| **All** mounts fail | The existing global error popup with retry — today's behavior, unchanged. |
| A mount fails during `refresh()` | Silent; the lane keeps serving its last snapshot (per-mount rollback, Appendix-D discipline per context) and the settings footer's "Refresh failed — …" row names the mount. |
| Repeated failures | Per-mount backoff: 1 min → 5 min → 30 min cap, reset on any success or on an `online` event. A dead peer must not cost a request every 5 minutes forever. |

**Diagnosis honesty:** a CORS rejection and a network outage are
indistinguishable to `fetch` (both are a `TypeError`). The chip therefore reads
**"Unreachable — offline, or the store does not allow this reader's origin"**
when the browser is online, and plain "Offline" when `navigator.onLine` is false.
Do not claim a cause the platform does not give us.

### 8.4 A consequence worth stating: the legacy reader branch becomes permanent

S34 retires the legacy root on the **writer** side. This design pins
`legacyNames` and `rootIsLegacy` as a **permanent inbound compatibility surface
on the reader**: a federated peer may be running a binary from before the
cutover, indefinitely, and the reader has no way to make it upgrade. The dual
path in `names.ts`/`data.ts` is therefore not transitional scaffolding to delete
after S34 — it is the federation protocol's version tolerance. Say so in the code
comments at S38 so a later cleanup does not remove it.

### 8.5 Guarded reload becomes home-only

`assertPackOk`'s `location.reload()` self-heal (a stale tab whose tail
generation was GC'd) is a **whole-page** action; firing it because a *peer's*
tail 404'd would yank a reading user out of an unrelated store. With per-mount
contexts there is a strictly better remedy:

- **Home mount:** keep today's guarded reload exactly (pinned by
  `delta.e2e.test.ts`).
- **Peer mount:** no reload. Re-run that mount's boot in place (re-fetch its
  root, rebuild its context) — the same recovery `refresh()` already performs,
  scoped. If it fails, the mount goes to `error` per §8.3.

The single global `srr-reload-guard` (§4.2) remains correct because it guards the
global action; it is cleared once the **home** mount completes a successful boot.

---

## 9. Out of scope

### 9.1 Cross-store dedup — explicitly not built

Two mounted stores may carry the same feed. The reader will show both. This is
deliberate:

1. **There is no cross-store article identity.** `MANIFEST-SPEC.md` §9.5 already
   rejected a stable per-article id: it is a wire-format addition
   (`ArticleData`), a profile migration, and a reader redesign. Dedup needs
   exactly that identity — `(feed_url, guid)` is not resolvable to a chron
   without scanning idx+data on both stores.
2. **Dedup presupposes a merged timeline.** Suppressing store B's row because
   store A has "the same" article is only meaningful in a surface that shows them
   together, and §6.2 rejects that surface for v1.
3. **The frontiers would not merge either.** Read state is per feed per store; a
   deduped view would have to decide whether reading the A copy marks the B copy
   read, which is a cross-store frontier model — the thing §6.2's counting
   argument rules out.
4. **The writer's dedup is per store by construction** (`seen.gz`, the `bg`
   boundary hashes, the `dd`/`dt` knobs). There is no reader-side equivalent and
   building one would duplicate the writer's most subtle subsystem in TypeScript.

**Cheap consolation, allowed:** the mount card may report *"12 feeds are also
mounted from <other store>"* by comparing normalized feed `url` values from the
two roots — a **diagnostic only**, no filtering, no suppression, no state.

### 9.2 Also out of scope

- Cross-store search / cross-store ★ Saved (§6.5 names the door).
- Writing to any mount, including the home mount (MS5); admin actions stay in
  the ARC8 track and home-only (§8.1).
- Any renumbering, chron mapping, or compaction-epoch machinery
  (`MANIFEST-SPEC.md` §9.6 forbids it; nothing here needs it).
- Per-mount sync endpoints (§4.2) and per-mount image proxies.
- Discovery: there is no store directory, no autodiscovery, no invite format. A
  mount is a URL a person pastes. (A `.well-known`-style descriptor is an obvious
  future step and is deliberately not designed here.)

---

## 10. Invariants

| # | Invariant |
|---|---|
| **MS1** | Every chronIdx-valued piece of device state lives under a mount-qualified key, and no code path may read a chron from one mount's state and address it into another mount's context. |
| **MS2** | The home mount's id is the literal `"0"` and its keys are the legacy bare names; every other mount's id is `s`+FNV-1a-32(normalized root URL) in 8 hex digits. |
| **MS3** | A navigation lane never spans mounts: `nav.filter` is always resolved within exactly one store context. |
| **MS4** | Mount failures are isolated: no mount's boot or refresh failure prevents another mount's lanes from rendering. Only all-mounts-failed reaches the global error popup. |
| **MS5** | The reader never writes to any store. Every mount is read-only; admin affordances are home-only. |
| **MS6** | Service-worker cache keys are absolute URLs; bounds, purges and GC mirroring are computed per matched root, never globally. |
| **MS7** | A relative content URL resolves against its own article's store base and is dropped when it escapes that base. |
| **MS8** | Wire compatibility is additive: the profile blob stays `v:2`; multi-store state rides `mnt`/`ms`; an absent store substate means "no opinion", never a deletion; an old build may strand peer state but can never corrupt the home store's. |
| **MS9** | No mount record ever contains a secret. Credentials are browser cookies only, negotiated at the store's own origin. |

`srr inspect` gains nothing from this work (it is a writer tool); the reader-side
equivalents are unit and browser tests (§12).

---

## 11. What S37 must deliver

S37 is "refactor `PACK_BASE` into a store context, single-store, zero behavior
change". For S38 to be *wiring + UI*, S37 must land all of the following.

### 11.1 The context object

```ts
export interface StoreContext {
   mid: string             // "0" for home — the namespace for every per-store key
   base: URL               // was PACK_BASE
   cred: RequestCredentials// "same-origin" | "include"
   role: "home" | "peer"
}
```

…plus every piece of module state that is today a `let` in `data.ts` moved onto a
per-context record: `db`, `names`, `idxFetches`, `idxHeaders`, `latestIdx`,
`deltaArts`, `deltaLoad`, `slots`, `expiredCounts`, `dataCache`, `metaCache`,
`groupCache`, `manifestMemo`, `bgRefresh` — and in `search.ts`: the shard LRU,
the summary and latest-tail lazy slots, the hit-set LRU, and the delta-fold memo.

### 11.2 Threading rule

- **`data.ts` / `search.ts`:** an explicit context parameter (or a bound
  per-context module instance). No hidden "active" lookup on hot paths.
- **`nav.ts` / `list.ts` / `picker.ts` / `app.ts`:** an `activeStore()` accessor,
  so the diff stays bounded and the UI has one notion of "the lane I am in".
- The eager module-load `db.gz` fetch (`const dbLoad = loadDb()`) becomes the
  home context's eager fetch — the boot-latency property must be preserved
  exactly.

### 11.3 `fmt.ts` takes a base

`sanitizeFragment`/`sanitizeHtml`/`extractPrefetchMedia` currently close over
`PACK_BASE`. They must take the **article's** store base as an argument (they
already take the proxy prefix). This is a correctness requirement, not tidiness:
MS7 depends on it, and a peer article resolving against the home base would let
a peer address the home origin.

### 11.4 ENG5, fixed

Move `srr-hash` and `srr-reload-guard` into `keys.ts`; fix `design.ts`'s
`srr-saved`; convert `keys.ts` to the `(mid) => key` API of §4.1 with
`HOME_MID = "0"` returning the legacy names. **S37, not S38** — a bypasser is
invisible under one store and silently wrong under N.

### 11.5 SW plumbing

Every `pin`/`unpin` message carries the context's `base` (drop the
`sw.registration.scope` default). The `mounts` message and root matching are
S38's, but the page side of "always name the base" is S37's.

### 11.6 Preserved discipline

- `refresh()`'s all-or-nothing snapshot rollback becomes per context, keeping
  the Appendix-D invariants intact (`buildLatestIdx`, the `deltaLoad`
  before-await ordering, db+names installed together synchronously).
- Single-store output byte-identical where testable; `make verify` +
  `make test-browser` + `make test-stress` all green (nav/data hot paths).

### 11.7 The one new test S37 owes S38

A unit test proving **two contexts do not see each other's state**: two
`StoreContext`s with different `mid`s, seen/saved/pins written through each, and
assertions that neither key space is touched by the other — plus that
`mid === "0"` writes the bare legacy key names.

---

## 12. S38 — implementation order and verification

Suggested order, each step shippable:

1. Mount table module (`mounts.ts`): records, normalization, id hashing, storage,
   OR-set merge, the home-collision and rename rules. Unit-tested standalone
   (like `pin.ts`/`profile.ts`, no pack server).
2. `profile.ts`/`sync.ts` additive `mnt`/`ms` (§4.4) + the force-push on a
   remote missing `ms`.
3. N-context boot in `data.ts`: parallel per-mount handshake, per-mount error
   state, per-mount refresh with backoff.
4. SW: roots message + persistence, longest-prefix routing, per-root bounds and
   GC mirroring, the META key upgrade (§5.6), widened pin guard.
5. UI: picker mount sections, mount cards, Mounts… dialog, breadcrumb
   (multi-mount only), token grammar.

Verification:

- **Unit:** mount merge (add/remove/rename/home-collision, both orders,
  idempotent), key namespacing, token grammar round-trip incl. legacy bare hashes.
- **Contract (jsdom):** two stores written by the real `srr` binary, mounted
  together; assert chron spaces stay separate (a saved chron in store A never
  resolves against store B), per-store counts, and that a failed mount leaves the
  other's lanes intact.
- **Browser:** the e2e static server already serves one origin — add a second
  root under a second path prefix for same-origin multi-mount, **plus a second
  port with explicit `Access-Control-Allow-Origin`** for the cross-origin case
  (that is the case production actually runs, and the one no test covers today).
  Scenarios: two mounts render, lanes do not bleed, one mount 500s and the reader
  still works, offline with one mount cached, pinning a cross-origin mount.
- **Manual smoke** (as the plan asks): the prod store plus a local `packs/`
  store, mounted together, including an offline pass.

---

## 13. Risks and open questions

| Risk | Disposition |
|---|---|
| **The SW may be inert in production today** (§2). | Verify before S38. If true, S38 turns pack caching on for prod for the first time — a behavior change worth its own announcement and a staged rollout, not a silent side effect. |
| Storage quota multiplies with N mounts. | Per-root budgets with a tighter peer keep (§5.3) plus `navigator.storage.estimate()` in the mount card. The browser's own eviction is the backstop; a pinned peer store is the realistic way to hit the wall. |
| An old build's sync push strands peer state. | Self-heals on the next new-build cycle (§4.4). Residual: one cycle of staleness for peers. Accepted. |
| Peer content is untrusted HTML. | §7.4. Pull TST4 (sanitizer fuzzing) forward as a prerequisite. |
| Mount-table growth (tombstones forever). | ~120 bytes each. If it ever matters, prune tombstones older than a year that no device's `ms` still references — not built. |
| A peer store rewrites history (rebuild with different content under the same names). | Exactly the `gen`/manifest story, per root (§5.4). Under S35 a rebuild writes fresh names, so this stops being possible on any store that has upgraded. |
| **Open:** should the home mount be re-pointable in the UI? | Today changing `SRR_CDN_URL` silently reuses device state; §3.2 preserves that. Exposing it as an editable field would need the §3.5 rename flow. Deferred, deliberately. |
| **Open:** store-published identity. | If the manifest ever carries a `store_id`, adopt it over the URL hash (§3.2) — a strictly better identity, and a small backend addition. Not required for S38. |
