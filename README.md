# SRR

Static RSS Reader -- a self-hosted RSS reader designed for static file hosting. No server runtime needed: a CLI fetches feeds into compact pack files, and a static single-page app reads them directly from any CDN or file server.

## How It Works

```
srr art fetch  --->  pack files (idx/ + data/ + db.gz)  --->  static SPA reader
   (CLI)             stored on S3 / HTTP / SFTP / local       served via CDN
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

The included GitHub Actions workflow (`cron.yml`) runs `srr art fetch` on manual dispatch, and the `cf-pages` job in `release.yml` deploys the hosted reader to Cloudflare Pages on version tags.

## MCP

`srr` exposes its store to MCP clients (Claude Code, Claude Desktop, …) as a small tool set, so an assistant can read the store and manage subscriptions without shelling out to the CLI. The tools wrap the very same functions the CLI and the admin GUI call, so the three surfaces cannot drift.

### Tools

| Tool | What it does | Network | Store |
|---|---|---|---|
| `srr_overview` | Whole-store snapshot in one read: every feed with its config and fetch-health vitals, tag buckets, recipes, syndication slots, store counters, running version. Start here to learn feed ids, tags and recipe names. | no | read |
| `srr_list_articles` | Stored articles, newest first, with feed/tag, title-query and `since`/`until` filters plus cursor pagination. Content omitted unless `include_content` is set. | no | read |
| `srr_preview_feed` | Dry-run a URL through the ingest + processing pipeline and return the articles it *would* store. Nothing is written. | yes | read |
| `srr_resolve_feed` | Probe a URL for the canonical feed URL, its title and item count — the look-before-you-subscribe check. | yes | none |
| `srr_add_feed` | Subscribe to a new feed (subscribe-time discovery folds a homepage to the feed it advertises). | yes | write |
| `srr_update_feed` | Change an existing feed's settings. **Merge semantics**: only the fields you supply change; omitted fields keep their stored value, and an explicit empty value clears where clearing is allowed. | on `url` change | write |
| `srr_fetch` | Run one full fetch cycle now (optionally restricted to feed ids), including retention, derived summaries and syndication outputs. | yes | write |

### Registering it

Over the HTTP endpoint `srr serve` mounts at `/mcp` (loopback):

```bash
srr -o ./packs serve                                    # admin GUI + /mcp on :8088
claude mcp add --transport http srr http://localhost:8088/mcp
```

Over stdio, where the client spawns the process itself:

```bash
claude mcp add srr -- srr mcp
```

Remotely, when `srr serve` sits behind a Cloudflare tunnel + Access (the deployment `admin-srr.llera.eu` uses). **Operator step, not part of srr**: create an Access *Service Auth* policy for the hostname and issue a service token, then pass its two headers:

```bash
claude mcp add --transport http srr https://admin-srr.llera.eu/mcp \
  --header "CF-Access-Client-Id: <id>" \
  --header "CF-Access-Client-Secret: <secret>"
```

Use a `headersHelper` in `.mcp.json` instead of literal `--header` values to keep the secret out of a checked-in config.

### Caveats

- **`srr_fetch` can run for minutes** with no intermediate progress — the endpoint is stateless with plain JSON replies, so there are no progress notifications. Raise the client's tool timeout when a whole-store fetch is expected: `MCP_TOOL_TIMEOUT=600000` (ms).
- **Writes contend with the fetch loop.** `srr_add_feed`, `srr_update_feed` and `srr_fetch` take the store lock; while a `srr serve --interval` cycle holds it they return `store busy: fetch cycle in progress; retry shortly` — the same 409 contract the admin GUI reports. Retry, don't change the arguments.
- **`srr_list_articles`' exact `Total` with `query` reads every data pack inside the window.** Pair `query` with `since` (e.g. `"7d"`) on a large store.
- The endpoint inherits serve's loopback Host guard, and `/mcp` exposes a strict subset of what `/api/*` already offers the same caller — there is no separate on/off flag.

## Project Structure

```
backend/    Go CLI -- feed fetcher and pack writer
frontend/   TypeScript SPA -- static feed reader
```

| Component | Stack | Details |
|-----------|-------|---------|
| [Backend](backend/) | Go | CLI via kong, storage backends (local, S3, SFTP, HTTP), module pipeline |
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
| HTTP | `-o https://host/path` | WebDAV-style PUT/DELETE endpoint; basic auth, bearer token, or custom headers |

## CI/CD

| Workflow | Trigger | Action |
|----------|---------|--------|
| `ci.yml` | Push to `main`, PRs | Runs `make verify` (lint, format, FE+BE tests, builds, jsdom e2e contract) and `make test-browser` (Puppeteer) in parallel jobs |
| `release.yml` (`release` job) | `v*.*.*` tag | Cross-compiles backend binaries and bundles the SPA as `srrf.tar.gz`, creates GitHub release (`srr frontend update` installs the SPA from this asset) |
| `release.yml` (`cf-pages` job) | `v*.*.*` tag or manual | Builds the reader with the `SRR_CDN_URL` secret and deploys it to Cloudflare Pages |
| `cron.yml` | Manual dispatch | Downloads latest `srr` binary and runs `srr a fetch` against the configured store |
