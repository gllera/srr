# SRR Frontend

Static RSS Reader frontend -- a single-page app that reads gzip-compressed pack files directly from any CDN or static host. Zero runtime dependencies.

## Install

```bash
npm ci
```

## Development

```bash
npm run dev       # Parcel dev server (default :1234) + CORS pack server (:3000) for the configured store ($SRR_STORE -> config store: -> ../packs)
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

Without it, the build resolves `cdn-url:` from the active SRR config, falling back to `"."` — packs are then fetched relative to the deployed `index.html`, so the bundle can be self-hosted from the store root itself (see `srr frontend update`).

### Image proxy

Article images can be rewritten through an image proxy that fronts them with transcoding and bandwidth limits. No proxy is configured by default — the raw `<img src>` from the feed is used unless the user opts in.

Open the feed menu and click the image-proxy icon to set a prefix. Any URL-encoded-source-appender proxy works (wsrv.nl, imgproxy, imagor with proper config, etc.). Leave the field empty to disable proxying. The choice is saved in localStorage under `srr-img-proxy`.

## Architecture

Entry point: `src/index.html` -> `src/js/app.ts`. Bundled with Parcel 2.

| Module | Role |
|--------|------|
| `app.ts` | UI orchestrator: rendering, events, keyboard shortcuts, error popup, surface switching (list / reader; the filter picker and settings menu are popups). All async actions go through a `guard()` mutex. |
| `list.ts` | List surface (home): bidirectional infinite headline window anchored at the filter's reading position, virtualized via `content-visibility`. |
| `picker.ts` | Filter-picker overlay ([ALL] / ★ Saved / tags / feeds with unread counts, Show-read + Info toggles), the feed/tag/store info dialogs, and the freshness status footer (`renderStatus`). |
| `nav.ts` | Navigation state machine: hash routing, traversal, filtering (feed/tag, ★ saved, title-search modes), seen tracking. Returns `IShowFeed`. |
| `data.ts` | CDN data layer: boots from `db.gz` + the idx header summary + the latest idx pack; finalized idx packs, JSONL data packs and meta cards load lazily on demand (LRU-cached). |
| `idx.ts` | Binary idx pack parser: lazy `parse()` into a `feedIds` typed array + data-pack `bounds`; per-pack `findLeft`/`findRight`/`countLeft`. |
| `search.ts` | Title search over the derived `meta/` shards, bloom-pruned. |
| `dropdown.ts` | Centered modal dialogs (image proxy, backup/restore, sync) + anchored context-menu cards (`showContextMenu` — the settings and frontier menus). |
| `refresh.ts` / `sync.ts` | Live content sync (an open tab silently adopts a newer store snapshot via conditional `db.gz` GETs) / cross-device sync engine over the portable profile. |
| `gestures.ts` | Touch swipes (prev/next, cycle filter) + scroll-based toolbar hide. |
| `cache.ts` | Generic LRU cache factory (`makeLRU`) + promise-caching helpers. |
| `fmt.ts` | Pure utilities: HTML sanitization (image-proxy rewrite, relative URLs resolved against the pack base), relative time, date formatting. |
| `pin.ts` / `profile.ts` | Offline-pin registry / portable backup-restore of reader state. |
| `base.ts` / `keys.ts` / `urlish.ts` | `PACK_BASE` (the URL packs resolve against) / localStorage key constants / shared http(s)-URL validation rules. |
| `sw-grammar.ts` + `../sw.ts` | Service worker: cache-first pack/asset/shell caching + offline pinning; the pack-name grammar is extracted for unit testing. |
| `format.gen.ts` | **Generated** (`make generate`) from the backend Go declarations: format constants + wire types. Do not edit. |
| `types.d.ts` | Ambient types: `IDB`, `IFeed`, `IArticle`, `IShowFeed`. |

### Data Flow

```
app  -->  {list, picker}  -->  {nav, data, fmt}
app  -->  nav  -->  {data, search}
nav  -->  data  -->  {idx, cache, base}
app  -->  {gestures, dropdown, pin, refresh, sync, fmt}
```

## Features

- **Streaming decompression** -- pack bodies pass through `DecompressionStream`; idx packs decode into an `ArrayBuffer`, data packs go through `TextDecoderStream` with partial-line buffering for JSONL.
- **Aggressive caching** -- every pack name is write-once (finalized `N.gz`, latest generation `L<seq>.gz`), so all packs use HTTP `force-cache`; only `db.gz` revalidates. Data packs are kept in an in-memory LRU (max 20).
- **Filtering** -- filter by feed or tag via URL hash filter segment (feed IDs or tag names, `+`-separated after `!`); ★ saved and unread-only modes on top
- **Title search** -- bloom-pruned search over the derived `meta/` shards; shareable `#!q:<query>` hash filter
- **Offline (PWA)** -- installable manifest + a cache-first service worker (write-once packs, hashed shell assets); any filter can be pinned for offline reading
- **Dark mode** -- automatic via `prefers-color-scheme`
- **No runtime deps** -- the built bundle has zero npm dependencies

## URL Hash Format

```
#chronIdx!token1+token2
```

| Segment | Description |
|---------|-------------|
| `chronIdx` | Current article position (0-based) |
| `!tokens` | Optional `+`-separated filter tokens (feed IDs or tag names); each `encodeURIComponent`-wrapped |

## Deployment

Two supported shapes, both built by `release.yml` on version tags (`v*.*.*`) or manual trigger:

- **Hosted reader** (cross-origin packs): the `cf-pages` job builds with the `SRR_CDN_URL` secret from the `ci` environment and deploys `dist/srrf/` to Cloudflare Pages.
- **Self-hosted from the store root** (same origin): the `release` job attaches the SPA as `srrf.tar.gz` built with **no** cdn-url, so packs resolve relative to `index.html`; install it into a store root next to `db.gz` with `srr frontend update`.

## Stack

- TypeScript (strict mode)
- Parcel 2
- Plain CSS (native nesting, `srr-` class prefix)
- Vitest + jsdom for testing
- ESLint + Prettier
