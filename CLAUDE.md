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
| `make lint-fe` | ESLint |
| `make format-fe` | Prettier write |
| `make format-check-fe` | Prettier check only |
| `make dev-fe` | Frontend dev server |
| `make build-fe` | Production frontend build (auto `npm ci` if `node_modules` is stale) |
| `make build-be` | Go build |
| `make vet-be` | Go vet |
| `make release` | Cross-compile backend for all platforms (requires `VERSION=`) |
| `make clean` | Remove build artifacts |

## Data Contract

Shared format between backend (writer) and frontend (reader).

### `db.gz`

```
{ data_tog, fetched_at, total_art, next_pid, pack_off, channels{}, first_fetched, fetched_at_cur?, pipe?, ingest? }
```

| Field | Type | Description |
|---|---|---|
| `data_tog` | bool | Toggles latest pack filename (`true.gz`/`false.gz`); used for both `idx/` and `data/` latest packs |
| `fetched_at` | int | Unix timestamp of last fetch |
| `total_art` | int | Total article count across all packs |
| `next_pid` | int | Next data pack ID; packs with `id < next_pid` are finalized/immutable |
| `pack_off` | int | Current offset in latest data pack |
| `channels` | object | JSON object keyed by channel ID (number); may be `null` in JSON (default `{}`) |
| `first_fetched` | int | Unix timestamp of first fetch that produced articles. **Not** `omitempty` — always emitted (unlike the other optional db.gz fields), because the reader divides by it in `findChronForTimestamp` (frontend `data.ts`) and an absent key would decode to `undefined` → `NaN` |
| `fetched_at_cur` | int | Running idx-time cursor in 8-hour blocks since `first_fetched`; persists `prevFetchedTS` across `PutArticles` calls so per-entry `delta_fetched_at` reflects real elapsed time. `omitempty` |
| `pipe` | string[] | Root-level default pipeline inherited by channels whose `pipe` is absent. `omitempty`. If absent at load, `NewDB` substitutes `["#sanitize", "#minify"]`. |
| `ingest` | string | Root-level default ingest strategy inherited by channels whose `ingest` is empty. `omitempty`. Empty falls through to built-in `#rss`. Set/print via `srr ingest`. |

### Channels (`IChannel`)

`{ id, title, feeds:IFeed[], total_art, add_idx, pipe?:string[], tag? }`

Each `IFeed` is `{ url, ferr?, etag?, last_modified?, wm?, bg? }`. `wm` (Watermark) is the max published unix-second ever seen; `bg` (BoundaryGUIDs) is the FNV-32a hash array used for dedup. Multiple feeds merge under one `chan_id` so a channel is not bound to a single feed URL — useful when the 256-id ceiling matters or when several feeds form one logical channel. Per-feed state (incremental fetch headers, last error, dedup watermark) lives on the feed, not the channel.

### Pipe Hierarchy

Two levels store an optional mod pipeline (`pipe` field): db.gz root and channel. Resolution walks root → channel:

- An empty channel `pipe` (nil/absent or empty slice) **inherits** root.
- A non-empty channel `pipe` **overrides** root.
- The `#base` token inside a channel override expands inline to the root pipe; non-token entries pass through verbatim.
- Built-in mods use the `#` prefix (`#sanitize`, `#minify`, `#readability`); anything else is a shell command (see backend `mod/` docs).
- When the loaded root `pipe` is nil/absent, `NewDB` substitutes `["#sanitize", "#minify"]` as the default; the value is persisted on the next `Commit`. Clearing root or channel pipe (`srr pipe ""` / `srr chan upd <id> -p ""`) reverts to inherit-root semantics on the next load.

`channels` is a JSON object (`Record<number, IChannel>`) keyed by channel ID. Backend struct: `Channel` holds `Feeds []*Feed`. JSON uses short keys for per-feed state (`feeds`, `pipe`, `ferr`, `wm`, `bg`, etc.) — see `DBCore` struct tags.

### Pack Storage

Two gzip-compressed series under the feed directory:

| Series | Format | Split rule |
|---|---|---|
| `idx/` | Binary (see below) | Every 50,000 articles (`idxPackSize`) |
| `data/` | JSONL — one `ArticleData` object per line | At `PackSize` (tracked by `next_pid`/`pack_off`) |

**idx/ format** — binary, little-endian, timestamps in 8-hour blocks (÷28800 on write, ×28800 on read):
- Header: 259 × uint32 — `fetchedAt_base` (= `fetched_at_cur` at pack start, blocks since `first_fetched`), `packId_base`, `packOff_base`, then 256 chanCount values (one per possible chan_id byte)
- Entries (2 bytes each, after header): `chan_id:u8`, `delta_pack_id:1 << 7 | delta_fetched_at:7`
  - `delta_pack_id == 0` → same pack, offset++; `delta_pack_id == 1` → pack advances by 1, offset resets to 0
  - `delta_fetched_at` clamped to [0, 127]; excess carry rolls into subsequent entries
  - First entry of a batch carries the gap since the prior fetch (writer derives `prevFetchedTS = first_fetched/28800 + fetched_at_cur`)

**data/ format** — JSONL, each line: `{"s":chan_id,"a":fetched_at,"p":published,"t":"title","l":"link","c":"content"}`

Short keys: `s`=chan_id, `a`=fetched_at, `p`=published (unix seconds, omitted if 0), `t`=title (omitted if empty), `l`=link (omitted if empty), `c`=content. Contains all article info.

### CDN Layout / Pack Addressing

Each channel directory: `db.gz` + `idx/` + `data/` (+ optional `assets/`).

- **`assets/`**: self-hosted files (images, video, linked documents). Keys are `assets/<2-hex>/<16-hex><ext>`, the hash being sha256 of the **file bytes**: an external ingest command downloads files into the run's shared ingest cache and marks them in content with a `#`-prefixed relative path; SRR's automatic end-of-pipeline step uploads them via `assetFetcher.UploadCacheRef` and rewrites the marker to the key. Article content stores the **relative** key; the frontend (`fmt.ts`) resolves `<img src>`/`<video src>`/`<a href>` against the pack base. The content hash is stable for given bytes ⇒ safe to cache. See `backend/CLAUDE.md` → Asset self-hosting and Ingest.
- **Finalized packs**: immutable, fetched with `cache: "force-cache"`. `idx/` packs are 0-indexed (`idx/0.gz`..`idx/N-1.gz`); `data/` packs start at id `1` (`data/1.gz`..) — the writer increments `next_pid` before writing the first entry, so `data/0.gz` is never produced.
- **Latest pack**: `true.gz` or `false.gz` (toggled by `data_tog`)
- **Finalized idx count**: `total_art > 0 ? Math.floor((total_art - 1) / 50000) : 0`
- **Finalized data packs**: `id < next_pid`

**chronIdx** — global 0-based article index across all idx packs:
- Finalized packs: `chronIdx = pack * 50000 + pos` (0-indexed); latest pack: `numFinalized * 50000 + pos`
- Each finalized pack = exactly 50,000 entries; latest = `total_art - numFinalized * 50000`
- Invalid chronIdx clamps to `total_art - 1` (last, not first)

### File-Based Locking

`.locked` nil-payload marker file. `--force` flag overrides. Lock removal uses `context.WithoutCancel` to survive cancellation.
