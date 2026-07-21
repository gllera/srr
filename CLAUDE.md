# CLAUDE.md

## Project

**SRR** — Static RSS Reader. Monorepo with two subprojects:

- **`backend/`** — Backend. Go CLI that fetches RSS/Atom/RDF feeds into gzip-compressed pack series. Backends: local filesystem, S3, SFTP, HTTP.
- **`frontend/`** — Frontend. Single-page reader. Zero runtime deps. Parcel + TypeScript + plain CSS.

The backend additionally exposes an **MCP tool interface** — seven tools (`srr_overview`, `srr_list_articles`, `srr_preview_feed`, `srr_resolve_feed`, `srr_add_feed`, `srr_update_feed`, `srr_fetch`) served over two transports: the `/mcp` endpoint `srr serve` mounts next to `/api/*` (inside the same loopback `hostGuard`), and stdio via `srr mcp`. Each tool wraps the function the CLI and admin GUI already call, so the three surfaces can't drift; `srr_update_feed` alone deviates, using merge-on-absent rather than the GUI's full replace. Backend-only — it is not part of the writer↔reader data contract below, and the reader never speaks it. Setup and caveats: root `README.md` → MCP; implementation: `backend/CLAUDE.md` → the `mcp.go` bullet.

## Commands

All commands run from the repo root via `make`:

| Command | What it does |
|---|---|
| `make verify` | Full check: lint + format + test + build (both projects) + e2e contract layer |
| `make verify-fe` | Frontend pipeline only |
| `make verify-be` | Backend pipeline only |
| `make test-fe` | Frontend unit tests |
| `make test-be` | Backend unit tests |
| `make test-contract` | E2e contract layer: real `srr` packs → real `idx.ts`/`data.ts`/`nav.ts` (jsdom, fast; in `verify`) |
| `make test-browser` | E2e browser layer: real built SPA in headless Chrome over real packs (Puppeteer; opt-in locally, but a required CI job — `ci.yml` runs it on every push/PR) |
| `make test-e2e` | Both e2e layers — the writer↔reader contract. Suite lives in `frontend/e2e/` |
| `make test-stress` | Large-store (>50k) stress/perf layer: real `srr` output → real `idx`/`data`/`nav`/`search`, measuring navigation/filtering/query at scale (jsdom; opt-in, NOT in `verify`; generates or reuses a synthetic store via `genbig_test.go`, tune with `SRR_STRESS_N`/`SRR_STRESS_STORE`). Suite in `frontend/e2e/stress/` |
| `make lint-fe` | ESLint |
| `make format-fe` | Prettier write |
| `make format-check-fe` | Prettier check only |
| `make dev-fe` | Frontend dev server |
| `make build-fe` | Production frontend build (auto `npm ci` if `node_modules` is stale) |
| `make smoke-fe` | Boot smoke-test of the built bundle (`frontend/e2e/boot-smoke.mjs`; runs inside `verify-fe`) |
| `make build-be` | Go build |
| `make vet-be` | Go vet |
| `make format-be` | `gofmt -w` the backend |
| `make format-check-be` | gofmt check only (fails on unformatted Go; runs inside `verify-be`) |
| `make lint-be` | golangci-lint (gate-clean; runs inside `verify-be`, config in `backend/.golangci.yml`) |
| `make generate` | Regenerate `frontend/src/js/format.gen.ts` from the backend Go declarations (`srr gen-ts`) |
| `make generate-check` | Fail if `format.gen.ts` is stale (runs inside `verify-be`) |
| `make release` | Cross-compile backend for all platforms (requires `VERSION=`) |
| `make design-fixture` / `make design` / `make design-shots` | Design harness: build the curated store fixture / dev server on it (`/design.html`) / headless screenshots of every UI state (see `frontend/CLAUDE.md` → Design harness) |
| `make clean` | Remove build artifacts |

## Data Contract

Shared format between backend (writer) and frontend (reader).

**Single source of truth**: the Go declarations — the format constants in `backend/db.go` (`dbFormatVersion`, `idxPackSize`, `idxHeaderPrefix`, `idxEntrySize`, `idxBoundarySize`, `feedIDCeiling`, …), the write-once object-name grammar `store.PackSeries` in `backend/store/main.go` (one row per series, every stem an opaque digit run; builds the store's `packKeyRe` and, via the generated `PACK_SERIES_KINDS`, the service worker's route regex), and the JSON struct tags of `ArticleData`/`MetaEntry`/`FeedPublic`/`Manifest`/`RootState`. The TS side consumes them through the generated `frontend/src/js/format.gen.ts` (constants + grammar table + wire interfaces; emitted by the hidden `srr gen-ts` command, regenerated via `make generate`, freshness-checked by `make verify`). The backend's only read-side idx parser is `backend/idx_read.go`, a byte-for-byte mirror of `frontend/src/js/idx.ts`.

**The commit model is `docs/MANIFEST-SPEC.md`** (generation manifests, cut over 2026-07-21) — read it before touching the commit path, the object names, or the GC. In one paragraph: the root `db.gz` is a ~60-byte pointer `{v, m, t}`; every Commit publishes one immutable `manifest/<m>.gz` that LISTS every live object of every series explicitly; names are opaque per-series stems drawn from counters that are never reused; the operator's configuration lives in a backend-only `config.gz` sidecar no reader fetches. Everything else follows from that, including the ONE crash argument (§6.1) that replaced eight per-feature ordering proofs and the ONE GC rule (§7) that replaced four window formulas. The **delta-segment tail** (`docs/DELTA-TAIL-SPEC.md`) still describes the tail write path; its naming arithmetic is superseded by the manifest's explicit lists. **Why this contract exists at all**: `docs/STATIC-ENGINE-DECISION.md` records the settled fork (2026-07-20) — SRR is a small database engine on object storage and the read path stays static; SQLite behind the already-24/7 `srr serve` was considered and explicitly rejected, so nothing a reader needs may require an SRR process to be alive.

### `db.gz` — the root

```json
{"v":3,"m":1743,"t":1753027200}
```

| Field | Type | Description |
|---|---|---|
| `v` | int | Store format version (`dbFormatVersion`, currently **3**) — the `v` of the root AND of every manifest it names; they are one format, so there is one constant. **Three, not two**: the dual-write release stamped manifests `v:2` with a transitional `names` encoding, and the cutover replaced that encoding — so a reader from that release must stop at the ROOT with the version popup rather than misread the new `names` as an empty store. `NewDB` **hard-errors** on a store whose `v` exceeds this binary's, and `data.ts parseDb` rejects it through the error-popup path rather than misreading. A store at `v = 1` is the pre-cutover layout: it is READ (so the tools work on one no locked session has touched) and MIGRATED by the first locked session — `backend/root.go`. |
| `m` | int | The current manifest number: names `manifest/<m>.gz`. Monotone, +1 per publishing Commit, never reused (invariants M2/M3). This is the store's whole change signal — the reader's `refresh()` compares it, the service worker reconciles its cache on it. |
| `t` | int | `fetched_at` of the last cycle. Here as well as in the manifest, so a cycle that changed nothing else (a fully backoff-thinned poll, a zero-feed maintenance cycle) rewrites ~60 bytes and leaves `m` — and therefore every reader's cached manifest — untouched. |

Nothing else. In particular **not** `total_art`, `seq` or `gen`: any of them here would be a second source of truth for something the manifest owns. `no-cache, must-revalidate`, `application/gzip`, gzip-framed (so the reader's `DecompressionStream` path is uniform).

### `manifest/<m>.gz` — the generation manifest

Immutable, write-once, `cacheImmutable`, gzip JSON. One complete, self-contained description of one store state — which is why there is no separate snapshot series: restoring a store is writing `{"v":2,"m":<older>}` over `db.gz`.

```
{ v, m, fetched_at, total_art, mt?, na?, head?, hb?, pack_off, next_pid, dby?, gcm?, inbox?, names, feeds }
```

| Field | Type | Description |
|---|---|---|
| `fetched_at` | int | Unix timestamp of the cycle that published this generation. |
| `total_art` | int | Total article count across all packs. |
| `mt` | int | Entry count of the published meta tail. `SyncMeta` trusts a read-back tail only when its count matches, so a stale shard from a crash is rebuilt from data packs rather than extended. `omitempty`. |
| `na` | int | Article count across the live delta segments. `tailCovered = total_art − na` is the pack↔delta chron seam; cross-validated against the parsed chain on both sides (a mismatch fails loudly, never misaddresses). `omitempty`. |
| `head` | MetaEntry[] | Newest-glance projection: the newest `min(headMax, mt)` meta cards in chron order, `head[i]` == the card at chron `hb+i`. Maintained by `SyncMeta` from the tail lines it just wrote. The reader's `loadMeta` serves that chron window straight from the manifest, skipping the ~200 KB meta tail. **Reader-consumed**. `omitempty`. |
| `hb` | int | Chron of `head[0]`. Explicit — NOT derived from `total_art` — because `SyncMeta` is warn-only: a failed sync publishes a generation with a grown `total_art` and the previous cycle's `head`, and a derived base would misaddress every card by the batch size. `omitempty`. |
| `pack_off` | int | Writer cursor: the current offset in the tail data pack. |
| `next_pid` | int | Writer cursor: the POSITION the data series' tail occupies — the value every idx header's `packId_base` and every idx footer boundary is stated in. Deliberately redundant with the name list (which also implies it), like `na` and `mt`, and cross-checked by `srr inspect --validate` (M5). It is a position, never a name. |
| `dby` | int64 | Writer-only consolidation-trigger state: cumulative uncompressed JSONL bytes across the live deltas, reset at consolidation. `omitempty`. |
| `gcm` | int | Writer-only GC low-water mark: the highest generation the sweep has cleared. It clears `(gcm, m−K]` and advances only over generations actually cleared, so a missed or failed warn-only sweep can never permanently strand an object. `omitempty`. |
| `inbox` | object | Writer-only per-producer drained watermark (`map[string]int64`): the highest `cycle_id` of `inbox/<name>.gz` this store has folded in. It rides the manifest because it MUST become durable by the same atomic act as the batch it describes — the entire crash argument of `docs/INBOX-SPEC.md`. `omitempty`. |
| `names` | object | The object-name table (below). |
| `feeds` | object | Feeds keyed by id, **reader-facing fields only** (`FeedPublic`). |

**`names` — the object-name table.** Every live object, listed. There is NO computed-name fallback anywhere in the writer or the reader: two ways to learn a name means two truths that can disagree, and every disagreement is a 404 storm on live readers.

```json
"names": {
  "idx":  {"b":0, "r":[[0,20]], "l":19},
  "data": {"b":1, "r":[[1,3004]], "l":3003},
  "meta": {"b":0, "r":[[0,201]], "l":200},
  "deltas": {"s":"data", "r":[3005,3006,3007]},
  "seen":   {"s":"seen", "stem":441},
  "hsum":   {"s":"idx",  "stem":88, "covers":20},
  "ssum":   {"s":"meta", "stem":91, "covers":200},
  "next":   {"idx":89, "data":3012, "meta":206, "seen":442}
}
```

- A series row is **positional**: entry `i` names the object holding that series' `i`-th stride region, dense from `b` (invariant M5 — that density is what lets `floor(chron/stride)` index the list). `r` run-length encodes the stems (`[[firstStem, count], …]`) — stems are handed out in write order, so a pristine store's list is one run and a 1M-article store's three lists total ~120 bytes. `l` is the positional index of the **tail** entry, absent when the series has none.
- **Stems are opaque.** `idx/812.gz` means "idx-series object #812" and nothing more; `next` carries the per-series counter it came from, which is monotone and never reused (M3). That is what makes a rebuild or a compaction write NEW names beside the old ones instead of over them — and what retired `gen`, `gen --bump`, the CDN-purge WARNs and the service worker's purge-on-gen-change.
- Singletons carry their OWN series (`s`), so nothing hard-codes which directory a summary or a delta segment lives in. `deltas` is the ordered live chain; `seen` the dedup sidecar; `hsum`/`ssum` the idx header summary and the meta bloom summary, each with the finalized-pack count it `covers` — coverage rides NEXT to the name instead of inside it, so "the summary lags → fall back to eager idx loading" is a comparison of two numbers rather than a name-vs-count handshake.
- Series live in a MAP, and nothing anywhere assumes there are exactly three of them, that `idx` and `meta` are distinct, or that a stride is a particular number. Merging them (ARC6) stays a manifest-shape change and nothing else. **Reject any patch that hard-codes the three-series shape into a manifest parser.**

### `config.gz` — the backend-only configuration sidecar

Mutable, `no-cache`, at the store root next to `db.gz`. **The frontend and the service worker never fetch it**, exactly like the seen sidecar, and it is deliberately NOT in `PackSeries`.

```json
{"v":2,"recipes":{…},"out":[…],"dd":30,"feeds":{"42":{"recipe":"x","pipe":[…],"dd":7,"dt":true}}}
```

- `recipes` — the named `{ingest, pipe}` bundles (below). Always contains the reserved `default` entry; `NewDB` re-seeds it if absent.
- `dd` — the store-wide default dedup horizon in days (fallback for a feed whose own `dd` is 0; absent/0 ⇒ `defaultDedupDays` 30). A negative store default is invalid config — a per-feed `dd = -1` is the off switch. Managed via `srr dedup --days N`.
- `out` — the syndication slots (see CDN Layout → `out/`). Managed via `srr syndicate`.
- `feeds` — the per-feed config half (`FeedConfig`: `recipe`, `ingest`, `pipe`, `dd`, `dt`).

**Absence is legal**: a store with no `config.gz` behaves exactly as one whose configuration is all defaults. A PRESENT-but-corrupt one is a hard error — silently running a cycle with the default recipe when the operator configured something else would rewrite every article through the wrong pipeline. An entry for a feed the store does not have is **inert and ignored** (and swept at the next config write); that is what makes the two-object mutations safe without a distributed commit. It is written under its own advisory marker `.config.locked`, independent of the store-writer `.locked`, so config edits do not contend with a running fetch cycle (deadlock discipline: `.locked` first, `.config.locked` second, never the reverse).

### Feeds

**One feed = one source URL.** A feed SPLITS across the two objects, on one axis: **does the reader consume it?** — not "is it operator-authored" (`exp` is operator config and is nonetheless rendered by the reader's info card, so it stays public). `backend/feed_split.go` owns the split, and `TestFeedSplitCoversEveryWireField` fails if a field is missing from — or duplicated across — the two projections.

**Manifest half (`FeedPublic`, = the reader's `IFeedWire`)**: `{ title, url, wm?, ferr?, last_ok?, fail_streak?, last_new?, tag?, nt?, exp?, xp?, total_art, add_idx, cb?, ab? }`

`url` is the single source URL. `wm` (Watermark) is the max published unix-second ever seen — **reader-displayed** (the "Latest published" info card, `frontend/src/js/picker.ts`) and a partial dedup floor if the seen sidecar is ever lost. `ferr` is the last fetch error (empty when healthy); `last_ok`/`fail_streak`/`last_new` are the per-feed fetch-health vitals (unix-sec of the last successful fetch incl. 304 / consecutive-failure count / unix-sec of the last fetch that ingested a new article). `nt` (NoTitle) marks a titleless microblog-style feed — a reader-consumed contract flag (the frontend hides the article heading). Up to `feedIDCeiling` (65536) feeds — `feed_id` is a u16 in each idx entry.

`exp` (ExpireDays) is the per-feed retention window in days (0 = keep forever, max 36500) — each fetch cycle expires that feed's articles fetched longer ago: every `assets/…` object their content references is deleted (no liveness check by design — a shared asset dies too; content-hash re-upload and `srr asset heal --create` are the repair paths) and `add_idx` is bumped past them (logical deletion — packs and idx headers are immutable; entries below `add_idx` arise from expiration as well as feed id reuse). `xp` (Expired) is the cumulative expired-entry count: readers compute visible-before-pack-P as `header.feedCounts[f] − xp` once `add_idx < P.base` — per-feed `total_art` stays **all-time** because `writeIdxHeader` sources the immutable idx-header cumulative counts from it.

`cb` (ContentBytes) and `ab` (AssetBytes) are server-owned byte counters (the service worker ignores them; the reader only displays them): `cb` is the cumulative uncompressed JSONL bytes the feed's articles added to `data/` packs (bumped per article by `PutArticles`; never decreases — expiration is logical deletion, the pack bytes stay), `ab` is the live store footprint of the feed's self-hosted `assets/` objects — bumped by the stored payload size at the actual upload (content-hash dedup hits add nothing; a shared asset is charged to the feed whose fetch uploaded it first) and reduced, clamped at 0, when expiration deletes those objects (approximate for cross-feed shared assets). Surfaced read-only as `content_bytes`/`asset_bytes` in `feed ls/show/edit` and `GET /api/overview`, and as the reader info cards' "Stored content" / "Stored assets" rows.

**Config half (`FeedConfig`, in `config.gz`)**: `{ recipe?, ingest?, pipe?, dd?, dt? }` — never reader-read. `recipe` is the name of the `{ingest, pipe}` recipe this feed uses (empty or absent ⇒ `default`); `ingest`/`pipe` are the optional feed-level overrides on top of it (each axis wins over the recipe when set — see Recipes). `dd` (DedupDays) / `dt` (DedupTitle) tune the persistent dedup pool per feed (`dd`: 0 inherits the store default, >0 sets the horizon in days, -1 disables the pool for this feed; `dt` adds a folded-title dedup axis, gated by `!nt`).

**Neither half (`json:"-"`)**: `etag`/`last_modified` (the incremental-fetch HTTP validators) and `bg` (BoundaryGUIDs, the FNV-32a hash array used for dedup, capped at 1024 entries — `maxBoundaryGUIDs` in `backend/feed.go` — so one misbehaving feed can't bloat the sidecar). All three live in the backend-only **seen sidecar** (CDN Layout below), hydrated onto the in-memory feed at load and written back after each fetch.

That split is what `docs/STORE-VISIBILITY.md` called the "leak-shrinker", and the cutover took it: a public store still exposes the subscription list, per-feed health and the newest titles, but **no longer** exposes recipes, per-feed ingest/pipe commands, dedup tuning, or the syndication slot list.

### Recipes

Processing config lives in named `{ingest, pipe}` recipes in db.gz (`recipes` map),
referenced by feeds via the `recipe` field. The reserved `default` recipe (always
present, seeded `["#sanitize","#minify"]`) is the fallback.

- A feed with empty/absent `recipe` resolves to `default`.
- Each axis falls back to `default` independently: a recipe that sets only `ingest`
  uses its own ingest and `default`'s pipe; only `pipe` ⇒ its pipe and `default`'s ingest.
- A feed may additionally carry its own `ingest`/`pipe` overrides on top of its
  recipe, again per axis: set, the feed's value wins; empty, it inherits the recipe's.
- `#default` expands inline to the next pipe down the chain: inside a recipe's pipe,
  the `default` recipe's pipe; inside a feed's pipe, the feed's effective recipe pipe.
  The `default` recipe forbids `#default` (it is the default); a feed pipe always allows it.
- Built-in mods use `#` (`#sanitize`, `#minify`, `#readability`, `#filter`, `#dedupmedia`,
  `#unlazy`, `#embed`, `#enclosure`, `#untrack`, `#selfhost`); anything else is a shell
  command. Ingest: built-in `#feed`, or a shell command.
- Resolution: `pipe = resolvePipe(resolvePipe(default.Pipe, recipe.Pipe), feed.Pipe)`,
  `ingest = ingest.Select(feed.Ingest, recipe.Ingest, default.Ingest)` (first non-empty wins).
- Managed via `srr recipe set/ls/show/rm`; feed-level overrides via
  `srr feed add/upd -i/-p`. Clean break, amended: a pre-recipes db.gz still drops its
  legacy root `pipe`/`ingest` on load, but the legacy feed-level keys are the same keys
  the overrides use today and revive as such (deliberate — same per-feed meaning).

`feeds` is a JSON object (`Record<number, IFeed>`) keyed by feed ID. Backend struct: `Feed` carries `URL` + its own fetch state directly. JSON uses short keys (`url`, `wm`, `ferr`, `dd`, `dt`, `recipe`, …) — see the `Feed`/`DBCore` struct tags. `ETag`/`LastModified`/`BoundaryGUIDs` are `json:"-"` (in-memory only; persisted in `seen.gz`, not db.gz).

### Pack Storage

Three gzip-compressed series (plus a fourth derived one), every object named by an opaque stem the manifest lists. The hot tail additionally rides **delta segments** — one per article-producing cycle, plain data-pack JSONL of that batch, drawn from the `data` series' own counter and listed under `names.deltas` — consolidated into fresh tail packs lazily (`docs/DELTA-TAIL-SPEC.md`):

| Series | Format | Split rule |
|---|---|---|
| `idx/` | Binary (see below) | Every 50,000 articles (`idxPackSize`) |
| `data/` | JSONL — one `ArticleData` object per line (`{f,a,p,t,l,c,g}`) | At `PackSize` (the tail's position is `next_pid`, its fill `pack_off`) |
| `meta/` | JSONL `{f,w,t}` cards (+ bloom header for finalized shards) — derived projection of `data/` | Every 5,000 articles (`metaPackSize`, a divisor of `idxPackSize`) |

**idx/ format** — binary, little-endian. Each idx pack is `header ‖ entries ‖ footer`:
- Header: **variable-length** — a fixed `idxHeaderPrefix` (12 bytes = 3 × uint32: `packId_base`, `packOff_base`, `numSlots`), then `numSlots` cumulative-count uint32s (one per feed_id `0..numSlots-1`). `numSlots` = (max feed_id present in packs `[0, P)`) + 1 at the time pack P was written — dense up to the high-water id, ceiling-agnostic. A feed added after a finalized pack was written is simply absent from it, and every reader treats `feedCount[id]` for `id ≥ numSlots` as **0** (bounds-guarded — not native OOB).
- Entries (**2 bytes each**, after header): `feed_id:u16 LE` (low byte then high byte). `feed_id` is a uint16, so ids run [0, 65536) (`feedIDCeiling`).
- Footer (after the entries): the **data-pack boundary list** — a u16 LE (`idxBoundarySize`) for each local entry index at which the data packId advances by 1 (offset resets to 0). Ascending; its length is implicit (`bytes − header − packSize*2`). The reader rebuilds the chronIdx→data-pack `bounds` from `packId_base`/`packOff_base` + this list. (Pre-2026-06-17 the boundary rode a per-entry `delta_pack_id` bit alongside a now-removed `delta_fetched_at`; the footer is its replacement.)

**data/ format** — JSONL, each line: `{"f":feed_id,"a":fetched_at,"p":published,"t":"title","l":"link","c":"content","g":"lang"}`

Short keys: `f`=feed_id, `a`=fetched_at, `p`=published (unix seconds, omitted if 0), `t`=title (omitted if empty), `l`=link (omitted if empty), `c`=content, `g`=lang (ISO 639-1 code from the fetch pipeline's fail-open detection, omitted if empty — absent means "unknown", including every article written before 2026-07-19). Contains all article info.

**meta/ format** — a derived projection of `data/` at a finer stride (5,000 entries vs data/'s byte-based split). A FINALIZED shard = `gzip(bloom[4096 bytes] ‖ JSONL)`; the TAIL shard (the last position, `names.meta.l`) = `gzip(JSONL only, no bloom)`. Each JSONL line is a `MetaEntry`: `{"f":feed_id,"w":when,"t":"title"}` where `w` is published falling back to fetched_at (precomputed for display), `t` is omitempty. Line position within the shard equals the chron offset within that shard (`chron mod metaPackSize`). Meta bloom: per-word rune trigrams of folded titles; FNV-1a-64 → double-hash `h1=low32, h2=high32|1`, 7 probes `(h1+i*h2) & (2^15-1)` (`searchBloomBytes`=4096 → 32768=2^15 bits), little-endian bit order. Folding (`foldSearchText`/`fold`): NFD → strip `Mn` marks → per-rune lowercase → ς→σ → non-letter/non-number = word separator, single-space joined; mirrored byte-for-byte between Go and TypeScript. The bloom **summary** (`names.ssum`) = gzip concatenation of the `covers` finalized blooms, for shard pruning. Format atoms exported to TS: `SEARCH_GRAM`=3, `SEARCH_BLOOM_BYTES`=4096, `SEARCH_BLOOM_K`=7, `META_PACK_SIZE`=5000. The meta/ series is built post-hoc by warn-only `SyncMeta` (identical philosophy to `SyncIdxSummary`); it is consumed by BOTH the home list (`data.ts loadMeta`, which falls back to reading `data/` when `metaReady()` is false) and search (`search.ts`), so a warn-only failure only degrades list-read performance (falls back to data/ packs) and disables search — it never corrupts or loses articles.

### CDN Layout / Pack Addressing

Store root: `db.gz` + `config.gz` + `manifest/` + `idx/` + `data/` + `meta/` + `seen/` (+ optional `assets/`, `out/`, `inbox/`).

**Store visibility — public OR private, the operator's choice** (`docs/STORE-VISIBILITY.md`): SRR supports both and the operator decides per deployment. **Public** means accepting that `curl db.gz` → `curl manifest/<m>.gz` exposes the subscription list, per-feed health, the `head` titles — and that object names are enumerable from the manifest by construction, so article content is readable by anyone who can read the root. It no longer exposes the processing config: recipes, ingest/pipe, dedup tuning and the syndication slots moved to `config.gz`, which no reader fetches (the leak-shrinker that document named, taken at the manifest cutover). **Private** means fronting the store origin with an auth layer (e.g. Cloudflare Access service tokens: the HTTP backend already carries credential headers, and the reader's sync layer demonstrates credentialed fetches). The production store (`cdn.llera.eu`) stays **public by explicit choice**.

- **Edge cache (production deployment fact)**: the prod store's CDN host (`cdn.llera.eu`, an R2 custom domain) carries a Cloudflare Cache Rule that edge-caches the immutable prefixes with `edge_ttl: respect_origin` — the origin's `max-age=31536000, immutable` (stamped by `cacheControlForKey`) drives a year-long edge TTL, while 404s (no Cache-Control) only get Cloudflare's short default negative-cache. `db.gz`/`config.gz`/`out/` match no immutable prefix and stay uncached (plus an explicit db.gz bypass rule). ⚠ **The rule must cover `/manifest/` and `/seen/` alongside `/idx/ /data/ /meta/ /assets/`** — the manifest is the object every reader fetches on every change and the one the edge cache now buys the most on.
  **There is no purge discipline any more.** It existed because a rebuild reused finalized names with new bytes; names are never reused now, so a rebuild writes fresh stems and the edge simply never holds a stale copy of anything. `gen`, `srr gen --bump`, both purge WARNs and the service worker's purge-on-gen-change are all gone with it. (`srr asset heal` still overwrites an `assets/` key in place and still warns — that path is unchanged and gets its fresh-name treatment when compaction lands.)

- **`manifest/`**: the immutable generation manifests (above). Write-once, `cacheImmutable`. The reader fetches exactly one per adopted generation, `force-cache`; the service worker caches them like any other listed object.
- **`seen/`**: the persistent-dedup + fetch-cache sidecar, one immutable object per dirty cycle, named by `names.seen`. Each gzip blob holds a binary dedup section (`(feed_id, guid_or_folded-title-hash) → when_seen` as unix-day, columnar so gzip RLEs the non-hash columns) plus a per-feed section carrying each feed's `etag`/`last_modified`/`bg` — the three fields kept out of the hot path. It catches **re-promotion duplicates** — a feed re-publishing an old item with a fresh `pubDate` but a stable `<guid>` that has aged out of the small `bg` snapshot, which neither `wm` (the re-dated pub sits above it) nor `bg` can suppress. `SyncSeen` writes a FRESH stem and records it; the manifest that names it is published by the same Commit as the article batch, so the batch and the dedup state that produced it become durable together — no flag, no slot arithmetic, no ping/pong (the pre-cutover mechanism, retired). A missing/corrupt object degrades to `wm`-only dedup for one cycle, never an article loss. Age-bounded (per-feed horizon `dd`, default 30d) with a per-feed flood cap (`seenFeedCap` 4096) and dead-feed purge in `evict`. The frontend/service-worker **never fetch it**. Per-feed knobs `srr feed add|upd --dedup-days N --dedup-title`; store default `srr dedup --days N`. See `backend/SEEN-POOL-PLAN.md`.
- **`inbox/`**: producer fetch spools — **a transient backend-only mutable class** (`docs/INBOX-SPEC.md`). The inbox pattern splits fetch **egress** from the single writer: a producer box runs `srr art fetch --spool [--spool-name N] --tag X` with the DB open **read-only and no lock**, and publishes one cycle as `inbox/<name>.gz` (gzipped JSON envelope `{producer, cycle_id, feeds:[{id, url, state, stamps, items}]}`). A **single slot per producer** IS the backpressure: an undrained slot makes the producer skip its cycle, so its read-only dedup view is never more than one cycle stale. The lock-holding consolidator (`--inbox-producers`) drains present slots into its own batch, skipping any `cycle_id <= inbox[name]`, discarding records whose `url` no longer matches the live feed, and `Rm`-ing the slots **after** the root flip. The envelope carries item fields, **not** pre-encoded data lines, so the consolidator stamps its own `fetched_at` and the batch stays chron-monotone (what `ExpireArticles`' contiguous-prefix model and `art ls --since`'s binary search need). `no-cache` + `application/gzip`; deliberately NOT in `PackSeries` — never immutable, never reader-fetched.
- **`out/`**: syndication output feeds — a mutable object class. Each `out/<name>.rss` (RSS 2.0) or `out/<name>.json` (JSON Feed 1.1) is a rolling newest-N window overwritten on every fetch cycle. `no-cache`. Written by `SyncOutFeeds` (after `SyncMeta` and `ExpireArticles`, before the root flip; warn-only). Expired articles are excluded (the newest-N walk filters `chron < add_idx`) and an expiration advance alone rewrites the outputs (`outFeedsSig` includes each feed's `add_idx`) — the same cycle's syndication never re-serves what just expired. Requires `SRR_CDN_URL`; off by default. Asset/media refs in item content are rewritten to absolute CDN URLs. Not in `PackSeries` — never treated as immutable. Config lives in `config.gz`; managed via `srr syndicate`.
- **Self-hosted frontend shell (`srr frontend update`)**: the reader SPA can be hosted from the store root itself, so one static origin serves both the reader and the packs. `srr frontend update` downloads the latest `srrf.tar.gz` release asset from GitHub (`--repo`, default `gllera/srr`; `--tag` to pin) and uploads its flat files — `index.html`, content-hashed `frontend.<hash>.{js,css}`, `sw.<hash>.js`, icons, `manifest.webmanifest` — into the store root next to `db.gz`. A `sitemap.txt` manifest at the store root tracks the uploaded keys: it is written as a **superset** (old ∪ new) *before* any upload and rewritten to the live set (new ∪ failed-deletes) *after* cleanup, so the manifest is always a superset of the files actually present — a crash or error anywhere leaves **no dangling files**. Mutable Cache-Control like db.gz/out: `index.html`/`manifest.webmanifest`/`sitemap.txt` revalidate while the content-hashed assets are immutable (`cacheControlForKey`, S3 only). The published bundle is built with **no** `cdn-url`, so its pack base resolves **relative** to its own `index.html` (`PACK_BASE = new URL(".", location)`). Built + attached as `srrf.tar.gz` by `release.yml`. Backend-only; not part of the writer↔reader pack contract. ⚠ Note the name collision in the store root: `manifest.webmanifest` (the PWA manifest) is unrelated to the `manifest/` series.
- **`assets/`**: self-hosted files (images, video, linked documents). Keys are `assets/<2-hex>/<16-hex><ext>`, the hash being sha256 of the **file bytes**: an external ingest command downloads files into the run's shared ingest cache and marks them in content with a `#`-prefixed relative path; SRR's automatic end-of-pipeline step uploads them via `assetFetcher.UploadCacheRef` and rewrites the marker to the key. Article content stores the **relative** key; the frontend (`fmt.ts`) resolves `<img src>`/`<video src>`/`<video poster>`/`<audio src>`/`<a href>` against the pack base. The content hash is stable for given bytes ⇒ safe to cache. Not a manifest-named series — a content hash IS its own name. See `backend/CLAUDE.md` → Asset self-hosting and Ingest.
- **Every idx/data/meta object is immutable and write-once**, finalized and tail alike. A stem is drawn from a per-series monotone counter and never reused, so the reader fetches **every** one of them with `cache: "force-cache"`; only `db.gz` (and the backend-only `config.gz`/`out/`) is mutable. Finalized names are published with zopfli-grade deflate (`savePackFinal`/`gzipBest` in `db_pack.go`) — still plain RFC 1952 gzip to readers, just smaller; tail packs, summaries, manifests and the root use fast stdlib gzip.
- **GC is ONE rule**: delete what the last `K` manifests do not name (`--keep-manifests`, default 32). It replaced `GCLatest`, `GCSummaries`, `GCMetaSummaries`, the `db/` snapshot sweep and their four window formulas. Without a store `List` the sweep is a **low-water drain** on `gcm`: it clears `(gcm, m−K]` and advances only over generations actually cleared, so a missed or failed warn-only run strands nothing and the next run resumes exactly where it stopped (bounded per run by `gcMaxSweep`). The reachable set costs ONE extra manifest read, not K, because opaque stems make an object's liveness a CONTIGUOUS interval: anything a swept generation names that is still live must also be named by the OLDEST manifest in the window. A reader that 404s on a name it holds self-heals with one guarded reload (`data.ts assertPackOk`). The service worker mirrors the same rule exactly — on adopting manifest `m` it evicts every cached object named by neither `m` nor the previously-adopted generation — which is exact where the retired scheme was approximate and needed the writer's runtime `--max-deltas`.
- **`db/` snapshots are retired.** A manifest IS the snapshot, one per generation rather than one per consolidation, and reachable through K generations rather than a separate sweep window. **Restore = write `{"v":3,"m":<older>}` over `db.gz`** — a ~20-byte edit repointing the store at a known-good generation whose objects are guaranteed present (that is what K buys). Strictly better than the old `cp db/12.gz db.gz`, which could name objects the GC had already swept. There is deliberately no `srr restore` verb.
- **Positions, not names**: `numFinalizedIdx = total_art > 0 ? floor((total_art − 1) / 50000) : 0`, `numFinalizedMeta = total_art > 0 ? floor((total_art − 1) / 5000) : 0`, and the data tail sits at position `next_pid`. These are *chron → position* arithmetic and nothing more; they stopped being name generators at the cutover, and that distinction is the ARC6 door.

**chronIdx** — global 0-based article index across all idx packs:
- Finalized packs: `chronIdx = pack * 50000 + pos` (0-indexed); the tail pack: `numFinalized * 50000 + pos`
- Each finalized pack = exactly 50,000 entries; the tail = `total_art - numFinalized * 50000`
- Invalid chronIdx clamps to `total_art - 1` (last, not first)
- **chronIdx is a permanent address** (invariant M8): no generation may renumber chrons. Device-local state (`srr-seen` frontiers, the ★-Saved queue, shared `#pos` links, the cross-device sync blob) is keyed on it, so a rebuild or a future compaction may re-encode any object under a new name but must never move an article.

### File-Based Locking

Two independent advisory markers, both nil-payload files, both overridable with `--force`, both removed under `context.WithoutCancel` so a cancellation still releases them.

- `.locked` — the store writer. Held for a whole mutation (fetch cycle, feed/recipe/syndicate command, GUI save). Contention answers `os.ErrExist`, which serve maps to a 409.
- `.config.locked` — `config.gz` alone. Separate on purpose: a fetch cycle READS config and never writes it, so writer↔editor exclusion is not needed for correctness and config edits stop 409ing a running cycle. It serializes editor↔editor only. **Deadlock discipline: a mutation touching both takes `.locked` FIRST and `.config.locked` SECOND, never the reverse.**

A SIGKILL leaves the marker behind and the next run needs `--force` (an open finding, unchanged by the cutover).

### Operating the format cutover (2026-07-21)

**One-way door.** Once a store's root is v3, no earlier binary can open it — `NewDB` hard-errors on a higher `v` by design, because an old binary would silently drop every field it does not know on its next Commit. Binary rollback alone is therefore NOT a recovery path, and the retired `db/` snapshot series is not the artifact it used to be. What follows replaces it.

**Pre-flight, before the first v3 binary touches a store:**

1. Stop the writer (`systemctl --user stop srr-fetch` on the box that holds the lock) so nothing commits mid-capture.
2. Capture the pre-cutover root and its sidecars — this is the rollback artifact, and it is small:
   `aws s3 cp s3://srr/db.gz ./rollback/db.gz` (plus `config.gz`, `seen.0.gz`, `seen.1.gz` if present). A local store: `cp db.gz config.gz seen.*.gz ./rollback/`.
   That legacy `db.gz` names the pre-cutover objects — the `L<g>` tails, the `d<g>` segments, the `h<N>`/`s<N>` summaries — and the migration does not delete any of them (it COPIES them to fresh stems), so it stays a complete description of a working store for as long as the GC's K-generation window keeps them.
3. Note the current `m` (`python3 -c "import gzip,json;print(json.load(gzip.open('db.gz'))['m'])"`). Manifests at or below it are the pre-cutover chain.
4. Deploy the reader FIRST (CF Pages + `srr frontend update` — the operator runs that, never an agent). A reader older than this release stops at the root with "This reader is older than the store (format v3, supported v2) — reload to update." That is the designed failure and it is legible, but it IS user-visible until every client reloads.

**Rolling back:**

- **Within the store, forward-safe (the normal case — a bad commit, not a bad release):** write a pointer at an older generation. `printf '{"v":3,"m":<older>}' | gzip -c > db.gz` and upload it. Every object that generation names is guaranteed present while it is inside the K window (`--keep-manifests`, default 32 ≈ 2.5 h at a 5-min loop), which is exactly what K buys. There is deliberately no `srr restore` verb.
- **Back to the pre-cutover binary:** restore the captured `db.gz` (+ `config.gz`, `seen.*.gz`) over the store's. The pre-cutover objects it names are still there, so the old binary resumes on them. Everything the v3 binary published after the cutover — the fresh-stem copies and every manifest above the noted `m` — becomes unreferenced garbage that the old GC will not sweep (it does not know those names); delete `manifest/` above the noted `m` by hand if the clutter matters. **This works only while the pre-cutover tails/segments still exist**, i.e. before K generations of v3 commits have passed and the new GC has reclaimed them. After that, rolling the binary back means rebuilding the store, not restoring it.
- The window above is the honest cost of the one-way door, and it is why the pre-flight capture and the reader-first deploy are not optional.
