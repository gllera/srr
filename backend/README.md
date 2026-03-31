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

| Command   | Description                                      |
|-----------|--------------------------------------------------|
| `add`     | Subscribe to a feed or update an existing one     |
| `rm`      | Unsubscribe from feed(s)                          |
| `ls`      | List subscriptions (`-g` tag filter, `-f` format) |
| `fetch`   | Fetch new articles from all subscriptions         |
| `import`  | Import subscriptions from an OPML file            |
| `preview` | Preview processed feed articles in a browser      |
| `version` | Print version information                         |

### Examples

```bash
# Add a subscription
srr add -t "Tech News" -u https://example.com/feed.xml -g tech/news

# Add with processing pipeline
srr add -t "Blog" -u https://example.com/rss -p "#sanitize" -p "#minify"

# Update an existing subscription
srr add --upd 1 -p "#sanitize"

# List subscriptions (filter by tag)
srr ls -g tech

# List subscriptions as JSON
srr ls -f json

# Fetch all feeds
srr fetch

# Fetch with 8 concurrent workers
srr -w 8 fetch

# Import from OPML (all feeds)
srr import feeds.opml -a

# Import selectively with dry-run
srr import feeds.opml -i "1" -i "2.3" -n

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
# $XDG_CONFIG_HOME/srr/srr.yaml (or override path with $SRR_CONFIG)
workers: 4
pack-size: 500
store: /path/to/packs
```

Precedence: CLI flags > env vars > config file > defaults.

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

## Module Pipeline

Subscriptions can define a processing pipeline that transforms articles during fetch.

**Built-in modules:**

- `#sanitize` — HTML sanitization (bluemonday)
- `#minify` — HTML minification (tdewolff/minify)

**Custom modules** — any shell command that reads/writes JSON via stdin/stdout:

```bash
srr add -t "Feed" -u https://example.com/rss \
  -p "#sanitize" -p "#minify" -p "jq '.content |= ascii_downcase'"
```

## Pack Format

Articles are stored in three gzip-compressed series:

- **`idx/`** — TSV metadata index (split every 1000 articles)
- **`data/`** — Article content, null-byte separated (split at target pack size)
- **`ts/`** — Timestamped delta snapshots (split by week)

This format is optimized for static file hosting with efficient incremental client sync.

