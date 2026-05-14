# CLAUDE.md

## Project

**SRR Backend** — Static RSS Reader Backend. Go CLI that fetches RSS/Atom/RDF feeds into gzip-compressed pack series (idx/, data/). Backends: local filesystem, S3, SFTP.

## Commands

`go build -o srr .`, `go test ./...`, `go test -run TestName .`, `go test -v ./store/`. Release: `CGO_ENABLED=0 go build -ldflags "-s -w"`. No Makefile/linter/Dockerfile.

## Architecture

- **`main.go`** — CLI via `alecthomas/kong` + YAML config. Source: `$SRR_CONFIG_INLINE` (raw YAML content, takes precedence) → `$SRR_CONFIG` (file path) → `$XDG_CONFIG_HOME/srr/srr.yaml`. `Globals` struct for flags. Command groups: `chan` (alias `ch`): `add`, `upd`, `rm`, `ls`, `show`, `edit`, `apply`, `import`; `art` (alias `a`): `fetch`, `ls`; `pipe`; `preview` (alias `p`); `config` (alias `c`); `inspect` (alias `i`); `version`.
- **`cmd_inspect.go` / `cmd_inspect_check.go` / `cmd_inspect_report.go`** — `InspectCmd` (`srr inspect`): pack consistency checker. Split across three files by responsibility: entry/parsing helpers (`cmd_inspect.go`), validation checks invoked by `--validate` (`cmd_inspect_check.go`), single-mode reports for `--chron`/`--filter`/`--list-tags`/`--from-hash` (`cmd_inspect_report.go`). Mirrors `frontend/src/js/idx.ts` parse + `data.ts getPackRef` byte-for-byte. Modes: `--chron N` (single-entry inspection w/ recovered fetched_at vs stored), `--validate` (full sweep: bounds-vs-data, db-meta cross-check, chanCounts/fetchedAts continuity across pack boundaries, unknown chan_ids, latest-pack file presence), `--filter <tag|chan_id>` (filter resolution + count, mirrors frontend filter math), `--from-hash '<hash>'` (replays `nav.fromHash` end-to-end), `--list-tags` (mirrors `groupChannelsByTag`). `--url` for HTTP CDN; otherwise uses `--store`. Diagnoses the `(reading 's')` crash class in frontend `nav.ts` (`showFeed` accesses `data.db.channels[article.s]`).
- **`cmd_fetch.go`** — `signal.NotifyContext` for graceful shutdown. `errgroup` (`golang.org/x/sync/errgroup`) with `SetLimit(globals.Workers)` and a `sync.Pool` for feed buffers. Articles sorted by published time (ascending) before storage. Order: `PutArticles` → `Commit`. `--interval` / `SRR_FETCH_INTERVAL` duration flag runs fetch in a loop. Error summary (fetched/failed counts) logged at end.
- **`cmd_chans.go`** — `AddCmd` (`srr chan add`, strict-create; flags `-t/--title`, `-u/--url` (repeatable), `-g/--tag`, `-p/--parsers`, `-i/--ingest`), `UpdCmd` (`srr chan upd ID`, channel-level fields plus `-u/--url` (REPLACE), `--add-url` (idempotent APPEND), `--rm-url` (strict REMOVE); the three URL flags are mutually exclusive), `RmCmd` (`srr chan rm`), `LsCmd` (`srr chan ls`, filter by `-g/--tag`, yaml/json output), `ShowCmd` (`srr chan show ID`), `ApplyCmd` (`srr chan apply` reads channel JSON from `--file PATH` or stdin; accepts a single object or an array; whole-input atomic; create when `id` absent, full-replace update when `id` present, error if `id` references a missing channel), `EditCmd` (`srr chan edit ID` opens `$VISUAL`/`$EDITOR`/`vi` on the channel JSON; no-change is a no-op; id changes refused; tempfile preserved on parse or apply error). Per-URL state (`ETag`, `Watermark`, `BoundaryGUIDs`) is preserved across `chan upd -u …`, `chan upd --add-url …`, `chan apply` updates, and `chan edit` by URL match. Empty-string convention on `-t`/`-g`/`-p`/`-i` clears the field where allowed (title cannot be cleared).
- **`cmd_art.go`** — `ArtCmd` (`srr art ls`): lists stored articles newest-first with cursor pagination (`-b/--before`), filter by channel ID (`-i`) or tag (`-g`), with `-l/--limit` (default 50). Outputs JSON. `readAllIdx` parses binary idx format using `db.Channels()` directly; `loadContent` parses JSONL data packs to fill in the per-article `ArticleData` (title, link, published, content) from the data pack.
- **`cmd_import.go`** — OPML import with hierarchical ID selection (`-a` all, `-i` specific). OPML group hierarchy auto-resolves to hierarchical tags; `-g/--tag` overrides. `-n/--dry-run` lists resulting channels without importing.
- **`opml.go`** — OPML XML parsing. `ParseOPMLTree` builds `OPMLNode` tree from file. `normalizeGroupName` converts group names to tag-safe identifiers.
- **`cmd_preview.go`** — `preview` subcommand: dispatches a URL through the ingest engine (`-i/--ingest` picks the strategy, otherwise falls back to the db.gz root `Ingest` then `#rss` via `ingest.Select`), runs module pipeline (`-p`), serves rendered articles via local HTTP server (`-a/--addr`). Opens the DB read-only to read the root default.
- **`cmd_ingest.go`** — `IngestCmd` (`srr ingest [strategy]`): top-level command for the db.gz root `ingest` field. Mirrors `srr pipe`: no args prints, `""` alone clears, otherwise replaces.
- **`channel.go`** — `Channel` (Title, Tag, Pipe, `Ingest`, `Feeds []*Feed`) and `Feed` (URL, ETag `etag`, LastModified `last_modified`, Watermark `wm`, BoundaryGUIDs `bg`, FetchError `ferr`). `Channel.Fetch` resolves the effective pipeline once via `resolvePipe(rootPipe, ch.Pipe)` and the effective ingest strategy once via `ingest.Select(ch.Ingest, rootIngest)`, then iterates feeds sequentially sharing the buffer pool slot; per-feed errors record into `Feed.FetchError` while items from successful feeds still commit. Also hosts the `resolvePipe` helper and the `#parent` token constant for root-pipe inheritance. Pure type + orchestration; per-feed HTTP/dedup logic lives in `feed.go`.
- **`cmd_pipe.go`** — `PipeCmd` (`srr pipe [pipe...]`): top-level command for the db.gz root `pipe` field. No args prints; `""` alone clears; otherwise replaces. Also hosts `filterPipe` (drops empty strings; returns nil for all-empty input as the CLI "clear" sentinel).
- **`feed.go`** — `Feed.fetch` receives an already-resolved `ingestName` from `Channel.Fetch` (resolution lives at the channel level so all feeds in a channel share one strategy and the choice is made once per channel), dispatches I/O+parse through the shared `*ingest.Fetcher` engine, then applies the dedup/watermark/pipeline path on the returned `ingest.Result.Items`. Dedup model per feed: `Watermark` is the max published unix-second ever seen and `BoundaryGUIDs` is the union of (GUIDs at `Watermark` in the most recent fetch) and (dateless GUIDs in the most recent fetch). Repopulated each non-empty fetch from the current response (no carry-over) so its size stays bounded by what the publisher currently exposes; a `NotModified` result or a non-modified response with zero items preserves prior `Watermark`/`BoundaryGUIDs` so the dedup state survives a transient empty channel. An item is new iff its GUID isn't in the prior fetch's `BoundaryGUIDs` AND (`pub == 0` OR `pub >= Watermark`). Item `pub` is clamped to `fetchedAt` so a publisher CMS bug that ships a far-future date can't poison `Watermark`. Within-fetch dedup uses a per-GUID set checked first so duplicate items in one feed response are collapsed and can't pollute `Watermark`/`BoundaryGUIDs`. Trade-off: items at `Watermark` or dateless items that disappear from the feed for one fetch and reappear later are re-ingested as duplicates (snapshot semantics over carry-over).
- **`cmd_config.go`** — `ConfigCmd` (`srr config`): prints resolved configuration. With no argument, prints all globals and active backend config; with a key argument, prints a single field. Reads from `store.Configs()` for backend-specific sections.
- **`processing.go`** — Per-item transformation utilities shared by `Feed.fetch` and `PreviewCmd`: `processItem` runs the module pipeline, enforces GUID/Published immutability, then normalises Title (via `bluemonday` strict policy + whitespace collapse) and strips control chars from Link/Content. Also hosts `validFeedURL` (used by `cmd_chans.go` and `opml.go`).

### Ingest (`ingest/`)

An "ingest strategy" is the I/O+parse layer that produces `mod.RawItem`s from a URL. The default zero-config behaviour is the historical RSS/Atom/RDF path (`#rss`); alternative strategies cover URLs that aren't feeds (e.g. Telegram channel pages). Selection precedence per channel: `Channel.Ingest` (most specific) > `DBCore.Ingest` (db.gz root, managed by `srr ingest`) > built-in `#rss`. Empty strings fall through; persistence uses `omitempty`.

Built-in names start with `#` and resolve through the package's `Register` registry (init-time). Anything not starting with `#` is treated as a shell command per the external-ingest protocol. Built-ins shipped: `#rss`, `#telegram`.

Mirrors `mod/`'s architecture: a `Fetcher` struct (built by `New()`) holds the registered built-in `FetchFunc`s in a name→func map; `Fetcher.Fetch(ctx, args, ...)` dispatches by name — built-ins for matching keys, shell-command fallthrough for anything else.

- **`main.go`** — `Request` / `Result` structs, `FetchFunc` type (`func(ctx, *http.Client, buf, Request) (Result, error)`), factory registration `Register(name, func() FetchFunc)` (the outer factory runs once per `New()` so built-ins can capture per-instance state — same pattern as `mod.Register`), `Select(channel, global) string` precedence helper (final `#rss` fallback), the `Fetcher` struct + `New() *Fetcher`, and `Fetcher.Fetch(ctx, args, client, buf, req)` which routes `args` to a built-in if registered or executes it as a shell command otherwise. External wire schema is the JSON encoding of `Request` (stdin) and `Result` (stdout) — see struct tags; stderr is passthrough. Items on the wire are `mod.RawItem` records, so external strategies emit `guid` as the FNV-32a hash (uint32) of any stable per-item string, matching the dedup contract used by built-ins. `published` is RFC3339 (null/absent for dateless). A `FetchFunc` owns only I/O and parsing — dedup, watermarking, pipeline modules, and storage all stay in `Feed.fetch` and operate uniformly on `Result.Items`. Built-in `FetchFunc`s and the shell-command path must be concurrent-safe (one `*Fetcher` is shared across workers; unlike `*mod.Module` it isn't pooled).
- **`rss.go`** — Built-in `#rss` strategy (registered inline in `init`): the zero-config default. HTTP GET with `If-None-Match` / `If-Modified-Since` hints into the shared per-worker buffer, then `ParseFeed`. Returns `NotModified` on 304; populates `ETag` / `LastModified` for the next request. Also houses the streaming RSS/Atom/RDF parser: `ParseFeed(data, fn)`, `ErrStopFeed` sentinel, and the package-private `hash(string)` used here and by `#telegram` for GUID stability.
- **`telegram.go`** — Built-in `#telegram` strategy (registered inline in `init`): scrapes `https://t.me/s/<channel>` HTML via `golang.org/x/net/html`. One `RawItem` per `div.tgme_widget_message` — `data-post` (e.g. `channel/123`) → hashed into GUID, permalink as Link; `time[datetime]` inside `a.tgme_widget_message_date` → Published; inner HTML of `div.tgme_widget_message_text` → Content (raw — the sanitize/minify pipeline modules are the right place to clamp it). No ETag/Last-Modified: relies on per-feed GUID dedup to suppress re-presented messages.

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
- **`db.go`** — `DB`, `DBCore`, lifecycle (`NewDB`/`Close`/`Commit`), channel CRUD (`AddChannel`/`RemoveChannel`/`ChannelByID`/`Channels`), `withDB`/`withDBCtx` boilerplate wrappers, and shared utilities (`gunzip`, `readGz`, `jsonEncode`). `Commit` serializes `DBCore` via `AtomicPut`.
- **`db_pack.go`** — Binary idx + JSONL data pack writer. Contains `ArticleData` and `Item` types, the `pack` struct (`newPack`/`writeIdx`/`writeIdxHeader`/`writeArticle`), `loadPack`/`savePack`/`expectedLatestIdxSize`, and the `PutArticles` driver. Also `dataKeyFor` and `parseDataPack` (used by `cmd_art.go` and `cmd_inspect.go` for read-side access).

Backend-specific behavior:
- `PutArticles` and `savePack` manage the two series. Order: `PutArticles` → `Commit`.
- `PutArticles` writes binary idx and JSONL data directly; splits idx packs at every 50,000 articles; sets `FirstFetchedAt` on first run that produces articles.
- Per-entry `delta_fetched_at` is computed against `prevFetchedTS = FirstFetchedAt/28800 + FetchedAtCursor` so the first entry of each batch records the elapsed time since the previous fetch (clamped to 7 bits with carry).
- `ArticleData` struct: `{ ChannelID, FetchedAt, Published, Title, Link, Content }` — serialized as JSONL with short keys `s/a/p/t/l/c`.
- `DBCore.Channels` is `map[int]*Channel`; serialized as a JSON object keyed by channel ID. `AddChannel` assigns the first free ID in [0, 255] and returns an error if all 256 slots are taken. `RemoveChannel` uses `delete`.
- `data_tog` toggles alternating pack filenames for atomic updates (used for both idx/ and data/ latest packs).
- `withDB(locked, fn)` / `withDBCtx(ctx, locked, fn)`: most cmd `Run()` methods are now a single `withDB` call wrapping the work.

### Module System (`mod/`)

Pipeline per-channel during fetch. Factory pattern: `New()` returns fresh stateful processor.

- `#sanitize` — bluemonday, content-only.
- `#minify` — tdewolff/minify, content-only.
- `#youtube` — replaces `Content` with a thumbnail-link card (`https://i.ytimg.com/vi/<id>/hqdefault.jpg` linked to `watch?v=<id>`) plus the description; description source preference is `media:group/media:description` → entry-level `description`/`summary` → existing `Content`. Recognises `youtube.com` (`watch?v=`, `/embed/`, `/v/`, `/shorts/`, `/live/`), `youtu.be`, `m./music.` and `youtube-nocookie.com`. Non-YouTube `Link`s are skipped (Content untouched), so the module is safe in mixed pipelines.
- External modules: `/bin/sh -c`, stdin/stdout JSON (`RawItem`), stderr passthrough.
- `GUID` and `Published` are immutable for all modules (built-in or external; change = error). Enforced in `processItem` after each pipeline step — the captured value before the step is compared to the post-step value, attributing changes to the offending module.
- `RawItem.Raw` is set by `feed.go` to the parsed entry as `mod.RawFeedItem` (`map[string][]mod.RawField`); modules can type-assert it for typed access. External (shell) modules see the same data as JSON via the short keys `@`/`$`/`+` (text/attrs/children).

### Pipe Hierarchy

Two levels store an optional mod pipeline: root (`DBCore.Pipe`) and channel (`Channel.Pipe`, JSON `pipe`). Resolved once per channel at the start of `Channel.Fetch` via `resolvePipe` in `channel.go`:

- `nil`/absent channel `Pipe` inherits the root pipe.
- A non-`nil` channel `Pipe` overrides root (an empty slice means "no pipe").
- The `#parent` token in a channel override expands inline to the root pipe; can appear multiple times. Non-token entries pass through verbatim.
- CLI: `srr pipe` (root), `srr chan add -p` / `srr chan upd -p` (channel).
- `NewDB` substitutes `defaultRootPipe()` (`["#sanitize", "#minify"]`) when the loaded `DBCore.Pipe` is nil — fresh DBs and existing DBs predating this feature both pick up the default. Persisted on the next `Commit`. To disable mods for a given channel, set `Channel.Pipe = []string{}` (`srr chan upd <id> -p ""`); clearing root pipe (`srr pipe ""`) reverts to the default on next load.

## Conventions

- **Imports**: stdlib → external → internal, blank-line separated, alphabetical within groups
- **Errors**: Always wrap with `fmt.Errorf("context: %w", err)`. Single sentinel: `ErrStopFeed` (feed.go). No custom error types.

## Constraints (preserve when editing)

- File-based DB lock (`.locked`) with `--force` override
- Env vars prefixed `SRR_`
- `ErrStopFeed` sentinel is part of the `parseFeed` callback contract for early-exit (currently unused in production code; kept for the API)
