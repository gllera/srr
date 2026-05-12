# CLAUDE.md

## Project

**SRR Backend** — Static RSS Reader Backend. Go CLI that fetches RSS/Atom/RDF feeds into gzip-compressed pack series (idx/, data/). Backends: local filesystem, S3, SFTP.

## Commands

`go build -o srr .`, `go test ./...`, `go test -run TestName .`, `go test -v ./store/`. Release: `CGO_ENABLED=0 go build -ldflags "-s -w"`. No Makefile/linter/Dockerfile.

## Architecture

- **`main.go`** — CLI via `alecthomas/kong` + YAML config. Source: `$SRR_CONFIG_INLINE` (raw YAML content, takes precedence) → `$SRR_CONFIG` (file path) → `$XDG_CONFIG_HOME/srr/srr.yaml`. `Globals` struct for flags. Command groups: `sub` (alias `s`): `add`, `rm`, `add-src`, `rm-src`, `ls`, `import`; `art` (alias `a`): `fetch`, `ls`; `preview` (alias `p`); `config` (alias `c`); `inspect` (alias `i`); `version`.
- **`cmd_inspect.go` / `cmd_inspect_check.go` / `cmd_inspect_report.go`** — `InspectCmd` (`srr inspect`): pack consistency checker. Split across three files by responsibility: entry/parsing helpers (`cmd_inspect.go`), validation checks invoked by `--validate` (`cmd_inspect_check.go`), single-mode reports for `--chron`/`--filter`/`--list-tags`/`--from-hash` (`cmd_inspect_report.go`). Mirrors `frontend/src/js/idx.ts` parse + `data.ts getPackRef` byte-for-byte. Modes: `--chron N` (single-entry inspection w/ recovered fetched_at vs stored), `--validate` (full sweep: bounds-vs-data, db-meta cross-check, subCounts/fetchedAts continuity across pack boundaries, unknown sub_ids, latest-pack file presence), `--filter <tag|sub_id>` (filter resolution + count, mirrors frontend filter math), `--from-hash '<hash>'` (replays `nav.fromHash` end-to-end), `--list-tags` (mirrors `groupSubsByTag`). `--url` for HTTP CDN; otherwise uses `--store`. Diagnoses the `(reading 's')` crash class in frontend `nav.ts` (`showFeed` accesses `data.db.subscriptions[article.s]`).
- **`cmd_fetch.go`** — `signal.NotifyContext` for graceful shutdown. `errgroup` (`golang.org/x/sync/errgroup`) with `SetLimit(globals.Workers)` and a `sync.Pool` for feed buffers. Articles sorted by published time (ascending) before storage. Order: `PutArticles` → `Commit`. `--interval` / `SRR_FETCH_INTERVAL` duration flag runs fetch in a loop. Error summary (fetched/failed counts) logged at end.
- **`feed.go`** — Streaming XML parser, auto-detects RSS/Atom/RDF. GUIDs: FNV-32a → `uint32` (fallback: GUID → ID → Link → empty hash).
- **`cmd_subs.go`** — `AddCmd` (`srr sub add`, add/update subscription via `--upd`, `-t/--title`, `-u/--url` (repeatable), `-g/--tag`, `-p/--parsers`), `RmCmd` (`srr sub rm`), `AddSrcCmd` (`srr sub add-src <id> <url>...`), `RmSrcCmd` (`srr sub rm-src <id> <url>...`), `LsCmd` (`srr sub ls`, filter by `-g/--tag`, yaml/json output). `-u` accepts multiple URLs to merge several feeds under one subscription id; on update, prior per-source state (ETag, Watermark, etc.) is carried over for URLs still present. `add-src` is idempotent (URLs already on the sub or duplicated within args are silently skipped — `mkdir -p` semantics); only invalid URL formats fail. `rm-src` is strict: errors if any URL is not a current source, errors before emptying the source list (use `sub rm` to delete the subscription instead).
- **`cmd_art.go`** — `ArtCmd` (`srr art ls`): lists stored articles newest-first with cursor pagination (`-b/--before`), filter by sub ID (`-i`) or tag (`-g`), with `-l/--limit` (default 50). Outputs JSON. `readAllIdx` parses binary idx format using `db.Subscriptions()` directly; `loadContent` parses JSONL data packs to fill in the per-article `ArticleData` (title, link, published, content) from the data pack.
- **`cmd_import.go`** — OPML import with hierarchical ID selection (`-a` all, `-i` specific). OPML group hierarchy auto-resolves to hierarchical tags; `-g/--tag` overrides. `-n/--dry-run` lists resulting subscriptions without importing.
- **`opml.go`** — OPML XML parsing. `ParseOPMLTree` builds `OPMLNode` tree from file. `normalizeGroupName` converts group names to tag-safe identifiers.
- **`cmd_preview.go`** — `preview` subcommand: fetches a feed URL, runs module pipeline (`-p`), serves rendered articles via local HTTP server (`-a/--addr`).
- **`subscription.go`** — `Subscription` (Title, Tag, Pipeline, `Sources []*Source`) and `Source` (URL, ETag `etag`, LastModified `last_modified`, Watermark `wm`, BoundaryGUIDs `bg`, FetchError `ferr`). `Subscription.Fetch` iterates sources sequentially, sharing the buffer pool slot; per-source errors record into `Source.FetchError` while items from successful sources still commit. Pure type + orchestration; per-source HTTP/dedup logic lives in `source_fetch.go`.
- **`source_fetch.go`** — `Source.fetch` owns the HTTP/304/dedup/pipeline path. Dedup model per source: `Watermark` is the max published unix-second ever seen and `BoundaryGUIDs` is the union of (GUIDs at `Watermark` in the most recent fetch) and (dateless GUIDs in the most recent fetch). Repopulated each non-empty fetch from the current response (no carry-over) so its size stays bounded by what the publisher currently exposes; a 200 OK with zero items preserves prior `Watermark`/`BoundaryGUIDs` so the dedup state survives a transient empty channel. An item is new iff its GUID isn't in the prior fetch's `BoundaryGUIDs` AND (`pub == 0` OR `pub >= Watermark`). Item `pub` is clamped to `fetchedAt` so a publisher CMS bug that ships a far-future date can't poison `Watermark`. Within-fetch dedup uses a per-GUID set checked first so duplicate items in one feed response are collapsed and can't pollute `Watermark`/`BoundaryGUIDs`. Trade-off: items at `Watermark` or dateless items that disappear from the feed for one fetch and reappear later are re-ingested as duplicates (snapshot semantics over carry-over).
- **`cmd_config.go`** — `ConfigCmd` (`srr config`): prints resolved configuration. With no argument, prints all globals and active backend config; with a key argument, prints a single field. Reads from `store.Configs()` for backend-specific sections.
- **`processing.go`** — Per-item transformation utilities shared by `Source.fetch` and `PreviewCmd`: `processItem` runs the module pipeline, enforces GUID/Published immutability, then normalises Title (via `bluemonday` strict policy + whitespace collapse) and strips control chars from Link/Content. Also hosts `validFeedURL` (used by `cmd_subs.go` and `opml.go`).

### Store (`store/`)

Low-level storage interface: `Get`/`Put`/`AtomicPut`/`Rm`/`Close`. Registry selects by URL scheme; local = empty scheme `""`. Config registry: backends call `RegisterConfig` in `init()` with a config struct pointer; `LoadConfigs` reads YAML sections into them.

| Method | Signature | Behavior |
|---|---|---|
| `Get(ignoreMissing)` | returns `io.ReadCloser` | Controls error-on-missing; streaming read |
| `Put(ignoreExisting)` | accepts `io.Reader` | Controls overwrite vs exclusive create; streaming write |
| `AtomicPut` | accepts `io.Reader` | temp-then-rename (local/SFTP); overwrite (S3); streaming write |
| `Rm` | — | Silent on missing (local/SFTP warn + return nil; S3 unconditional delete) |

- **`local.go`** — Auto-creates subdirs via `os.MkdirAll`.
- **`s3.go`** — `IfNoneMatch` precondition headers + CRC32 checksums. `S3Config`: region, endpoint, profile, static credentials.
- **`sftp.go`** — Auto-creates subdirs via `client.MkdirAll`. Auth chain: URL password → config password → config/default private key → `~/.ssh/` keys → SSH agent → error. Host key verification via `~/.ssh/known_hosts` by default (`SFTPConfig.Insecure` to skip).

### Pack Storage (`db.go` + `db_pack.go`)

See root `CLAUDE.md` Data Contract for pack format spec (idx/, data/ series), db.gz schema, CDN layout, and file-based locking.

Split across two files by concern:
- **`db.go`** — `DB`, `DBCore`, lifecycle (`NewDB`/`Close`/`Commit`), subscription CRUD (`AddSubscription`/`RemoveSubscription`/`SubByID`/`Subscriptions`), `withDB`/`withDBCtx` boilerplate wrappers, and shared utilities (`gunzip`, `readGz`, `jsonEncode`). `Commit` serializes `DBCore` via `AtomicPut`.
- **`db_pack.go`** — Binary idx + JSONL data pack writer. Contains `ArticleData` and `Item` types, the `pack` struct (`newPack`/`writeIdx`/`writeIdxHeader`/`writeArticle`), `loadPack`/`savePack`/`expectedLatestIdxSize`, and the `PutArticles` driver. Also `dataKeyFor` and `parseDataPack` (used by `cmd_art.go` and `cmd_inspect.go` for read-side access).

Backend-specific behavior:
- `PutArticles` and `savePack` manage the two series. Order: `PutArticles` → `Commit`.
- `PutArticles` writes binary idx and JSONL data directly; splits idx packs at every 50,000 articles; sets `FirstFetchedAt` on first run that produces articles.
- Per-entry `delta_fetched_at` is computed against `prevFetchedTS = FirstFetchedAt/28800 + FetchedAtCursor` so the first entry of each batch records the elapsed time since the previous fetch (clamped to 7 bits with carry).
- `ArticleData` struct: `{ SubID, FetchedAt, Published, Title, Link, Content }` — serialized as JSONL with short keys `s/a/p/t/l/c`.
- `DBCore.Subscriptions` is `map[int]*Subscription`; serialized as a JSON object keyed by subscription ID. `AddSubscription` assigns the first free ID in [0, 255] and returns an error if all 256 slots are taken. `RemoveSubscription` uses `delete`.
- `data_tog` toggles alternating pack filenames for atomic updates (used for both idx/ and data/ latest packs).
- `withDB(locked, fn)` / `withDBCtx(ctx, locked, fn)`: most cmd `Run()` methods are now a single `withDB` call wrapping the work.

### Module System (`mod/`)

Pipeline per-subscription during fetch. Factory pattern: `New()` returns fresh stateful processor.

- `#sanitize` — bluemonday, content-only.
- `#minify` — tdewolff/minify, content-only.
- `#youtube` — replaces `Content` with a thumbnail-link card (`https://i.ytimg.com/vi/<id>/hqdefault.jpg` linked to `watch?v=<id>`) plus the description; description source preference is `media:group/media:description` → entry-level `description`/`summary` → existing `Content`. Recognises `youtube.com` (`watch?v=`, `/embed/`, `/v/`, `/shorts/`, `/live/`), `youtu.be`, `m./music.` and `youtube-nocookie.com`. Non-YouTube `Link`s are skipped (Content untouched), so the module is safe in mixed pipelines.
- External modules: `/bin/sh -c`, stdin/stdout JSON (`RawItem`), stderr passthrough.
- `GUID` and `Published` are immutable for all modules (built-in or external; change = error). Enforced in `processItem` after each pipeline step — the captured value before the step is compared to the post-step value, attributing changes to the offending module.
- `RawItem.Raw` is set by `feed.go` to the parsed entry as `mod.RawFeedItem` (`map[string][]mod.RawField`); modules can type-assert it for typed access. External (shell) modules see the same data as JSON via the short keys `@`/`$`/`+` (text/attrs/children).

## Conventions

- **Imports**: stdlib → external → internal, blank-line separated, alphabetical within groups
- **Errors**: Always wrap with `fmt.Errorf("context: %w", err)`. Single sentinel: `ErrStopFeed` (feed.go). No custom error types.

## Constraints (preserve when editing)

- File-based DB lock (`.locked`) with `--force` override
- Env vars prefixed `SRR_`
- `ErrStopFeed` sentinel is part of the `parseFeed` callback contract for early-exit (currently unused in production code; kept for the API)

