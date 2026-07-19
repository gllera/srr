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

Commands are grouped under `feed` (feed management), `art` (articles), `preview`, `inspect`, `config`, and `version`. Group names have short aliases (`f`, `a`, `p`, `i`, `c`).

| Command            | Description                                        |
|--------------------|----------------------------------------------------|
| `feed add`         | Subscribe to a new feed (one feed URL); always allocates a fresh id |
| `feed upd <id>`    | Update a feed (`-t` title, `-g` tag, `-r` recipe, `-i` ingest / `-p` pipe feed-level overrides; `-u` repoints the single feed URL) |
| `feed rm`          | Unsubscribe from feed(s) by id                  |
| `feed ls`          | List feeds (`-g` tag filter, `-f` format)       |
| `feed show <id>`   | Print one feed (yaml/json)                      |
| `feed edit <id>`   | Edit a feed's JSON in `$EDITOR`                 |
| `feed apply`       | Upsert feed(s) from JSON (`--file` or stdin)    |
| `feed import`      | Import feeds from an OPML file                  |
| `art fetch`        | Fetch new articles from all feeds               |
| `art ls`           | List stored articles                               |
| `recipe`           | Manage processing recipes (named `{ingest, pipe}` bundles) |
| `preview`          | Preview processed feed articles in a browser       |
| `inspect`          | Validate pack consistency / debug chronIdx lookups |
| `config`           | Print resolved configuration                       |
| `version`          | Print version information                          |

### Examples

```bash
# Add a feed (uses the 'default' recipe automatically)
srr feed add -t "Tech News" -u https://example.com/feed.xml -g tech/news

# Create a recipe and assign it to a feed
srr recipe set readability -p "#readability" -p "#default"
srr feed add -t "Blog" -u https://example.com/rss -r readability

# List all recipes
srr recipe ls

# Show one recipe
srr recipe show readability

# Update a feed's recipe
srr feed upd 1 -r readability

# Feed-level overrides: this one feed runs its own pipe on top of its recipe
# (#default expands to the recipe's effective pipe); -i overrides the ingest
srr feed upd 1 -p "#default" -p "#selfhost"
srr feed upd 1 -i "myfetch --token=\$TOK"

# Clear the feed-level overrides again (back to the recipe's values)
srr feed upd 1 -p "" -i ""

# Repoint a feed at a new feed URL (resets its fetch/dedup state)
srr feed upd 1 -u https://example.com/new-feed.xml

# List feeds (filter by tag)
srr feed ls -g tech

# List feeds as JSON
srr feed ls -f json

# Fetch all feeds
srr art fetch

# Fetch with 8 concurrent workers
srr -w 8 art fetch

# Import from OPML (all feeds)
srr feed import feeds.opml -a

# Import selectively with a recipe and dry-run
srr feed import feeds.opml -i "1" -i "2.3" -r readability -n

# Preview a feed using the default recipe
srr preview https://example.com/feed.xml

# Preview with a named recipe
srr preview https://example.com/feed.xml -r readability

# Preview with ad-hoc pipe override (does not require a saved recipe)
srr preview https://example.com/feed.xml -p "#readability" -p "#default"
```

## Global Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-w, --workers` | nproc | Concurrent downloads |
| `-s, --pack-size` | 200 | Target pack size (KB) |
| `-m, --max-feed-size` | 5000 | Max feed download size (KB) |
| `--max-asset-size` | 25000 | Max self-hosted asset object size (KB), enforced **at download** by the self-hosting mod (`#selfhost`) and passed to ingest commands as `max_asset_size`: an over-cap asset is skipped, leaving its remote URL — not stored. The upload step no longer re-checks (only the `--asset-process` output keeps a fail-soft guard at the same size). |
| `--asset-process` | (none) | Command run on every self-hosted asset just before upload to transcode/process its bytes (e.g. `webify -m 720`, or `conv -i {input} -o {output}`); the cache-file path is substituted for each `{input}` token (or appended when absent). With an `{output}` token the command writes its result to that file and prints a `{mimetype,extension,encoding}` JSON to stdout (setting the stored Content-Type/-Encoding); without `{output}`, processed bytes are read from stdout. Non-zero exit or empty output keeps the original; skipped when the source was already uploaded. The command's stderr is captured, not passed through (so a transcoder's progress narration doesn't clutter srr's output); on failure its tail is included in the logged warning. Empty disables. |
| `--asset-peek` | (none) | Command run on every self-hosted asset (before the dedup check) to identify it: it receives the cache-file path (`{input}` token or appended) and prints a `{mimetype,extension,supported}` JSON to stdout. The extension becomes the stored object's extension (so a transcoded asset carries its true output extension, while dedup still keys on the source bytes) and the mimetype its Content-Type; `supported:false` hosts the original bytes and skips `--asset-process`. Non-zero exit or invalid JSON falls back to the source extension. Empty disables. |
| `--asset-workers` | nproc | Max assets processed concurrently across all feeds (peek/transcode/upload); independent of `--workers`. |
| `--asset-process-timeout` | 0 (unlimited) | Timeout for a single `--asset-process` **or** `--asset-peek` command invocation (Go duration). `0` (the default) means **unlimited** — no deadline, since media transcoding can run arbitrarily long; the command is still bounded by run cancellation (SIGINT/SIGTERM). The shared `--cmd-timeout` governs ingest/mod commands only and never affects asset work. |
| `--cache-dir` | $XDG_CACHE_HOME/srr | Download cache root for self-hosted external-ingest media |
| `-o, --store` | packs | Storage destination |
| `--force` | false | Override DB write lock |
| `-d, --debug` | false | Enable debug logging |
| `--cmd-timeout` | 5m | Timeout for a single external ingest/mod command (Go duration). Does **not** bound `--asset-process`/`--asset-peek` — those use `--asset-process-timeout`. |
| `--allow-private-fetch` | false | Disable the SSRF guard (allow fetching feeds/media from private/loopback addresses) — security override |
| `--cdn-url` | (none) | Absolute CDN base URL (`SRR_CDN_URL`). Hidden from `--help`; consumed by frontend builds and **required** for syndication output (`out/`, `srr syndicate`) — syndication is skipped with a warning when unset. |

Global flags can also be set via environment variables (prefixed `SRR_`, e.g. `SRR_WORKERS`, `SRR_CMD_TIMEOUT`, `SRR_ALLOW_PRIVATE_FETCH`) or in a YAML config file using their long flag names as keys:

```yaml
# $XDG_CONFIG_HOME/srr/srr.yaml (or override path with $SRR_CONFIG,
# or pass the YAML content directly via $SRR_CONFIG_INLINE)
workers: 4
pack-size: 500
store: /path/to/packs
```

Precedence: CLI flags > env vars > config file > defaults. `$SRR_CONFIG_INLINE`, when set, supersedes `$SRR_CONFIG`. Run `srr config` to print the resolved values; a value's env var is shown in brackets only when its name deviates from the conventional `SRR_<FIELD>` derivation (a derivable name is omitted to cut noise).

**Per-command flags** are also YAML-settable, but **nested under their command path** (using the command names, not the aliases) rather than at the top level — a top-level `interval:` is ignored, `art: { fetch: { interval: … } }` is applied:

```yaml
store: /path/to/packs      # global (top-level)
art:
  fetch:
    interval: 30m          # art fetch --interval  (SRR_FETCH_INTERVAL)
serve:
  addr: localhost:8088     # serve --addr          (SRR_SERVE_ADDR)
  interval: 30m            # serve --interval      (SRR_SERVE_INTERVAL)
```

The command-scoped keys that carry an env var (all take a CLI flag, env var, or the nested YAML key above):

| Command | Nested YAML key | Flag / env | Default | Description |
|---------|-----------------|-----------|---------|-------------|
| `art fetch` | `art.fetch.interval` | `--interval` / `SRR_FETCH_INTERVAL` | 0 (single run) | Run fetch in a loop at this interval (`0` = fetch once and exit). |
| `serve` | `serve.addr` | `--addr` / `SRR_SERVE_ADDR` | localhost:8088 | Admin GUI listen address (loopback only by default). |
| `serve` | `serve.interval` | `--interval` / `SRR_SERVE_INTERVAL` | 0 (off) | Also run a background fetch loop at this interval. |
| `preview` | `preview.addr` | `--addr` / `SRR_PREVIEW_ADDR` | localhost:8080 | Preview HTTP listen address. |
| `frontend update` | `frontend.update.repo` | `--repo` / `SRR_FE_REPO` | gllera/srr | GitHub `owner/name` to install the reader release from. |

### Secrets

A top-level `secrets:` section in `srr.yaml` defines extra environment variables that are merged into the environment of **external ingest strategies and external (shell) mods** — handy for passing credentials to an external command without exporting them into your shell or service unit. It does **not** affect the `asset-process` / `asset-peek` commands.

```yaml
secrets:
  TG_API_ID: "12345"
  TG_API_HASH: "abcdef0123..."
```

A secret **overrides** any ambient process-env variable of the same name (config wins). Values are stored in **plaintext** in `srr.yaml`, so restrict the file (`chmod 600`). `srr config` lists the keys but masks the values (`TG_API_ID: ********`), and supports `srr config secrets` / `srr config secrets.TG_API_ID`. Secrets are read once at startup, so restart a running `art fetch --interval` loop after editing them.

## Storage Backends

The output path (`-o`) determines which backend is used:

| Backend | Example | Notes |
|---------|---------|-------|
| Local | `srr -o ./packs art fetch` | Default. Auto-creates directories. |
| S3 | `srr -o s3://bucket/prefix art fetch` | Uses standard AWS SDK credentials. |
| SFTP | `srr -o sftp://user@host/path art fetch` | Auth: URL password, config password, config private key, `~/.ssh/` keys, or SSH agent. |
| HTTP | `srr -o https://host/prefix art fetch` | A WebDAV-style or S3-compatible endpoint: GET reads, PUT writes, DELETE removes. Auth: URL userinfo (basic) or config `token` (bearer). Exclusive create (the `.locked` marker) uses `If-None-Match: *`, so locking is best-effort on servers that ignore conditional requests. |

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

# HTTP backend (applies to both http:// and https:// store URLs)
http:
  token: bearer-token...   # sent as "Authorization: Bearer <token>"
  headers:                 # extra request headers on every operation
    CF-Access-Client-Id: xxx       # e.g. Cloudflare Access service tokens
    CF-Access-Client-Secret: yyy   # an Authorization entry here wins over `token`
  insecure: false          # skip TLS certificate verification
```

`http.headers` values may be credentials, so `srr config` masks the whole map. Set entries in YAML or through the `SRR_HTTP_HEADERS` env var — comma-separated `Name: value` entries (split on the first colon per entry, whitespace-trimmed): `SRR_HTTP_HEADERS="CF-Access-Client-Id: xxx, CF-Access-Client-Secret: yyy"`. The env value replaces the YAML map whole (env beats YAML, as everywhere); a header value containing a comma is only expressible in YAML. The backend refuses to follow a redirect on a write or delete (a 301/302/303 would silently downgrade PUT/DELETE to GET in Go's HTTP client and fake a success) — point the store URL at the canonical origin; plain GETs still follow redirects.

SFTP auth chain (in order): URL password → config password → config `private-key` → `~/.ssh/` keys → SSH agent. Uses `~/.ssh/known_hosts` for host key verification by default. Set `insecure: true` to skip verification.

Every backend field is also overridable by an environment variable named `SRR_<SCHEME>_<FIELD>` — the scheme and the YAML key upper-cased with dashes turned into underscores — which beats the YAML value (same env-over-YAML precedence as the global flags). For example:

| YAML | Environment variable |
|------|----------------------|
| `s3.region` | `SRR_S3_REGION` |
| `s3.access-key-id` | `SRR_S3_ACCESS_KEY_ID` |
| `s3.secret-access-key` | `SRR_S3_SECRET_ACCESS_KEY` |
| `sftp.user` | `SRR_SFTP_USER` |
| `sftp.private-key` | `SRR_SFTP_PRIVATE_KEY` |
| `sftp.insecure` | `SRR_SFTP_INSECURE` |

Backend env names are conventional by construction (`SRR_<SCHEME>_<FIELD>`, shown in the table above), so `srr config` does not repeat them inline.

## Ingest Strategies

An *ingest strategy* is the I/O + parse step that turns a subscription URL into a list of articles, before the [pipe pipeline](#pipe-pipeline) transforms them. The default strategy, `#feed`, fetches the URL over HTTP and parses RSS/Atom/RDF. If the URL returns an HTML page instead of a feed, `#feed` auto-discovers the feed via `<link rel="alternate">` in the HTML `<head>` and retries from that URL (one-hop guard — no loops); on success the feed's stored URL is updated to the discovered one. Sources that aren't feeds — a private API, a site that needs scraping, anything bespoke — are handled by an **external command** that speaks a small JSON protocol. No rebuild is required, and nothing source-specific lives in this repo.

**Auto-discovery runs at subscribe time, too.** For `#feed` feeds, `srr feed add`, `srr feed upd -u` (when the URL changes), and `srr feed import` resolve the URL the moment you subscribe — paste a site's homepage and SRR stores its actual feed URL. `add`/`upd -u` **hard-fail** if no feed can be found at the URL (nothing is stored); `import` is **partial-success** — it imports every feed it can resolve and reports the rest (so one dead URL in a large OPML doesn't block the batch). These commands therefore make a network request; `feed apply`/`feed edit` stay offline. The same discovery still runs at fetch time as a fallback, so a feed URL that later starts redirecting to a homepage self-heals.

### Selecting a strategy

The effective strategy is resolved per feed. Each feed names one recipe (`-r/--recipe` at add/upd/import time; empty or absent ⇒ `default`) and may carry its own feed-level override (`-i/--ingest` on `feed add`/`upd`; `-i ""` clears it). First non-empty wins: the feed's own `ingest`, then its recipe's, then the `default` recipe's; if all are empty, the built-in `#feed` is used. Recipes are managed with `srr recipe`.

Built-in strategy names start with `#` (only `#feed` ships built-in). **Any value that does not start with `#` is run as a shell command** via `/bin/sh -c`.

```bash
# Create a recipe that uses an external ingest command
srr recipe set mytelegram -i "myfetch --token=$TOK"

# Route one feed through it
srr feed add -t "My source" -u "https://example.com/x" -r mytelegram

# Make an external command the default for every feed
srr recipe set default -i "myfetch"

# Or override just one feed, without touching any recipe
srr feed upd 1 -i "myfetch --token=$TOK"

# Preview with an ad-hoc ingest override (does not require a saved recipe)
srr preview "https://example.com/x" -i "myfetch --token=$TOK"
```

### External command protocol

The command receives a JSON **request** on `stdin` and must print a JSON **response** on `stdout`. `stderr` is passed through to the terminal — use it for logging. The process environment is inherited, so `SRR_*` and any credentials already in the environment are available to the command; the `srr.yaml` [`secrets:`](#secrets) section is merged in too (overriding any ambient value of the same name).

**Request** (stdin):

| Field | Type | Description |
|---|---|---|
| `url` | string | The subscription URL (the feed feed URL). |
| `etag` | string | The `etag` your command returned last run (empty on first call). |
| `last_modified` | string | The `last_modified` your command returned last run. |
| `max_size` | int | Advisory cap (bytes) on what the command should buffer/return. |
| `max_asset_size` | int | Size cap (bytes) for any single file you self-host via a `#`-marker. **Honor it at download**: skip an over-cap file and leave its remote URL — the caller's upload step trusts the marker and no longer re-checks size. Absent/0 = no asset cap. |
| `asset_dir` | string | Persistent download cache for self-hosting files, shared by all feeds (see below). The command also **runs with this as its working directory**. Absent when self-hosting is off (e.g. `srr preview`). |

**Response** (stdout):

| Field | Type | Description |
|---|---|---|
| `not_modified` | bool | `true` if nothing changed since `etag`/`last_modified`; `items` is then ignored. |
| `etag` | string | Opaque cursor echoed back on the next request (optional). |
| `last_modified` | string | Opaque cursor echoed back on the next request (optional). |
| `items` | array | The articles (each item below). |
| `title` | string | The feed's own channel-level title (optional). Read by the admin GUI's add-feed check (`GET /api/resolve`) to pre-fill the title; the fetch loop ignores it — a stored feed's title is operator-owned. |

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
{"url":"https://example.com/x","etag":"","last_modified":"","max_size":5119999,"max_asset_size":25600000,"asset_dir":"/home/you/.cache/srr"}
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

- A **non-zero exit code** fails the fetch for that feed only (the error is recorded in the feed's `ferr`); all other feeds still fetch and commit.
- **Empty stdout is an error** — emit at least `{"items":[]}` (or `{"not_modified":true}`).
- stdout is capped at 64 MiB; exceeding it fails the fetch.
- The command is killed if it runs longer than the subprocess time budget — 5m by default, overridable via the `--cmd-timeout` flag / `SRR_CMD_TIMEOUT` env (a Go duration; ≤ 0 falls back to the 5m default). A killed command fails the fetch for that feed, so long-running sources must finish within the budget or raise it. The command must not block waiting for more stdin after consuming the single request object.
- `not_modified: true` (or a response with zero `items`) **preserves** the feed's dedup state, so a transient empty response won't drop it.

### Self-hosting files

For files SRR can't fetch itself — images, video, or linked documents behind authentication, say — the command downloads the bytes and lets SRR mirror them into the store. SRR owns the store key and the upload, so the command needs no store credentials.

`asset_dir` is a **persistent directory shared by all feeds** that SRR creates and never deletes, and **runs the command in** (its working directory) — so the command reads and writes files with relative paths, choosing its own layout inside (namespace as needed, since every feed shares the dir). The command:

1. Downloads a file into the working directory (checking first — if it already exists, skip the download).
2. References it in item `content` with a **`#`-prefixed relative path**: a value that starts with `#` and names the downloaded file, e.g. `<img src="#/photo.jpg">`, `<video src="#/clip.mp4">`, or `<a href="#/report.pdf">`. (A plain `#fragment` that doesn't name a real downloaded file — an ordinary in-page anchor — is left alone.)

After the pipe pipeline runs, SRR's automatic final step scans each item's `content` for those markers in `<img src>` / `<video src>` / `<a href>`, hashes the referenced file, uploads it under `assets/<2-hex>/<16-hex><ext>` — a 2-char shard directory, the first 16 hex chars (64-bit prefix) of the file's sha256, plus the original extension (e.g. `assets/ab/abcdef0123456789.jpg`) — **only if not already present**, and rewrites the marker to that key. Identical bytes dedup to one stored object across feeds and runs. A marker pointing at a missing file is left as-is (a broken reference, never a failed fetch).

> **Note:** `<video poster>` is *not* a supported marker target — the `#sanitize` step strips a `#`-prefixed poster before the upload step runs (its allowlist constrains posters to `http(s)://` or `assets/`). Reference posters as `http(s)` URLs, or host the image via `<img>` instead.

> **Asset processing.** If the operator configured `--asset-process` / `SRR_ASSET_PROCESS` (e.g. `webify -m 720`), every asset is piped through that command to transcode/shrink its bytes just before upload — so a file you self-host may be re-encoded (and the size cap applies to the processed output). It runs only on the first upload of a given source file (re-used assets are never re-processed) and is fail-soft (a command error keeps the original bytes). By default the stored key keeps the *source* extension even if the format changes, and the object gets a generic `application/octet-stream` type — declare the real type either by adding an `{output}` token to `--asset-process` (its stdout JSON sets the Content-Type/-Encoding) or by configuring `--asset-peek` (its `extension`/`mimetype` set the stored key extension and Content-Type, and its `supported:false` skips processing). The dedup key always hashes the *source* bytes, so peek runs on every asset but processing still only runs on the first upload.

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

req = json.load(sys.stdin)          # {"url", "etag", "last_modified", "max_size", "max_asset_size", "asset_dir"}
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

Articles pass through a chain of mods during fetch. The pipe is defined per recipe and feeds reference a recipe by name (`-r/--recipe`); a feed may also carry its own feed-level pipe (`-p` on `feed add`/`upd`, repeatable; a lone `-p ""` clears it) which replaces its recipe's. The reserved `default` recipe seeds `["#sanitize","#minify"]`. The `#default` token expands inline to the next pipe down the chain: in a recipe's pipe, the `default` recipe's pipe (forbidden inside `default` itself); in a feed's pipe, the feed's effective recipe pipe.

**Built-in mods:**

- `#sanitize` — HTML sanitization (bluemonday)
- `#minify` — HTML minification (tdewolff/minify)
- `#readability` — fetches an item's `Link` and replaces `Content` with the extracted article body (for teaser-only feeds; fail-open)
- `#filter` — content-based item dropping (see [below](#filter))
- `#dedupmedia` — removes duplicate copies of the same image/video/audio within an article (WordPress featured-image-in-feed dupes, `-WxH` size variants, wp.com Photon proxies), keeping the richest copy and pruning emptied wrappers; inline emoji/spacer glyphs are exempt; place before `#sanitize` (e.g. `["#dedupmedia", "#default"]`) so its glyph heuristics see class/style attributes
- `#unlazy` — recovers lazy-loaded images before the sanitizer discards them: promotes `data-src`-style attributes to `src` on `<img>`/`<video>`/`<audio>`, fills a missing/placeholder `src` from the best `srcset` candidate, and unwraps `<noscript>` image fallbacks (dropping redundant ones); place before `#sanitize`, essential in pipes using `#readability`
- `#embed` — rewrites known-provider `<iframe>` embeds (YouTube incl. shorts/nocookie, Vimeo, Dailymotion, Spotify) into a linked thumbnail (when derivable) plus a labelled text link, so the post's video survives sanitization as a link instead of vanishing; unknown iframes are left for `#sanitize` to strip; place before `#sanitize`
- `#enclosure` — prepends media that rides outside the article body (RSS `<enclosure>`, Atom `<link rel="enclosure">`, `media:content`/`media:thumbnail` incl. `media:group`, `itunes:image`) as leading `<img>`/`<video controls>`/`<audio controls>` blocks; skips media already visible in the body; no-ops for external-ingest items; place before `#sanitize` (and before `#dedupmedia` if used)
- `#untrack` — strips tracking freight: beacon images (known endpoints or ≤2px declared), `utm_*`/`fbclid`-class query parameters from links and media URLs (other params preserved verbatim), and the trailing WordPress "The post … appeared first on …" footer; place before `#sanitize` and after `#unlazy`
- `#selfhost` — downloads remote `<img>`/`<video>`/`<audio>` media → `#`-marker → existing upload step converts (`SRR_ASSET_PROCESS`) and self-hosts to `assets/`; network-bound + fail-open per asset; place after `#default` so only sanitizer-approved media is downloaded (e.g. `["#default", "#selfhost"]`)

**Custom mods** — any shell command that reads/writes JSON via stdin/stdout (see [External mod protocol](#external-mod-protocol)):

```bash
srr recipe set lower -p "#default" -p "jq '.content |= ascii_downcase'"
srr feed add -t "Feed" -u https://example.com/rss -r lower
```

### External mod protocol

A pipeline step whose first word is not a built-in `#`-token is run as an external mod: `/bin/sh -c <step>` is invoked **once per item**, with the process environment inherited (plus the `srr.yaml` [`secrets:`](#secrets) section, which overrides any ambient value of the same name) and `stderr` passed through to the terminal (use it for logging).

On the fetch path, an external mod gets `SRR_ASSET_DIR` pointing at the run's shared asset cache dir — so a mod may download or place a file there and reference it in `content` with a `#`-prefixed relative path, exactly like an external ingest command ([above](#self-hosting-files)); the automatic end-of-pipeline upload step then ships it to the store. Markers are resolved by name against that directory, so the environment variable is the whole contract: unlike external *ingest*, a mod's **working directory is always inherited** from SRR's own process, on every path — a mod invoked by a relative path (`./mods/x.sh`) keeps working. `srr preview` leaves `SRR_ASSET_DIR` unset — a mod that places assets must detect that and pass items through untouched rather than writing markers nothing will ever upload.

**stdin** is the full item as a single JSON object (HTML-escaping disabled, so `<`/`>`/`&` are emitted verbatim):

| Field | Type | Description |
|---|---|---|
| `guid` | uint32 | The dedup key. **Immutable** — must be echoed back unchanged. |
| `title` | string | Article title. |
| `content` | string | Article HTML — the field most mods rewrite. |
| `link` | string | Canonical article URL. |
| `published` | string \| null | RFC 3339 timestamp, or `null` for dateless items. **Immutable.** |
| `raw` | object | The parsed feed entry, keyed by element name; each value carries the short keys `@` (text), `$` (attributes), `+` (children). Restored by SRR after the round-trip, so a mod need not preserve it. |
| `lang` | string | Optional ISO 639-1 language hint (see below) — auto-detected **before** the pipeline runs (or declared by the ingest strategy), so a mod sees it filled for any article whose language was confidently detected. Absent when detection was uncertain (short text, low confidence). |

**stdout** is either the same JSON object back (with `title`/`content`/`link` optionally changed) **or** empty/whitespace — an empty result is a **no-op** that leaves the item unchanged (the opposite of an external ingest command, where empty stdout is an error). `guid` and `published` must be returned unchanged, and `raw` is restored by SRR regardless of what the mod emits.

To **drop** an item (prevent it from being stored), emit `{"drop":true}` — or include it alongside other fields, e.g. `{"drop":true,"guid":…}`. A dropped item is silently discarded and its GUID is retained in the feed's dedup boundary so it is not re-evaluated on the next fetch. Dropping is not an error; subsequent pipeline steps are skipped for a dropped item.

A mod (or ingest strategy) may also override the article's language by emitting `lang` with an ISO 639-1 code, e.g. `{"lang":"es"}`. The field is **backend-internal**: it rides the pipeline (readable by later mods — `#filter keep_lang` decides from it) but is never written to the data packs, so readers never see it. SRR detects it automatically **before** the pipeline runs (unless the ingest strategy declared one — a declared value is never overwritten), with one re-attempt after the pipeline for items whose content a step like `#readability` grew past the detection gate — so every stored article carries a confident detection (or empty when detection stayed uncertain).

**Example.** For one item from a `#feed` source, SRR writes this object to the mod's stdin (pretty-printed). `raw` mirrors the parsed feed entry — element name → list of occurrences, each `{@: text, $: attributes, +: children}`; it is `null` for items from an external ingest command, which don't populate it:

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
- The command is killed if it runs longer than the subprocess time budget — 5m by default, overridable via the `--cmd-timeout` flag / `SRR_CMD_TIMEOUT` env (a Go duration; ≤ 0 falls back to the 5m default).
- A **non-zero exit code**, an **unmarshalable** stdout, or a mod that **changes `guid` or `published`** does *not* fail the feed: SRR logs a WARN and **drops just that one item**, then continues with the rest of the batch.

A minimal reference mod — lowercase every title — using `jq`:

```bash
srr recipe set lower -p "#default" -p "jq -c '.title |= ascii_downcase'"
srr feed add -t "Feed" -u https://example.com/rss -r lower
```

### #filter

`#filter` drops items that match (or fail to match) configurable predicates. A dropped item is never written to the packs, but its GUID is retained in the feed's dedup boundary so it is not re-evaluated on subsequent fetches.

**Parameters** (all optional; an item is dropped if it satisfies **any** active condition):

| Parameter | Form | Effect |
|---|---|---|
| `drop_title` | `/regex/[i]` | Drop when title matches the regex |
| `keep_title` | `/regex/[i]` | Drop when title does **not** match the regex |
| `drop_content` | `/regex/[i]` | Drop when content matches the regex |
| `keep_content` | `/regex/[i]` | Drop when content does **not** match the regex |
| `min_words` | integer | Drop when plain-text word count of content is below N |
| `keep_lang` | ISO 639-1 codes | Drop when the item's `lang` is set and **not** in the list |

Regex syntax: `/pattern/` or `/pattern/i` (flag `i` = case-insensitive). A malformed regex or unknown parameter is a hard configuration error. The word-count check (`min_words`) runs against the raw content string including any HTML tags. A regex param value **cannot contain a literal space** — the pipeline token is split on whitespace before its parameters are parsed — so use a whitespace metacharacter instead: `drop_title=/breaking\s+news/` or `drop_title=/breaking[ ]news/`, not `drop_title=/breaking news/`.

`keep_lang` does no detection of its own: it reads the item's backend-internal `lang` field — auto-detected before the pipeline runs, or declared by the ingest strategy or an earlier mod (see the external mod protocol above). **Fail-open**: an item whose `lang` is empty (short post, uncertain detection) always passes — the failure mode is a stray foreign article surviving, never a wanted article lost. Because the decision reads `lang`, a declared value is authoritative even when it contradicts the text, and content fetched mid-pipe (`#readability`) does not influence it. Codes are ISO 639-1 (`en,es`), matched case-insensitively and ignoring any region subtag — `EN`, `en-US` and `en` all mean the same thing, on both sides of the comparison, so a strategy that copies an RSS `<language>` verbatim still matches. A macrolanguage code admits every variety detection reports under it: `keep_lang=no` keeps Norwegian in both `nb` (Bokmål) and `nn` (Nynorsk). An unknown code is a hard configuration error, caught when the pipe is saved.

```bash
# Create a recipe that filters sponsored posts and low-word articles
srr recipe set filtered -p "#filter drop_title=/^(sponsored|ad):?/i min_words=100" -p "#default"
srr feed upd 3 -r filtered

# Create a recipe that keeps only golang articles
srr recipe set golang -p "#filter keep_title=/golang/i" -p "#default"
srr feed upd 5 -r golang

# Keep only English and Spanish articles
srr recipe set eng-es -p "#filter keep_lang=en,es" -p "#default"
srr feed upd 7 -r eng-es
```

**Recipe model.** Processing config lives in named `{ingest, pipe}` recipes (`srr recipe set/ls/show/rm`). Feeds reference one by name (`-r/--recipe`); empty or absent ⇒ `default`. Each axis (ingest, pipe) falls back to the `default` recipe independently. The `#default` token in a recipe's pipe expands inline to the `default` recipe's pipe (forbidden inside `default` itself).

For example, with `default` pipe `[#sanitize, #minify]` and a recipe `[#default, #selfhost]`, feeds using that recipe run `#sanitize → #minify → #selfhost`.

**Default recipe.** The `default` recipe is always present (seeded `["#sanitize","#minify"]` on a fresh or pre-recipes store). Update it via `srr recipe set default -p "#sanitize" -p "#minify"`. To extend it, create a named recipe that uses `#default`: `srr recipe set heavy -p "#readability" -p "#default"`. To opt a feed into a completely different pipeline without touching `default`, assign a recipe with the desired pipe and no `#default`.

## Pack Format

Articles are stored in two gzip-compressed series under each feed directory, alongside a `db.gz` metadata file:

- **`idx/`** — Binary index (header + 2-byte entries per article); split every 50,000 articles.
- **`data/`** — JSONL article content (one record per line); split when the gzip-compressed pack exceeds `--pack-size` KB.

`idx/` finalized packs are 0-indexed (`idx/0.gz`..`idx/N-1.gz`); `data/` finalized packs start at id 1 (`data/1.gz`..) — the writer bumps `next_pid` before the first data entry, so `data/0.gz` is never produced. For each series the latest pack is generation-named `L<seq>.gz` (the `seq` field in `db.gz`): each fetch that stores articles writes a new generation and never rewrites a published one, so every pack name is write-once and CDNs can serve the whole store (everything but `db.gz`) immutably. Expired generations beyond a small grace window (current + 2) are deleted after each fetch commit.

This format is optimized for static file hosting with efficient incremental client sync.
