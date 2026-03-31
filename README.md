# SRR

Static RSS Reader -- a self-hosted RSS reader designed for static file hosting. No server runtime needed: a CLI fetches feeds into compact pack files, and a static single-page app reads them directly from any CDN or file server.

## How It Works

```
srr fetch  --->  pack files (idx/ + data/ + ts/)  --->  static SPA reader
  (CLI)           stored on S3 / SFTP / local            served via CDN
```

1. **Backend CLI** fetches RSS/Atom/RDF feeds and writes articles into gzip-compressed pack series optimized for incremental sync and HTTP caching.
2. **Frontend SPA** loads the packs directly from any static host -- no API server, no database at runtime.

Finalized packs are immutable and cached indefinitely; only the latest pack rotates via a filename toggle for cache busting.

## Quick Start

### Fetch feeds

```bash
# Download the latest release binary (Linux amd64 example)
curl -sL "$(curl -s https://api.github.com/repos/gllera/srr/releases/latest \
  | grep browser_download_url | grep linux-amd64 | cut -d'"' -f4)" -o srr
chmod +x srr

# Add a feed
./srr add -t "Hacker News" -u https://hnrss.org/frontpage

# Fetch articles to local directory
./srr fetch

# Or fetch to S3
./srr -o s3://my-bucket/feeds fetch
```

### Serve the reader

```bash
cd frontend && npm ci && npm run build
# Deploy frontend/dist/ to any static host
# Set SRR_CDN_URL at build time to point at your pack storage
```

### Automate

The included GitHub Actions workflow (`cron.yml`) runs `srr fetch` on a schedule, and `gh-pages.yml` deploys the frontend on version tags.

## Project Structure

```
backend/    Go CLI -- feed fetcher and pack writer
frontend/   TypeScript SPA -- static feed reader
```

| Component | Stack | Details |
|-----------|-------|---------|
| [Backend](backend/) | Go | CLI via kong, storage backends (local, S3, SFTP), module pipeline |
| [Frontend](frontend/) | TypeScript, Parcel, plain CSS | Zero runtime deps, streaming decompression, LRU caching |

## Development

```bash
make install        # npm ci for frontend
make verify         # full check: lint + format + test + build (both projects)
make dev-fe         # frontend dev server
make test-be        # backend unit tests
make test-fe        # frontend unit tests
```

See [backend/README.md](backend/README.md) and [frontend/README.md](frontend/README.md) for component-specific docs.

## Storage Backends

| Backend | Flag | Example |
|---------|------|---------|
| Local filesystem | `-o ./packs` | Default |
| S3 | `-o s3://bucket/prefix` | AWS SDK credentials |
| SFTP | `-o sftp://user@host/path` | SSH keys or agent |

## CI/CD

| Workflow | Trigger | Action |
|----------|---------|--------|
| `release.yml` | `v*.*.*` tag | Tests backend, builds cross-platform binaries, creates GitHub release |
| `gh-pages.yml` | `v*.*.*` tag or manual | Builds and deploys frontend to GitHub Pages |
| `cron.yml` | Every 5 minutes or manual | Fetches feeds to S3 |
