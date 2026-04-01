# SRR Frontend

Static RSS Reader frontend -- a single-page app that reads gzip-compressed pack files directly from any CDN or static host. Zero runtime dependencies.

## Install

```bash
npm ci
```

## Development

```bash
npm run dev       # Dev server + static file server for ../packs/ on port 3000
npm run build     # Production build to dist/
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

Output goes to `dist/`. Set the `SRR_CDN_URL` environment variable at build time to point at your pack storage:

```bash
SRR_CDN_URL=https://cdn.example.com/feeds npm run build
```

## Architecture

Entry point: `src/index.html` -> `src/js/app.ts`. Bundled with Parcel 2.

| Module | Role |
|--------|------|
| `app.ts` | UI rendering, events, dropdowns, dark mode, error popup. All async actions go through a `guard()` mutex. |
| `nav.ts` | Navigation state machine: hash routing, traversal, filtering, floor. Returns `IShowFeed`. |
| `data.ts` | CDN data layer: fetches `db.gz`, streams gzip TSV idx packs, loads null-delimited data packs. Dual LRU caches. |
| `ts.ts` | Time-series layer: fetches/caches weekly ts/ packs, provides `findCandidateIdxPacks` for filtered navigation. |
| `cache.ts` | Generic LRU cache factory. |
| `fmt.ts` | Pure utilities: HTML sanitization, relative time, date formatting. |
| `types.d.ts` | Ambient types: `IDB`, `ISub`, `IIdxEntry`, `IShowFeed`. |

### Data Flow

```
app  -->  nav  -->  data  (CDN fetches)
          nav  -->  ts   -->  data
app  -->  ts
app  -->  fmt
```

## Features

- **Streaming decompression** -- idx packs are streamed through `DecompressionStream` + `TextDecoderStream` with partial-line buffering
- **Lazy content loading** -- metadata renders immediately, article content loads async with generation counter to discard stale loads
- **Aggressive caching** -- finalized packs use HTTP `force-cache`; latest packs use filename toggle (`true.gz`/`false.gz`) for cache busting
- **Filtering** -- filter by subscription or tag via URL hash filter segment (sub IDs or tag names, `+`-separated after `!`)
- **Floor** -- set a lower bound on navigation to skip old articles (`~chronIdx` in hash)
- **Dark mode** -- automatic via `prefers-color-scheme`
- **No runtime deps** -- the built bundle has zero npm dependencies

## URL Hash Format

```
#chronIdx~floor!token1+token2
```

| Segment | Description |
|---------|-------------|
| `chronIdx` | Current article position (0-based) |
| `~floor` | Optional navigation floor (lower bound) |
| `!tokens` | Optional `+`-separated filter tokens (sub IDs or tag names) |

## Deployment

The GitHub Actions workflow (`gh-pages.yml`) builds and deploys to GitHub Pages on version tags (`v*.*.*`) or manual trigger. It uses the `SRR_CDN_URL` repository variable.

## Stack

- TypeScript (strict mode)
- Parcel 2
- Plain CSS (native nesting, `srr-` class prefix)
- Vitest + jsdom for testing
- ESLint + Prettier
