# CLAUDE.md

## Project

**SRR** — Static RSS Reader. Monorepo with two subprojects:

- **`backend/`** — Backend. Go CLI that fetches RSS/Atom/RDF feeds into gzip-compressed pack series. Backends: local filesystem, S3, SFTP.
- **`frontend/`** — Frontend. Single-page reader. Zero runtime deps. Parcel + TypeScript + plain CSS.

## Commands

All commands run from the repo root via `make`:

| Command | What it does |
|---|---|
| `make verify` | Full check: lint + format + test + build (both projects) + e2e contract layer |
| `make verify-fe` | Frontend pipeline only |
| `make verify-be` | Backend pipeline only |
| `make test-fe` | Frontend unit tests |
| `make test-be` | Backend unit tests |
| `make test-contract` | E2e contract layer: real `srrb` packs → real `idx.ts`/`data.ts`/`nav.ts` (jsdom, fast; in `verify`) |
| `make test-browser` | E2e browser layer: real built SPA in headless Chrome over real packs (Puppeteer; opt-in) |
| `make test-e2e` | Both e2e layers — the writer↔reader contract. Suite lives in `frontend/e2e/` |
| `make test-stress` | Large-store (>50k) stress/perf layer: real `srrb` output → real `idx`/`data`/`nav`/`search`, measuring navigation/filtering/query at scale (jsdom; opt-in, NOT in `verify`; generates or reuses a synthetic store via `genbig_test.go`, tune with `SRR_STRESS_N`/`SRR_STRESS_STORE`). Suite in `frontend/e2e/stress/` |
| `make lint-fe` | ESLint |
| `make format-fe` | Prettier write |
| `make format-check-fe` | Prettier check only |
| `make dev-fe` | Frontend dev server |
| `make build-fe` | Production frontend build (auto `npm ci` if `node_modules` is stale) |
| `make build-be` | Go build |
| `make vet-be` | Go vet |
| `make format-be` | `gofmt -w` the backend |
| `make format-check-be` | gofmt check only (fails on unformatted Go; runs inside `verify-be`) |
| `make lint-be` | golangci-lint (opt-in; not in `verify-be` — pre-existing findings) |
| `make generate` | Regenerate `frontend/src/js/format.gen.ts` from the backend Go declarations (`srr gen-ts`) |
| `make generate-check` | Fail if `format.gen.ts` is stale (runs inside `verify-be`) |
| `make release` | Cross-compile backend for all platforms (requires `VERSION=`) |
| `make clean` | Remove build artifacts |

## Data Contract

Shared format between backend (writer) and frontend (reader).

**Single source of truth**: the Go declarations — the format constants in `backend/db.go` (`idxPackSize`, `idxHeaderPrefix`, `idxEntrySize`, `idxBoundarySize`, `feedIDCeiling`, …), the write-once pack-name grammar `store.PackSeries` in `backend/store/main.go` (series → valid kind letters; builds the store's `packKeyRe` and, via the generated `PACK_SERIES_KINDS`, the service worker's route regex), and the JSON struct tags of `ArticleData`/`Feed`/`DBCore`. The TS side consumes them through the generated `frontend/src/js/format.gen.ts` (constants + grammar table + wire interfaces; emitted by the hidden `srr gen-ts` command, regenerated via `make generate`, freshness-checked by `make verify`). The backend's only read-side idx parser is `backend/idx_read.go`, a byte-for-byte mirror of `frontend/src/js/idx.ts`. This section documents the format; the code above defines it.

### `db.gz`

```
{ seq?, fetched_at, total_art, next_pid, pack_off, feeds{}, pipe?, ingest?, gen?, hdrs?, mp?, mt?, out? }
```

| Field | Type | Description |
|---|---|---|
| `seq` | int | Latest-pack generation: the current latest packs are `idx/L<seq>.gz` and `data/L<seq>.gz` (both series share one generation). Write-once names — a generation is never rewritten after the db.gz commit that publishes it; each article-producing `PutArticles` batch writes generation `seq+1` then bumps. `omitempty`; absent == 0 == empty store (first batch publishes generation 1). |
| `fetched_at` | int | Unix timestamp of last fetch |
| `total_art` | int | Total article count across all packs |
| `next_pid` | int | Next data pack ID; packs with `id < next_pid` are finalized/immutable |
| `pack_off` | int | Current offset in latest data pack |
| `feeds` | object | JSON object keyed by feed ID (number); may be `null` in JSON (default `{}`) |
| `pipe` | string[] | Root-level default pipeline inherited by feeds whose `pipe` is absent. `omitempty`. If absent at load, `NewDB` substitutes `["#sanitize", "#minify"]`. |
| `ingest` | string | Root-level default ingest strategy inherited by feeds whose `ingest` is empty. `omitempty`. Empty falls through to built-in `#rss`. Set/print via `srr ingest`. |
| `gen` | int | Store generation counter. Bumped manually (`srr gen --bump`) after an in-place store rebuild reuses finalized pack ids with new bytes; the frontend service worker purges its cache-first pack cache when the value changes (any change, not just increments). `omitempty`; absent == 0. |
| `hdrs` | int | Idx header-summary coverage: `idx/h<hdrs>.gz` holds the verbatim variable-length headers of finalized idx packs `0..hdrs-1` (each is `idxHeaderPrefix + numSlots*4` bytes; concatenated, so the summary is parsed by a sequential variable-stride walk). Maintained by `SyncIdxSummary` each fetch (write summary first, publish `hdrs` via Commit — same crash argument as `seq`); `srr gen --bump` resets it to 0 so the next fetch rebuilds against the rebuilt packs. The reader uses the summary only when `hdrs == numFinalized`, else falls back to eager idx loading. `omitempty`; absent == 0. |
| `mp` | int | Finalized meta-shard coverage (`MetaPacks`): `meta/<n>.gz` exists for n in `[0, mp)` and `meta/s<mp>.gz` concatenates their bloom headers. Set only after every save succeeds (same crash argument as `seq`/`hdrs`); `srr gen --bump` resets to 0. The reader offers search and list-from-meta only when `metaReady()` is true (`mp === numFinalizedMeta` and `mp * metaPackSize + mt === total_art`). `omitempty`; absent == 0. |
| `mt` | int | Entry count of the published latest meta shard (`meta/L<seq>.gz`, `MetaTail`). `SyncMeta` trusts a read-back tail only when its entry count matches, so a stale shard from a crash or post-`gen --bump` store is rebuilt from data packs rather than extended. `omitempty`; absent == 0. |
| `out` | OutFeed[] | Named syndication output feeds written by `SyncOutFeeds` during each fetch cycle. Each entry maps chosen tags/feed ids to one `out/<name>.rss` (RSS 2.0) or `out/<name>.json` (JSON Feed 1.1) file. Off by default (absent/null → no-op). Requires `SRR_CDN_URL` to be set; skipped with a warning when unset. Managed via `srr syndicate`. `omitempty`; absent == no syndication. The `IOutFeedWire` TS type is generated but **the frontend/service-worker ignores the `out` field entirely** — it is backend-only config. |

### Feeds (`IFeed`)

**One feed = one source URL.** All fields are flat on the feed:

`{ id, title, url, etag?, last_modified?, wm?, bg?, ferr?, total_art, add_idx, pipe?:string[], ingest?, tag? }`

`url` is the single source URL. `wm` (Watermark) is the max published unix-second ever seen; `bg` (BoundaryGUIDs) is the FNV-32a hash array used for dedup, capped at 1024 entries (`maxBoundaryGUIDs` in `backend/feed.go`); `etag`/`last_modified` are the incremental-fetch HTTP validators; `ferr` is the last fetch error (empty when healthy). The `Feed` type was removed (2026-06-17): re-importing OPML now yields one feed per `xmlUrl` rather than merging several under one id. Up to `feedIDCeiling` (65536) feeds — `feed_id` is a u16 in each idx entry.

### Pipe Hierarchy

Two levels store an optional mod pipeline (`pipe` field): db.gz root and feed. Resolution walks root → feed:

- An empty feed `pipe` (nil/absent or empty slice) **inherits** root.
- A non-empty feed `pipe` **overrides** root.
- The `#base` token inside a feed override expands inline to the root pipe; non-token entries pass through verbatim.
- Built-in mods use the `#` prefix (`#sanitize`, `#minify`, `#readability`, `#filter`); anything else is a shell command (see backend `mod/` docs).
- When the loaded root `pipe` is nil/absent, `NewDB` substitutes `["#sanitize", "#minify"]` as the default; the value is persisted on the next `Commit`. Clearing root or feed pipe (`srr pipe ""` / `srr feed upd <id> -p ""`) reverts to inherit-root semantics on the next load.

`feeds` is a JSON object (`Record<number, IFeed>`) keyed by feed ID. Backend struct: `Feed` carries `URL` + its own fetch state directly. JSON uses short keys (`url`, `etag`, `last_modified`, `wm`, `bg`, `ferr`, `pipe`, `ingest`, …) — see the `Feed`/`DBCore` struct tags.

### Pack Storage

Three gzip-compressed series under the feed directory (plus a fourth derived series):

| Series | Format | Split rule |
|---|---|---|
| `idx/` | Binary (see below) | Every 50,000 articles (`idxPackSize`) |
| `data/` | JSONL — one `ArticleData` object per line (`{f,a,p,t,l,c}`) | At `PackSize` (tracked by `next_pid`/`pack_off`) |
| `meta/` | JSONL `{f,w,t}` cards (+ bloom header for finalized shards) — derived projection of `data/` | Every 5,000 articles (`metaPackSize`, a divisor of `idxPackSize`) |

**idx/ format** — binary, little-endian. Each idx pack is `header ‖ entries ‖ footer`:
- Header: **variable-length** — a fixed `idxHeaderPrefix` (12 bytes = 3 × uint32: `packId_base`, `packOff_base`, `numSlots`), then `numSlots` cumulative-count uint32s (one per feed_id `0..numSlots-1`). `numSlots` = (max feed_id present in packs `[0, P)`) + 1 at the time pack P was written — dense up to the high-water id, ceiling-agnostic. A feed added after a finalized pack was written is simply absent from it, and every reader treats `feedCount[id]` for `id ≥ numSlots` as **0** (bounds-guarded — not native OOB).
- Entries (**2 bytes each**, after header): `feed_id:u16 LE` (low byte then high byte). `feed_id` is a uint16, so ids run [0, 65536) (`feedIDCeiling`).
- Footer (after the entries): the **data-pack boundary list** — a u16 LE (`idxBoundarySize`) for each local entry index at which the data packId advances by 1 (offset resets to 0). Ascending; its length is implicit (`bytes − header − packSize*2`). The reader rebuilds the chronIdx→data-pack `bounds` from `packId_base`/`packOff_base` + this list. (Pre-2026-06-17 the boundary rode a per-entry `delta_pack_id` bit alongside a now-removed `delta_fetched_at`; the footer is its replacement.)

**data/ format** — JSONL, each line: `{"f":feed_id,"a":fetched_at,"p":published,"t":"title","l":"link","c":"content"}`

Short keys: `f`=feed_id, `a`=fetched_at, `p`=published (unix seconds, omitted if 0), `t`=title (omitted if empty), `l`=link (omitted if empty), `c`=content. Contains all article info.

**meta/ format** — a derived projection of `data/` at a finer stride (5,000 entries vs data/'s byte-based split). Finalized shard `meta/<n>.gz` = `gzip(bloom[4096 bytes] ‖ JSONL)`; latest shard `meta/L<seq>.gz` = `gzip(JSONL only, no bloom)`. Each JSONL line is a `MetaEntry`: `{"f":feed_id,"w":when,"t":"title"}` where `w` is published falling back to fetched_at (precomputed for display), `t` is omitempty. Line position within the shard equals the chron offset within that shard (`chron mod metaPackSize`). Meta bloom: per-word rune trigrams of folded titles; FNV-1a-64 → double-hash `h1=low32, h2=high32|1`, 7 probes `(h1+i*h2) & (2^15-1)` (`searchBloomBytes`=4096 → 32768=2^15 bits), little-endian bit order. Folding (`foldSearchText`/`fold`): NFD → strip `Mn` marks → per-rune lowercase → ς→σ → non-letter/non-number = word separator, single-space joined; mirrored byte-for-byte between Go and TypeScript. `meta/s<N>.gz` = gzip concatenation of the N finalized blooms (summary for shard pruning). Format atoms exported to TS: `SEARCH_GRAM`=3, `SEARCH_BLOOM_BYTES`=4096, `SEARCH_BLOOM_K`=7, `META_PACK_SIZE`=5000. The meta/ series is built post-hoc by warn-only `SyncMeta` (identical philosophy to `SyncIdxSummary`); it is consumed by BOTH the home list (`data.ts loadMeta`, which falls back to reading `data/` when `metaReady()` is false) and search (`search.ts`), so a warn-only failure only degrades list-read performance (falls back to data/ packs) and disables search — it never corrupts or loses articles. Design rationale: `docs/search-design.md`.

### CDN Layout / Pack Addressing

Each feed directory: `db.gz` + `idx/` + `data/` + `meta/` (+ optional `assets/`).

- **`out/`**: syndication output feeds — **the ONE documented mutable object class besides `db.gz`**. Each `out/<name>.rss` (RSS 2.0) or `out/<name>.json` (JSON Feed 1.1) is a rolling newest-N window overwritten on every fetch cycle. Cache-Control: `no-cache, must-revalidate` (same as `db.gz`). Written by `SyncOutFeeds` (after `SyncMeta`, before `Commit`; warn-only). Requires `SRR_CDN_URL`; off by default. Asset/media refs in item content are rewritten to absolute CDN URLs. Not in `PackSeries`/`packKeyRe` — never treated as immutable. Managed via `srr syndicate`.
- **`assets/`**: self-hosted files (images, video, linked documents). Keys are `assets/<2-hex>/<16-hex><ext>`, the hash being sha256 of the **file bytes**: an external ingest command downloads files into the run's shared ingest cache and marks them in content with a `#`-prefixed relative path; SRR's automatic end-of-pipeline step uploads them via `assetFetcher.UploadCacheRef` and rewrites the marker to the key. Article content stores the **relative** key; the frontend (`fmt.ts`) resolves `<img src>`/`<video src>`/`<a href>` against the pack base. The content hash is stable for given bytes ⇒ safe to cache. See `backend/CLAUDE.md` → Asset self-hosting and Ingest.
- **Finalized packs**: immutable. `idx/` packs are 0-indexed (`idx/0.gz`..`idx/N-1.gz`); `data/` packs start at id `1` (`data/1.gz`..) — the writer increments `next_pid` before writing the first entry, so `data/0.gz` is never produced. Finalized names (idx, data, meta shards) are published with zopfli-grade deflate (`savePackFinal`/`gzipBest` in `db_pack.go`) — still plain RFC 1952 gzip to readers, just smaller; latest packs, summaries, and db.gz use fast stdlib gzip.
- **Latest pack**: `L<seq>.gz` (generation named by `seq` in db.gz). Write-once like the finalized names, so the reader fetches **every** pack with `cache: "force-cache"`; only db.gz is mutable (`no-cache`). The backend GC keeps the current generation plus `latestKeep` (2) older ones as a grace window for stale-db.gz tabs and deletes the rest after each fetch commit; a reader that 404s on its latest pack self-heals with one guarded reload (`data.ts assertPackOk`).
- **Idx header summary**: `idx/h<N>.gz` (N = finalized idx pack count, named by `hdrs` in db.gz) — the gzip concatenation of the finalized packs' verbatim variable-length headers (each `idxHeaderPrefix + numSlots*4` bytes; readers walk it sequentially, reading each header's `numSlots` to find the next). Write-once name; the writer publishes a new one in the same cycle that finalizes a pack (and `GCSummaries` sweeps superseded names with the same grace window as `GCLatest`). The reader boots from db.gz + summary + latest idx pack only and fetches finalized idx packs lazily by chronIdx addressing; consecutive header deltas give per-pack feed counts, so filtered navigation skips packs without fetching them. When `hdrs` lags `numFinalized` (old backend, warn-only summary failure, post-`gen --bump` gap) or the summary 404s, the reader falls back to eagerly fetching all idx packs — correct, just heavier.
- **Meta shards**: `meta/<n>.gz` (finalized, 0-indexed, 5,000-aligned), `meta/L<seq>.gz` (latest tail, generation-named like `idx/data` latest packs), `meta/s<N>.gz` (bloom summary = gzip concatenation of N finalized blooms, named by `mp` in db.gz). `GCMetaSummaries` sweeps superseded `s<g>` names with the same grace window as `GCSummaries`. All meta pack names are write-once; the latest tail uses the same GC grace window as the idx/data latest packs. The list reads meta by `floor(chron/5000)` (the meta pack index for a given chronIdx).
- **Finalized idx count**: `total_art > 0 ? Math.floor((total_art - 1) / 50000) : 0`
- **Finalized meta count**: `total_art > 0 ? Math.floor((total_art - 1) / 5000) : 0`
- **Finalized data packs**: `id < next_pid`

**chronIdx** — global 0-based article index across all idx packs:
- Finalized packs: `chronIdx = pack * 50000 + pos` (0-indexed); latest pack: `numFinalized * 50000 + pos`
- Each finalized pack = exactly 50,000 entries; latest = `total_art - numFinalized * 50000`
- Invalid chronIdx clamps to `total_art - 1` (last, not first)

### File-Based Locking

`.locked` nil-payload marker file. `--force` flag overrides. Lock removal uses `context.WithoutCancel` to survive cancellation.
