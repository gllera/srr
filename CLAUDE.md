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
{ data_tog, ts_tog, fetched_at, sub_seq, total_art, next_pid, pack_off, subscriptions[] }
```

| Field | Type | Description |
|---|---|---|
| `data_tog` | bool | Toggles latest data pack filename (`true.gz`/`false.gz`) to bust cache |
| `ts_tog` | bool | Toggles latest ts pack filename |
| `fetched_at` | int | Unix timestamp of last fetch |
| `sub_seq` | int | Subscription sequence counter |
| `total_art` | int | Total article count across all packs |
| `next_pid` | int | Next data pack ID; packs with `id < next_pid` are finalized/immutable |
| `pack_off` | int | Current offset in latest data pack |
| `subscriptions` | array | May be `undefined` in JSON (default `[]`) |
| `first_fetched` | int | Unix timestamp of first fetch that produced articles. Clients derive earliest ts/ week as `first_fetched / 604800` |

### Subscriptions (`ISub`)

`{ id, title, url, pipe?:string[], ferr?, stop_guid?, etag?, last_modified?, total_art?, last_added?, tag? }`

Backend struct: `Subscription` with ETag, Last-Modified, StopGUID, Tag, Pipeline fields. JSON uses short keys (`pipe`, `ferr`, etc.) — see `DBCore` struct tags.

### Pack Storage

Three gzip-compressed series under the feed directory:

| Series | Format | Split rule |
|---|---|---|
| `idx/` | TSV metadata (7 columns: fetched_at, pack_id, pack_offset, sub_id, published, title, link) | Every 1000 articles (`idxPackSize`) |
| `data/` | Null-byte-separated content | At `PackSize` (tracked by `next_pid`/`pack_off`) |
| `ts/` | TSV delta snapshots, finalized weekly by epoch-week | By week (epoch / 604800) |

**idx/ entries** (`IIdxEntry`): `published` is unix seconds, `0` if unknown. `title`/`link` may be `""`.

**ts/ format**: First line per pack is an absolute snapshot of the **previous week's final state**: `0 \t TotalArticles [\t subID \t subTotalArticles \t subLastAddedAt]*` (first field always 0, week encoded in filename); subsequent lines are `deltaTS \t TotalArticles [\t subID \t subTotalArticles]*` where `deltaTS` is `FetchedAt % 604800` (absolute week offset) and all counts are absolute (no subLastAddedAt in delta lines). Week-start snapshots include all subs and finalize previous pack; mid-week only dirty subs; multi-week gaps produce one finalized pack per missing week.

### CDN Layout / Pack Addressing

Each feed directory: `db.gz` + `idx/` + `data/` + `ts/`.

- **Finalized packs**: `0.gz`..`N-1.gz` (0-indexed), immutable, HTTP `force-cache`
- **Latest pack**: `true.gz` or `false.gz` (toggled by `data_tog`/`ts_tog`)
- **Finalized idx count**: `total_art > 0 ? Math.floor((total_art - 1) / 1000) : 0`
- **Finalized data packs**: `id < next_pid`

**chronIdx** — global 0-based article index across all idx packs:
- Finalized packs: `chronIdx = pack * 1000 + pos` (0-indexed); latest pack: `numFinalized * 1000 + pos`
- Each finalized pack = exactly 1000 entries; latest = `total_art - numFinalized * 1000`
- Invalid chronIdx clamps to `total_art - 1` (last, not first)

### File-Based Locking

`.locked` nil-payload marker file. `--force` flag overrides. Lock removal uses `context.WithoutCancel` to survive cancellation.
