# SRR

Static RSS Reader -- a self-hosted RSS reader designed for static file hosting. No server runtime needed: a CLI fetches feeds into compact pack files, and a static single-page app reads them directly from any CDN or file server.

## How It Works

```
srr art fetch  --->  pack files (idx/ + data/ + db.gz)  --->  static SPA reader
   (CLI)             stored on S3 / SFTP / local              served via CDN
```

1. **Backend CLI** fetches RSS/Atom/RDF feeds and writes articles into gzip-compressed pack series optimized for incremental sync and HTTP caching.
2. **Frontend SPA** loads the packs directly from any static host -- no API server, no database at runtime.

Every pack name is write-once — finalized packs are numeric, the latest pack is generation-named (`L<seq>.gz`) — so the whole store is cached indefinitely; only the small `db.gz` manifest revalidates.

## Quick Start

### Fetch feeds

```bash
# Download the latest release binary (Linux amd64 example)
curl -sL "$(curl -s https://api.github.com/repos/gllera/srr/releases/latest \
  | grep browser_download_url | grep linux-amd64 | cut -d'"' -f4)" -o srr
chmod +x srr

# Add a feed
./srr feed add -t "Hacker News" -u https://hnrss.org/frontpage

# Fetch articles to local directory
./srr art fetch

# Or fetch to S3
./srr -o s3://my-bucket/feeds art fetch
```

### Serve the reader

```bash
cd frontend && npm ci && npm run build
# Deploy dist/srrf/ (at the repo root) to any static host
# Set SRR_CDN_URL at build time to point at your pack storage
```

Or self-host the reader from the same store as the packs — one origin serves both:

```bash
# Downloads the latest srrf.tar.gz release asset and uploads it into the store
# root (next to db.gz), tracking files in sitemap.txt for clean upgrades.
./srr -o ./packs frontend update
```

### Automate

The included GitHub Actions workflow (`cron.yml`) runs `srr art fetch` on manual dispatch, and the `pages` job in `release.yml` deploys the frontend on version tags.

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
| `ci.yml` | Push to `main`, PRs | Runs `make verify` (lint, format, FE+BE tests, builds, jsdom e2e contract) and `make test-browser` (Puppeteer) in parallel jobs |
| `release.yml` (`release` job) | `v*.*.*` tag | Cross-compiles backend binaries and bundles the SPA as `srrf.tar.gz`, creates GitHub release (`srr frontend update` installs the SPA from this asset) |
| `release.yml` (`pages` job) | `v*.*.*` tag or manual | Builds and deploys frontend to GitHub Pages |
| `cron.yml` | Manual dispatch | Downloads latest `srr` binary and runs `srr a fetch` against the configured store |
