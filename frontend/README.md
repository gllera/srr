# SRR Frontend

Static RSS Reader frontend -- a single-page app that reads gzip-compressed pack files directly from any CDN or static host. Zero runtime dependencies.

## Install

```bash
npm ci
```

## Development

```bash
npm run dev       # Parcel dev server (default :1234) + `serve` for ../packs/ with CORS (default :3000)
npm run build     # Production build to ../dist/srrf/
npm test          # Unit tests (vitest + jsdom)
npm run lint      # ESLint
npm run format       # Prettier write
npm run format-check # Prettier check (used by CI)
```

Or from the repo root:

```bash
make dev-fe       # Dev server
make test-fe      # Tests
make lint-fe      # ESLint
make verify-fe    # Full pipeline: lint + format check + test + build
```

## Build

```bash
npm run build
```

Output goes to `../dist/srrf/` (repo-root `dist/srrf/`). Set the `SRR_CDN_URL` environment variable at build time to point at your pack storage:

```bash
SRR_CDN_URL=https://cdn.example.com/feeds npm run build
```

### Image proxy

Article images can be rewritten through an image proxy that fronts them with transcoding and bandwidth limits. No proxy is configured by default — the raw `<img src>` from the feed is used unless the user opts in.

Open the channel menu and click the image-proxy icon to set a prefix. Any URL-encoded-source-appender proxy works (wsrv.nl, imgproxy, imagor with proper config, etc.). Leave the field empty to disable proxying. The choice is saved in localStorage under `srr-img-proxy`.

## Architecture

Entry point: `src/index.html` -> `src/js/app.ts`. Bundled with Parcel 2.

| Module | Role |
|--------|------|
| `app.ts` | UI rendering, events, keyboard shortcuts, error popup. All async actions go through a `guard()` mutex. |
| `nav.ts` | Navigation state machine: hash routing, traversal, filtering. Returns `IShowFeed`. |
| `data.ts` | CDN data layer: fetches `db.gz`, loads binary idx packs at init, fetches JSONL data packs on demand (LRU-cached). |
| `idx.ts` | Binary idx pack parser: lazy `parse()` into `chanIds`/`fetchedAts` typed arrays + `bounds`; per-pack `findLeft`/`findRight`/`countLeft`. |
| `dropdown.ts` | Channel-menu dropdown (channel/tag picker + time-range chips). |
| `gestures.ts` | Touch swipes (prev/next, cycle filter) + scroll-based toolbar hide. |
| `cache.ts` | Generic LRU cache factory (`makeLRU`). |
| `fmt.ts` | Pure utilities: HTML sanitization (rewrites images through configurable proxy — passthrough by default, runtime override via localStorage), relative time, date formatting. |
| `types.d.ts` | Ambient types: `IDB`, `IChannel`, `IFeed`, `IArticle`, `IShowFeed`. |

### Data Flow

```
app  -->  nav  -->  data  -->  idx
          nav  -->  data  (LRU-cached data packs)
app  -->  dropdown  -->  {data, nav}
app  -->  gestures  -->  {nav, dropdown}
app  -->  fmt
```

## Features

- **Streaming decompression** -- pack bodies pass through `DecompressionStream`; idx packs decode into an `ArrayBuffer`, data packs go through `TextDecoderStream` with partial-line buffering for JSONL.
- **Aggressive caching** -- every pack name is write-once (finalized `N.gz`, latest generation `L<seq>.gz`), so all packs use HTTP `force-cache`; only `db.gz` revalidates. Data packs are kept in an in-memory LRU (max 20).
- **Filtering** -- filter by channel or tag via URL hash filter segment (channel IDs or tag names, `+`-separated after `!`)
- **Dark mode** -- automatic via `prefers-color-scheme`
- **No runtime deps** -- the built bundle has zero npm dependencies

## URL Hash Format

```
#chronIdx!token1+token2
```

| Segment | Description |
|---------|-------------|
| `chronIdx` | Current article position (0-based) |
| `!tokens` | Optional `+`-separated filter tokens (channel IDs or tag names); each `encodeURIComponent`-wrapped |

## Deployment

The `release.yml` workflow's `pages` job builds and deploys to GitHub Pages on version tags (`v*.*.*`) or manual trigger. It reads `SRR_CONFIG_INLINE` from the `ci` environment secret and extracts `cdn-url:` from that YAML at build time.

## Stack

- TypeScript (strict mode)
- Parcel 2
- Plain CSS (native nesting, `srr-` class prefix)
- Vitest + jsdom for testing
- ESLint + Prettier
