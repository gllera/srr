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
