# CLAUDE.md

## Project

**SRR Backend** — Static RSS Reader Backend. Go CLI that fetches RSS/Atom/RDF feeds into gzip-compressed pack series (idx/, data/). Backends: local filesystem, S3, SFTP.

## Commands

`go build -o srr .`, `go test ./...`, `go test -run TestName .`, `go test -v ./store/`. Release: `CGO_ENABLED=0 go build -ldflags "-s -w"`. No Makefile/linter/Dockerfile.

## Architecture

- **`main.go`** — CLI via `alecthomas/kong` + YAML config (`$SRR_CONFIG` or `$XDG_CONFIG_HOME/srr/srr.yaml`). `Globals` struct for flags. Command groups: `sub` (alias `s`): `add`, `rm`, `ls`, `import`; `art` (alias `a`): `fetch`, `ls`; `preview` (alias `p`); `version`.
- **`cmd_fetch.go`** — `signal.NotifyContext` for graceful shutdown. `errgroup` (`golang.org/x/sync/errgroup`) with `SetLimit(globals.Workers)` and a `sync.Pool` for feed buffers. Articles sorted by published time (ascending) before storage. Order: `PutArticles` → `Commit`. `--interval` / `SRR_FETCH_INTERVAL` duration flag runs fetch in a loop. Error summary (fetched/failed counts) logged at end.
- **`feed.go`** — Streaming XML parser, auto-detects RSS/Atom/RDF. GUIDs: FNV-32a → `uint32` (fallback: GUID → ID → Link → empty hash).
- **`cmd_subs.go`** — `AddCmd` (`srr sub add`, add/update subscription via `--upd`, `-t/--title`, `-u/--url`, `-g/--tag`, `-p/--parsers`), `RmCmd` (`srr sub rm`), `LsCmd` (`srr sub ls`, filter by `-g/--tag`, yaml/json output).
- **`cmd_art.go`** — `ArtCmd` (`srr art ls`): lists stored articles newest-first with cursor pagination (`-b/--before`), filter by sub ID (`-i`) or tag (`-g`), optional full content (`-f/--full`). Outputs JSON. `readIdxPack` parses delta-encoded idx format; `loadContent` parses JSONL data packs to resolve title, link, published, and optionally content.
- **`cmd_import.go`** — OPML import with hierarchical ID selection (`-a` all, `-i` specific). OPML group hierarchy auto-resolves to hierarchical tags; `-g/--tag` overrides. `-n/--dry-run` lists resulting subscriptions without importing.
- **`opml.go`** — OPML XML parsing. `ParseOPMLTree` builds `OPMLNode` tree from file. `normalizeGroupName` converts group names to tag-safe identifiers.
- **`cmd_preview.go`** — `preview` subcommand: fetches a feed URL, runs module pipeline (`-p`), serves rendered articles via local HTTP server (`-a/--addr`).
- **`subscription.go`** — `Subscription` struct (ETag, Last-Modified, StopGUID, Tag, Pipeline). `Fetch` method handles per-subscription HTTP fetch, `StopGUID`/`ErrStopFeed` incremental logic, and module pipeline execution. Also contains `processItem` and text sanitization helpers.

### Store (`store/`)

Low-level storage interface: `Get`/`Put`/`AtomicPut`/`Rm`/`Close`. Registry selects by URL scheme; local = empty scheme `""`. Config registry: backends call `RegisterConfig` in `init()` with a config struct pointer; `LoadConfigs` reads YAML sections into them.

| Method | Signature | Behavior |
|---|---|---|
| `Get(ignoreMissing)` | returns `io.ReadCloser` | Controls error-on-missing; streaming read |
| `Put(ignoreExisting)` | accepts `io.Reader` | Controls overwrite vs exclusive create; streaming write |
| `AtomicPut` | accepts `io.Reader` | temp-then-rename (local/SFTP); overwrite (S3); streaming write |

- **`local.go`** — Auto-creates subdirs via `os.MkdirAll`.
- **`s3.go`** — `IfNoneMatch` precondition headers + CRC32 checksums. `S3Config`: region, endpoint, profile, static credentials.
- **`sftp.go`** — Auth chain: URL password → config password → config/default private key → `~/.ssh/` keys → SSH agent → error. Host key verification via `~/.ssh/known_hosts` by default (`SFTPConfig.Insecure` to skip).

### Pack Storage (`db.go`)

See root `CLAUDE.md` Data Contract for pack format spec (idx/, data/ series), db.gz schema, CDN layout, and file-based locking.

Backend-specific:
- `PutArticles` and `savePack` manage the two series. Order: `PutArticles` → `Commit`.
- `PutArticles` writes delta-encoded idx TSV and JSONL data directly; splits idx packs at every 50,000 articles; sets `FirstFetchedAt` on first run that produces articles.
- `ArticleData` struct: `{ SubID, FetchedAt, Published, Title, Link, Content }` — serialized as JSONL with short keys `s/a/p/t/l/c`.
- `Commit` serializes `DBCore` via `AtomicPut`. `db.gz` is gzip-compressed JSON with short keys — read `DBCore` struct tags for full schema.
- `data_tog` toggles alternating pack filenames for atomic updates (used for both idx/ and data/ latest packs).
- `DB.startTotalArt` — captured in `NewDB()` from the loaded `DBCore.TotalArticles`; used by `cmd_fetch.go` to log new article count.

### Module System (`mod/`)

Pipeline per-subscription during fetch. Factory pattern: `New()` returns fresh stateful processor.

- `#sanitize` — bluemonday, content-only.
- `#minify` — tdewolff/minify, content-only.
- External modules: `/bin/sh -c`, stdin/stdout JSON (`RawItem`), stderr passthrough. GUID is immutable (change = error).

## Conventions

- **Imports**: stdlib → external → internal, blank-line separated, alphabetical within groups
- **Errors**: Always wrap with `fmt.Errorf("context: %w", err)`. Single sentinel: `ErrStopFeed` (feed.go). No custom error types.

## Constraints (preserve when editing)

- File-based DB lock (`.locked`) with `--force` override
- Env vars prefixed `SRR_`
- `ErrStopFeed` sentinel halts feed on `StopGUID` match

