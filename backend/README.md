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
| `chan add`         | Subscribe to a feed or update an existing channel  |
| `chan rm`          | Unsubscribe from channel(s) by id                  |
| `chan add-feed`    | Add URL(s) to an existing channel                  |
| `chan rm-feed`     | Remove URL(s) from an existing channel             |
| `chan ls`          | List channels (`-g` tag filter, `-f` format)       |
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
srr chan add-feed 1 https://example.com/alt-feed.xml

# Remove a feed URL from a channel
srr chan rm-feed 1 https://example.com/alt-feed.xml

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
| Local | `srr -o ./packs fetch` | Default. Auto-creates directories. |
| S3 | `srr -o s3://bucket/prefix fetch` | Uses standard AWS SDK credentials. |
| SFTP | `srr -o sftp://user@host/path fetch` | Auth: URL password, config password, config private key, `~/.ssh/` keys, or SSH agent. |

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

**Behavior contract.**

- A **non-zero exit code** fails the fetch for that channel; other channels still proceed.
- **Empty stdout is an error** — emit at least `{"items":[]}` (or `{"not_modified":true}`).
- stdout is capped at 64 MiB; exceeding it fails the fetch.
- `not_modified: true` (or a response with zero `items`) **preserves** the channel's dedup state, so a transient empty response won't drop it.

### Self-hosting files

For files SRR can't fetch itself — images, video, or linked documents behind authentication, say — the command downloads the bytes and lets SRR mirror them into the store. SRR owns the store key and the upload, so the command needs no store credentials.

`asset_dir` is a **persistent directory shared by all feeds** that SRR creates and never deletes, and **runs the command in** (its working directory) — so the command reads and writes files with relative paths, choosing its own layout inside (namespace as needed, since every feed shares the dir). The command:

1. Downloads a file into the working directory (checking first — if it already exists, skip the download).
2. References it in item `content` with a **`#`-prefixed relative path**: a value that starts with `#` and names the downloaded file, e.g. `<img src="#/photo.jpg">`, `<video src="#/clip.mp4">`, or `<a href="#/report.pdf">`. (A plain `#fragment` that doesn't name a real downloaded file — an ordinary in-page anchor — is left alone.)

After the pipe pipeline runs, SRR's automatic final step scans each item's `content` for those markers in `<img src>` / `<video src>` / `<a href>`, hashes the referenced file, uploads it under `assets/<sha256-of-bytes>` **only if not already present**, and rewrites the marker to that key. Identical bytes dedup to one stored object across feeds and runs. A marker pointing at a missing file is left as-is (a broken reference, never a failed fetch).

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

**Custom mods** — any shell command that reads/writes JSON via stdin/stdout:

```bash
srr chan add -t "Feed" -u https://example.com/rss \
  -p "#sanitize" -p "#minify" -p "jq '.content |= ascii_downcase'"
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

Finalized packs are immutable and named `0.gz`..`N-1.gz`; the latest (mutable) pack rotates between `true.gz` and `false.gz` via a `data_tog` flag in `db.gz` so CDNs can serve finalized packs with `force-cache`.

This format is optimized for static file hosting with efficient incremental client sync.
