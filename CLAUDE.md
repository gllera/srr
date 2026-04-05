# CLAUDE.md

## Project

**SRR** — Static RSS Reader. Monorepo with two subprojects:

- **`backend/`** — Backend. Go CLI that fetches RSS/Atom/RDF feeds into gzip-compressed pack series. Backends: local filesystem, S3, SFTP.
- **`frontend/`** — Frontend. Single-page reader. Zero runtime deps. Parcel + TypeScript + plain CSS.

## Commands

All commands run from the repo root via `make`:

| Command | What it does |
|---|---|
| `make install` | Install frontend dependencies (`npm ci`) |
| `make verify` | Full check: lint + format + test + build (both projects) |
| `make verify-fe` | Frontend pipeline only |
| `make verify-be` | Backend pipeline only |
| `make test-fe` | Frontend unit tests |
| `make test-be` | Backend unit tests |
| `make lint-fe` | ESLint |
| `make format-fe` | Prettier write |
| `make format-check-fe` | Prettier check only |
| `make dev-fe` | Frontend dev server |
| `make build-fe` | Production frontend build |
| `make build-be` | Go build |
| `make vet-be` | Go vet |
| `make clean` | Remove build artifacts |

## Data Contract

Shared format between backend (writer) and frontend (reader).

### `db.gz`

```
{ data_tog, fetched_at, sub_seq, total_art, next_pid, pack_off, subscriptions[] }
```

| Field | Type | Description |
|---|---|---|
| `data_tog` | bool | Toggles latest pack filename (`true.gz`/`false.gz`) to bust cache; used for both `idx/` and `data/` latest packs |
| `fetched_at` | int | Unix timestamp of last fetch |
| `sub_seq` | int | Subscription sequence counter |
| `total_art` | int | Total article count across all packs |
| `next_pid` | int | Next data pack ID; packs with `id < next_pid` are finalized/immutable |
| `pack_off` | int | Current offset in latest data pack |
| `subscriptions` | array | May be `undefined` in JSON (default `[]`) |
| `first_fetched` | int | Unix timestamp of first fetch that produced articles |

### Subscriptions (`ISub`)

`{ id, title, url, pipe?:string[], ferr?, stop_guid?, etag?, last_modified?, total_art?, last_added?, tag? }`

Backend struct: `Subscription` with ETag, Last-Modified, StopGUID, Tag, Pipeline fields. JSON uses short keys (`pipe`, `ferr`, etc.) — see `DBCore` struct tags.

### Pack Storage

Two gzip-compressed series under the feed directory:

| Series | Format | Split rule |
|---|---|---|
| `idx/` | Delta-encoded TSV (see below) | Every 50,000 articles (`idxPackSize`) |
| `data/` | JSONL — one `ArticleData` object per line | At `PackSize` (tracked by `next_pid`/`pack_off`) |

**idx/ format** — delta-encoded TSV, two line types:
- Line 0 (absolute, 4 fields): `sub_id \t pack_id \t pack_offset \t fetched_at`
- Lines 1+ (delta, 3 fields): `sub_id \t delta_pack_id \t fetched_at`
  - `delta_pack_id == 0` → offset++ (same pack); `delta_pack_id > 0` → pack advances by delta, offset resets to 0

**data/ format** — JSONL, each line: `{"s":sub_id,"a":fetched_at,"p":published,"t":"title","l":"link","c":"content"}`

Short keys: `s`=sub_id, `a`=fetched_at, `p`=published (unix seconds, omitted if 0), `t`=title, `l`=link, `c`=content. Contains all article info.

### CDN Layout / Pack Addressing

Each feed directory: `db.gz` + `idx/` + `data/`.

- **Finalized packs**: `0.gz`..`N-1.gz` (0-indexed), immutable, HTTP `force-cache`
- **Latest pack**: `true.gz` or `false.gz` (toggled by `data_tog`)
- **Finalized idx count**: `total_art > 0 ? Math.floor((total_art - 1) / 50000) : 0`
- **Finalized data packs**: `id < next_pid`

**chronIdx** — global 0-based article index across all idx packs:
- Finalized packs: `chronIdx = pack * 50000 + pos` (0-indexed); latest pack: `numFinalized * 50000 + pos`
- Each finalized pack = exactly 50,000 entries; latest = `total_art - numFinalized * 50000`
- Invalid chronIdx clamps to `total_art - 1` (last, not first)

### File-Based Locking

`.locked` nil-payload marker file. `--force` flag overrides. Lock removal uses `context.WithoutCancel` to survive cancellation.
