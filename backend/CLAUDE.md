# CLAUDE.md

## Project

**SRR Backend** — Static RSS Reader Backend. Go CLI that fetches RSS/Atom/RDF feeds into gzip-compressed pack series (idx/, data/, ts/). Backends: local filesystem, S3, SFTP.

## Commands

`go build -o srr .`, `go test ./...`, `go test -run TestName .`, `go test -v ./store/`. Release: `CGO_ENABLED=0 go build -ldflags "-s -w"`. No Makefile/linter/Dockerfile.

## Architecture

- **`main.go`** — CLI via `alecthomas/kong` + YAML config (`$SRR_CONFIG` or `$XDG_CONFIG_HOME/srr/srr.yaml`). `Globals` struct for flags. Inline `version` subcommand.
- **`cmd_fetch.go`** — `signal.NotifyContext` for graceful shutdown, channel-based worker pool (`globals.Workers` goroutines). Articles sorted by published time (ascending) before storage. Order: `PutArticles` → `UpdateTS` → `Commit`.
- **`feed.go`** — Streaming XML parser, auto-detects RSS/Atom/RDF. GUIDs: FNV-32a → `uint32` (fallback: GUID → ID → Link → empty hash).
- **`cmd_subs.go`** — `AddCmd` (add/update subscription via `--upd`, `-t/--title`, `-u/--url`, `-g/--tag`, `-p/--parsers`), `RmCmd`, `LsCmd` (filter by `-g/--tag`, yaml/json output).
- **`cmd_import.go`** — OPML import with hierarchical ID selection (`-a` all, `-i` specific). OPML group hierarchy auto-resolves to hierarchical tags; `-g/--tag` overrides. `-n/--dry-run` lists resulting subscriptions without importing.
- **`opml.go`** — OPML XML parsing. `ParseOPMLTree` builds `OPMLNode` tree from file. `normalizeGroupName` converts group names to tag-safe identifiers.
- **`cmd_preview.go`** — `preview` subcommand: fetches a feed URL, runs module pipeline (`-p`), serves rendered articles via local HTTP server (`-a/--addr`).
- **`subscription.go`** — `Subscription` struct (ETag, Last-Modified, StopGUID, Tag, Pipeline). `Fetch` method handles per-subscription HTTP fetch, `StopGUID`/`ErrStopFeed` incremental logic, and module pipeline execution. Also contains `processItem` and text sanitization helpers.

### Store (`store/`)

Low-level storage interface: `Get`/`Put`/`AtomicPut`/`Rm`/`Close`. Registry selects by URL scheme; local = empty scheme `""`. Config registry: backends call `RegisterConfig` in `init()` with a config struct pointer; `LoadConfigs` reads YAML sections into them.

| Method | Behavior |
|---|---|
| `Get(ignoreMissing)` | Controls error-on-missing |
| `Put(ignoreExisting)` | Controls overwrite vs exclusive create |
| `AtomicPut` | temp-then-rename (local/SFTP); overwrite (S3) |

- **`local.go`** — Auto-creates subdirs via `os.MkdirAll`.
- **`s3.go`** — `IfNoneMatch` precondition headers + CRC32 checksums. `S3Config`: region, endpoint, profile, static credentials.
- **`sftp.go`** — Auth chain: URL password → config password → config/default private key → `~/.ssh/` keys → SSH agent → error. Host key verification via `~/.ssh/known_hosts` by default (`SFTPConfig.Insecure` to skip).

### Pack Storage (`db.go`)

See root `CLAUDE.md` Data Contract for pack format spec (idx/, data/, ts/ series), db.json schema, CDN layout, and file-based locking.

Backend-specific:
- `PutArticles`, `UpdateTS`, `savePack` manage the three series. Order: `PutArticles` → `UpdateTS` → `Commit`.
- `Commit` serializes `DBCore` via `AtomicPut`. `db.json` uses short JSON keys — read `DBCore` struct tags for full schema.
- `data_tog`/`ts_tog` toggle alternating pack filenames for atomic updates.
- `first_fetched` (`FirstFetchedAt`): unix timestamp of the first fetch that produced articles.

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

