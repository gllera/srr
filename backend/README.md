# SRR Backend

Static RSS Reader Backend — a Go CLI that fetches RSS/Atom/RDF feeds into compact, gzip-compressed pack files designed for efficient static hosting and incremental sync.

## Install

Download the latest release binary from [GitHub Releases](https://github.com/gllera/srr/releases):

```bash
# Linux amd64 example
curl -sL "$(curl -s https://api.github.com/repos/gllera/srr/releases/latest \
  | grep browser_download_url | grep linux-amd64 | cut -d'"' -f4)" -o srr
chmod +x srr
```

Or build from source:

```bash
git clone https://github.com/gllera/srr.git
cd srr/backend
CGO_ENABLED=0 go build -ldflags "-s -w" -o srr .
```

## Usage

```
srr <command> [flags]
```

### Commands

Commands are grouped under `chan` (channel management), `art` (articles), `preview`, `inspect`, `config`, and `version`. Group names have short aliases (`ch`, `a`, `p`, `i`, `c`).

| Command            | Description                                        |
|--------------------|----------------------------------------------------|
| `chan add`         | Subscribe to a new channel (one or more feed URLs); always allocates a fresh id |
| `chan upd <id>`    | Update a channel (`-t` title, `-g` tag, `-p` pipe, `-i` ingest; feed URLs via `-u` REPLACE / `--add-url` APPEND / `--rm-url` REMOVE) |
| `chan upd <id> --add-url <url>` | Append feed URL(s) to a channel (idempotent) |
| `chan upd <id> --rm-url <url>`  | Remove feed URL(s) (strict — errors if absent or if it would empty the channel) |
| `chan rm`          | Unsubscribe from channel(s) by id                  |
| `chan ls`          | List channels (`-g` tag filter, `-f` format)       |
| `chan show <id>`   | Print one channel (yaml/json)                      |
| `chan edit <id>`   | Edit a channel's JSON in `$EDITOR`                 |
| `chan apply`       | Upsert channel(s) from JSON (`--file` or stdin)    |
| `chan import`      | Import channels from an OPML file                  |
| `art fetch`        | Fetch new articles from all channels               |
| `art ls`           | List stored articles                               |
| `pipe`             | Set or print root-level pipe (default pipeline)    |
| `ingest`           | Set or print root-level ingest strategy            |
| `preview`          | Preview processed feed articles in a browser       |
| `inspect`          | Validate pack consistency / debug chronIdx lookups |
| `config`           | Print resolved configuration                       |
| `version`          | Print version information                          |

### Examples

```bash
# Add a channel
srr chan add -t "Tech News" -u https://example.com/feed.xml -g tech/news

# Add with processing pipeline
srr chan add -t "Blog" -u https://example.com/rss -p "#sanitize" -p "#minify"

# Add a second feed URL to an existing channel (idempotent)
srr chan upd 1 --add-url https://example.com/alt-feed.xml

# Remove a feed URL from a channel
srr chan upd 1 --rm-url https://example.com/alt-feed.xml

# Update an existing channel's pipeline (use #base to keep root mods)
srr chan upd 1 -p "#base" -p "jq '.content |= ascii_downcase'"

# Set root-level pipe (inherited by every channel whose pipe is absent)
srr pipe "#sanitize" "#minify"

# Print current root-level pipe (defaults to "#sanitize", "#minify" when unset)
srr pipe

# Clear root-level pipe — reverts to the built-in default on next load
srr pipe ""

# List channels (filter by tag)
srr chan ls -g tech

# List channels as JSON
srr chan ls -f json

# Fetch all feeds
srr art fetch

# Fetch with 8 concurrent workers
srr -w 8 art fetch

# Import from OPML (all feeds)
srr chan import feeds.opml -a

# Import selectively with dry-run
srr chan import feeds.opml -i "1" -i "2.3" -n

# Preview a feed with processors
srr preview https://example.com/feed.xml -p "#sanitize" -p "#minify"
```

## Global Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-w, --workers` | nproc | Concurrent downloads |
| `-s, --pack-size` | 200 | Target pack size (KB) |
| `-m, --max-feed-size` | 5000 | Max feed download size (KB) |
| `--max-media-size` | 25000 | Max self-hosted media object size (KB); breach hard-fails the feed |
| `--cache-dir` | $XDG_CACHE_HOME/srr | Download cache root for self-hosted external-ingest media |
| `-o, --store` | packs | Storage destination |
| `--force` | false | Override DB write lock |
| `-d, --debug` | false | Enable debug logging |

Global flags can also be set via environment variables (prefixed `SRR_`, e.g. `SRR_WORKERS`) or in a YAML config file using their long flag names as keys:

```yaml
# $XDG_CONFIG_HOME/srr/srr.yaml (or override path with $SRR_CONFIG,
# or pass the YAML content directly via $SRR_CONFIG_INLINE)
workers: 4
pack-size: 500
store: /path/to/packs
```

Precedence: CLI flags > env vars > config file > defaults. `$SRR_CONFIG_INLINE`, when set, supersedes `$SRR_CONFIG`.

## Storage Backends

The output path (`-o`) determines which backend is used:

| Backend | Example | Notes |
|---------|---------|-------|
| Local | `srr -o ./packs art fetch` | Default. Auto-creates directories. |
| S3 | `srr -o s3://bucket/prefix art fetch` | Uses standard AWS SDK credentials. |
| SFTP | `srr -o sftp://user@host/path art fetch` | Auth: URL password, config password, config private key, `~/.ssh/` keys, or SSH agent. |

### Backend Configuration

Backends can be configured via YAML sections in the config file:

```yaml
# S3 backend
s3:
  region: us-west-2
  endpoint: https://minio.example.com
  profile: production
  access-key-id: AKIA...
  secret-access-key: ...
  session-token: ...

# SFTP backend
sftp:
  user: deploy
  password: secret
  private-key: /path/to/key
  known-hosts-file: ~/.ssh/known_hosts
  insecure: false
```

SFTP auth chain (in order): URL password → config password → config `private-key` → `~/.ssh/` keys → SSH agent. Uses `~/.ssh/known_hosts` for host key verification by default. Set `insecure: true` to skip verification.

## Ingest Strategies

An *ingest strategy* is the I/O + parse step that turns a subscription URL into a list of articles, before the [pipe pipeline](#pipe-pipeline) transforms them. The default strategy, `#rss`, fetches the URL over HTTP and parses RSS/Atom/RDF. Sources that aren't feeds — a private API, a site that needs scraping, anything bespoke — are handled by an **external command** that speaks a small JSON protocol. No rebuild is required, and nothing source-specific lives in this repo.

### Selecting a strategy

The effective strategy is resolved per channel, most specific wins:

1. The channel's `ingest` field (`srr chan add -i ...` / `srr chan upd -i ...`)
2. The db.gz root default (`srr ingest ...`)
3. The built-in `#rss` (when both are empty)

Built-in strategy names start with `#` (only `#rss` ships built-in). **Any value that does not start with `#` is run as a shell command** via `/bin/sh -c`.

```bash
# Route one channel through an external command
srr chan add -t "My source" -u "https://example.com/x" -i "myfetch --token=$TOK"

# Make an external command the default for every channel
srr ingest "myfetch"

# Print the current root default; clear it with ""
srr ingest
srr ingest ""
```

### External command protocol

The command receives a JSON **request** on `stdin` and must print a JSON **response** on `stdout`. `stderr` is passed through to the terminal — use it for logging. The process environment is inherited, so `SRR_*` and any credentials already in the environment are available to the command.

**Request** (stdin):

| Field | Type | Description |
|---|---|---|
| `url` | string | The subscription URL (the channel feed URL). |
| `etag` | string | The `etag` your command returned last run (empty on first call). |
| `last_modified` | string | The `last_modified` your command returned last run. |
| `max_size` | int | Advisory cap (bytes) on what the command should buffer/return. |
| `asset_dir` | string | Persistent download cache for self-hosting files, shared by all feeds (see below). The command also **runs with this as its working directory**. Absent when self-hosting is off (e.g. `srr preview`). |

**Response** (stdout):

| Field | Type | Description |
|---|---|---|
| `not_modified` | bool | `true` if nothing changed since `etag`/`last_modified`; `items` is then ignored. |
| `etag` | string | Opaque cursor echoed back on the next request (optional). |
| `last_modified` | string | Opaque cursor echoed back on the next request (optional). |
| `items` | array | The articles (each item below). |

**Item:**

| Field | Type | Description |
|---|---|---|
| `guid` | uint32 | Stable per-item dedup key — an **FNV-1a 32-bit hash** (see below). |
| `title` | string | Article title. |
| `content` | string | Article HTML (then runs through the pipe pipeline). |
| `link` | string | Canonical article URL. |
| `published` | string \| null | RFC 3339 timestamp, or `null`/absent for dateless items. |

**The `guid` contract.** SRR dedups and watermarks on `guid`, a 32-bit FNV-1a hash. Pick any *stable* per-item string (an upstream id, the permalink, …) and hash its UTF-8 bytes with FNV-1a — offset basis `2166136261`, prime `16777619`. The same input must always produce the same `guid` so a re-presented item dedups instead of duplicating.

**Example exchange.** SRR writes exactly one request object to the command's stdin (one line, no trailing input):

```json
{"url":"https://example.com/x","etag":"","last_modified":"","max_size":5119999,"asset_dir":"/home/you/.cache/srr"}
```

The command reads it, fetches its source, and prints exactly one response object to stdout (whitespace is ignored; pretty-printed here):

```json
{
  "etag": "W/\"a1b2c3\"",
  "items": [
    {
      "guid": 3542072042,
      "title": "Hello world",
      "content": "<p>First post.</p>",
      "link": "https://example.com/123",
      "published": "2024-03-01T12:00:00Z"
    }
  ]
}
```

`guid` here is `fnv1a32("post-123")`. On the next run SRR echoes `"etag":"W/\"a1b2c3\""` back in the request; reply `{"not_modified":true}` to report nothing changed, or `{"items":[]}` if the source is genuinely empty (both preserve dedup state).

**Behavior contract.**

- A **non-zero exit code** fails the fetch for that feed only (the error is recorded in the feed's `ferr`); the channel's other feeds — and all other channels — still fetch and commit.
- **Empty stdout is an error** — emit at least `{"items":[]}` (or `{"not_modified":true}`).
- stdout is capped at 64 MiB; exceeding it fails the fetch.
- The command is killed if it runs longer than the subprocess time budget — 5m by default, overridable via `SRR_CMD_TIMEOUT` (a Go duration; a value that doesn't parse or is ≤ 0 is ignored and the 5m default applies). A killed command fails the fetch for that feed, so long-running sources must finish within the budget or raise it. The command must not block waiting for more stdin after consuming the single request object.
- `not_modified: true` (or a response with zero `items`) **preserves** the channel's dedup state, so a transient empty response won't drop it.

### Self-hosting files

For files SRR can't fetch itself — images, video, or linked documents behind authentication, say — the command downloads the bytes and lets SRR mirror them into the store. SRR owns the store key and the upload, so the command needs no store credentials.

`asset_dir` is a **persistent directory shared by all feeds** that SRR creates and never deletes, and **runs the command in** (its working directory) — so the command reads and writes files with relative paths, choosing its own layout inside (namespace as needed, since every feed shares the dir). The command:

1. Downloads a file into the working directory (checking first — if it already exists, skip the download).
2. References it in item `content` with a **`#`-prefixed relative path**: a value that starts with `#` and names the downloaded file, e.g. `<img src="#/photo.jpg">`, `<video src="#/clip.mp4">`, or `<a href="#/report.pdf">`. (A plain `#fragment` that doesn't name a real downloaded file — an ordinary in-page anchor — is left alone.)

After the pipe pipeline runs, SRR's automatic final step scans each item's `content` for those markers in `<img src>` / `<video src>` / `<a href>`, hashes the referenced file, uploads it under `assets/<2-hex>/<16-hex><ext>` — a 2-char shard directory, the first 16 hex chars (64-bit prefix) of the file's sha256, plus the original extension (e.g. `assets/ab/abcdef0123456789.jpg`) — **only if not already present**, and rewrites the marker to that key. Identical bytes dedup to one stored object across feeds and runs. A marker pointing at a missing file is left as-is (a broken reference, never a failed fetch).

> **Note:** `<video poster>` is *not* a supported marker target — the `#sanitize` step strips a `#`-prefixed poster before the upload step runs (its allowlist constrains posters to `http(s)://` or `assets/`). Reference posters as `http(s)` URLs, or host the image via `<img>` instead.

Two dedup layers result: the **cache** (yours) avoids re-downloading; the **content hash** (SRR's) avoids re-uploading. The cache root defaults to `$XDG_CACHE_HOME/srr` — override with `--cache-dir` / `SRR_CACHE_DIR`. It is disposable (the store is the source of truth) but **grows unbounded**: prune it yourself if disk is tight.

### Reference implementation

A minimal Python command. Replace the marked block with your real source; everything else is protocol boilerplate.

```python
#!/usr/bin/env python3
import os, sys, json, hashlib, urllib.request

def fnv1a32(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h

req = json.load(sys.stdin)          # {"url", "etag", "last_modified", "max_size", "asset_dir"}
cache = req.get("asset_dir")        # None when self-hosting is off; else the cwd

def host(media_url: str) -> str:
    """Download media_url into the cache dir (the cwd) once; return its marker."""
    if not cache:
        return media_url            # no self-hosting: keep the original URL
    name = hashlib.sha256(media_url.encode()).hexdigest() + ".jpg"
    if not os.path.exists(name):    # cwd is the cache dir; relative path is fine
        urllib.request.urlretrieve(media_url, name)
    return "#/" + name              # SRR uploads the file and rewrites this to assets/<hash>

# --- your source: produce rows of (id, title, html, link, iso_date | None) ---
img = host("https://example.com/photo.jpg")
rows = [("post-123", "Hello", f'<p>Hi</p><img src="{img}">', "https://example.com/123", "2024-03-01T12:00:00Z")]
# ------------------------------------------------------------------------------

items = [{
    "guid": fnv1a32(rid or link),   # any stable string -> uint32
    "title": title,
    "content": html,
    "link": link,
    "published": date,              # RFC 3339 string, or None
} for (rid, title, html, link, date) in rows]

json.dump({"items": items}, sys.stdout)
```

## Pipe Pipeline

Articles pass through a chain of mods during fetch. The pipe is defined at two levels — root (db.gz default) and per channel — and channels inherit the root unless they explicitly override.

**Built-in mods:**

- `#sanitize` — HTML sanitization (bluemonday)
- `#minify` — HTML minification (tdewolff/minify)
- `#readability` — fetches an item's `Link` and replaces `Content` with the extracted article body (for teaser-only feeds; fail-open)

**Custom mods** — any shell command that reads/writes JSON via stdin/stdout (see [External mod protocol](#external-mod-protocol)):

```bash
srr chan add -t "Feed" -u https://example.com/rss \
  -p "#sanitize" -p "#minify" -p "jq '.content |= ascii_downcase'"
```

### External mod protocol

A pipeline step whose first word is not a built-in `#`-token is run as an external mod: `/bin/sh -c <step>` is invoked **once per item**, in SRR's process working directory, with the process environment inherited and `stderr` passed through to the terminal (use it for logging). Unlike an external ingest command, an external mod is **not** handed an `asset_dir`, so it cannot self-host files — it only transforms the item it is given.

**stdin** is the full item as a single JSON object (HTML-escaping disabled, so `<`/`>`/`&` are emitted verbatim):

| Field | Type | Description |
|---|---|---|
| `guid` | uint32 | The dedup key. **Immutable** — must be echoed back unchanged. |
| `title` | string | Article title. |
| `content` | string | Article HTML — the field most mods rewrite. |
| `link` | string | Canonical article URL. |
| `published` | string \| null | RFC 3339 timestamp, or `null` for dateless items. **Immutable.** |
| `raw` | object | The parsed feed entry, keyed by element name; each value carries the short keys `@` (text), `$` (attributes), `+` (children). Restored by SRR after the round-trip, so a mod need not preserve it. |

**stdout** is either the same JSON object back (with `title`/`content`/`link` optionally changed) **or** empty/whitespace — an empty result is a **no-op** that leaves the item unchanged (the opposite of an external ingest command, where empty stdout is an error). `guid` and `published` must be returned unchanged, and `raw` is restored by SRR regardless of what the mod emits.

**Example.** For one item from a `#rss` source, SRR writes this object to the mod's stdin (pretty-printed). `raw` mirrors the parsed feed entry — element name → list of occurrences, each `{@: text, $: attributes, +: children}`; it is `null` for items from an external ingest command, which don't populate it:

```json
{
  "guid": 3542072042,
  "title": "Hello world",
  "content": "<p>First post.</p>",
  "link": "https://example.com/123",
  "published": "2024-03-01T12:00:00Z",
  "raw": {
    "title": [{ "@": "Hello world" }],
    "link": [{ "@": "https://example.com/123" }],
    "guid": [{ "@": "post-123", "$": { "isPermaLink": "false" } }],
    "description": [{ "@": "<p>First post.</p>" }],
    "pubDate": [{ "@": "Fri, 01 Mar 2024 12:00:00 GMT" }],
    "category": [{ "@": "tech" }, { "@": "news" }]
  }
}
```

To uppercase the title, the mod prints the same object back with only `title` changed — it may drop `raw` (SRR restores it) but must echo `guid` and `published` unchanged:

```json
{"guid":3542072042,"title":"HELLO WORLD","content":"<p>First post.</p>","link":"https://example.com/123","published":"2024-03-01T12:00:00Z"}
```

Printing nothing (or only whitespace) leaves the item exactly as received.

**Behavior contract.**

- stdout is capped at 64 MiB; exceeding it errors.
- The command is killed if it runs longer than the subprocess time budget — 5m by default, overridable via `SRR_CMD_TIMEOUT` (a Go duration; a value that doesn't parse or is ≤ 0 is ignored and the 5m default applies).
- A **non-zero exit code**, an **unmarshalable** stdout, or a mod that **changes `guid` or `published`** does *not* fail the feed: SRR logs a WARN and **drops just that one item**, then continues with the rest of the batch.

A minimal reference mod — lowercase every title — using `jq`:

```bash
srr chan add -t "Feed" -u https://example.com/rss \
  -p "#base" -p "jq -c '.title |= ascii_downcase'"
```

**Hierarchy & resolution.** A `pipe` field lives at two levels: db.gz root (`srr pipe`) and channel (`srr chan add -p ...` / `srr chan upd -p ...`). For each channel the effective pipeline is resolved root → channel:

- An absent channel `pipe` inherits the root pipe.
- A present channel `pipe` overrides root (an explicit empty list means "no pipe").
- The `#base` token in a channel override expands inline to the root pipe.

For example, with root `[#sanitize]` and channel override `[#base, #minify]`, the channel runs `#sanitize → #minify`.

**Root default.** When root `pipe` is absent from `db.gz`, the backend substitutes `["#sanitize", "#minify"]` at load time so fresh installs (and DBs predating this feature) get safe-by-default sanitization and minification. Run `srr pipe <args>` to override; `srr pipe ""` clears the stored value, reverting to the default on the next load. To opt out for a specific channel regardless of the root default, use `srr chan upd <id> -p ""` (sets an explicit empty override).

## Pack Format

Articles are stored in two gzip-compressed series under each channel directory, alongside a `db.gz` metadata file:

- **`idx/`** — Binary index (header + 2-byte entries per article); split every 50,000 articles.
- **`data/`** — JSONL article content (one record per line); split when the gzip-compressed pack exceeds `--pack-size` KB.

`idx/` finalized packs are 0-indexed (`idx/0.gz`..`idx/N-1.gz`); `data/` finalized packs start at id 1 (`data/1.gz`..) — the writer bumps `next_pid` before the first data entry, so `data/0.gz` is never produced. For each series the latest (mutable) pack rotates between `true.gz` and `false.gz` via the `data_tog` flag in `db.gz`, so CDNs can serve finalized packs with `force-cache`.

This format is optimized for static file hosting with efficient incremental client sync.
