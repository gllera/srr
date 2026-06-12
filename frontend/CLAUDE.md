# CLAUDE.md

## Project

SRR Frontend — single-page RSS reader. Zero runtime deps. Parcel + TypeScript + plain CSS.

## Commands

`npm run dev|build|test|lint|format` — dev server, production build (`../dist/srrf/`), vitest+jsdom, ESLint, Prettier.

## Architecture

Entry: `src/index.html` → `src/styles.css` + `src/js/app.ts`. Bundler: Parcel 2. `SRR_CDN_URL` is replaced at build time via `parcel/resolve-cdn-url.js`. Resolution: env var → `cdn-url:` from `$SRR_CONFIG_INLINE` (raw YAML) → `cdn-url:` from `$SRR_CONFIG` (file path, default `$XDG_CONFIG_HOME/srr/srr.yaml`) → fallback `http://localhost:3000`.

Dependency chain: `app → nav → data → {idx, cache}`, `app → fmt`, `app → dropdown → {data, nav}`, `app → gestures → {nav, dropdown}`. All in `src/js/`, strict mode.

| Module | Role |
|---|---|
| `idx.ts` | Binary idx pack parsing. Exports `IDX_PACK_SIZE` (50000), `IdxPack` interface, `makeIdxPack()`. |
| `data.ts` | CDN data layer: fetches `db.gz`, loads all idx packs at init via `makeIdxPack()`. Fetches JSONL data packs on demand. Exports `db`, `init`, `loadArticle(chronIdx)`, `getChannelId(chronIdx)`, `findChronForTimestamp(ts)`, `findLeft`, `findRight`, `countLeft`, `groupChannelsByTag()`. Re-exports `IDX_PACK_SIZE`. |
| `nav.ts` | Navigation state machine: hash routing (`#pos[!tokens]`), traversal, filtering. Returns `IShowFeed`. Uses `pushState`/`replaceState`. Tokens are channel IDs or tag names. Exports `filter`, `fromHash`, `left`, `right`, `first`, `last`, `switchFilter`, `goTo`, `cycleFilter`, `getFilterEntries`, `getCurrentFilterKey`, `isSingleFilter`, `pruneSeen`. |
| `cache.ts` | `makeLRU<T>(maxSize)`: LRU cache via Map insertion order. Used by `data.ts` for data-pack caching. |
| `fmt.ts` | Pure utilities (no DOM imports): `sanitizeHtml`, `timeAgo`, `formatDate`, `URL_DENY`, `imgProxy(url, prefix)`, `getImgProxy()`, `setImgProxy(value)`, `extractImageUrls(html)` (regex-scrapes `<img src>` — both quoted and unquoted values, the latter to catch `#minify`'s quote-stripped CDN URLs — and returns only http(s) URLs; used by nav.ts prefetch). `sanitizeHtml` strips dangerous elements/attributes for defense-in-depth and resolves the proxy prefix once per call. Relative URLs: `<img src>`/`<video src>`/`<video poster>`/`<a href>` values that are *relative references* (no URL scheme — the self-hosted `assets/` keys plus any other relative URL the feed carried, including protocol-relative `//host`) resolve against the pack base (`new URL(SRR_CDN_URL, location.href)` — same as data.ts's `DB_URL`, no `data.ts` import to avoid its eager `db.gz` fetch) and bypass the image proxy, dropped (attribute removed) when the resolved URL escapes that base (bounds-checked — a `//host` or sub-path `../` traversal off-origin is an info-leak vector); external http(s) image/poster URLs keep the proxy path, external video URLs and anchor hrefs pass through (a link is navigation, not an auto-loaded resource). `imgProxy(url, prefix)` requires the caller to pass the resolved prefix — production callers hoist `getImgProxy()` out of per-image loops. Effective prefix comes from localStorage `srr-img-proxy` (set via channel dropdown image-proxy icon); empty/absent = passthrough (no proxy by default). |
| `dropdown.ts` | Channel-menu dropdown: own DOM lookups + open/close state. Exports `closeAllDropdowns()` and `showChannelMenu(currentTag, guard)`. The currently-shown article's tag and the `guard` mutex are passed in from `app.ts` to keep state ownership clear. |
| `gestures.ts` | Touch and scroll handlers: one-finger swipe = prev/next, two-finger vertical swipe = cycle filter, scroll-down hides toolbar. Exports `setupGestures({ prev, next, toolbar, guard })`. |
| `app.ts` | UI orchestrator: DOM lookups, render, channel-label refresh, error popup, keyboard handler, `guard()` mutex, init. Async handlers always go through `guard()`. Position persisted to localStorage. |
| `types.d.ts` | Ambient types: `IDB`, `IChannel`, `IFeed`, `IArticle`, `IShowFeed`. |

CSS: native nesting, `srr-` prefix on all classes, dark mode via `prefers-color-scheme`.

## Data Structures

See root `CLAUDE.md` Data Contract for db.gz, IChannel, IArticle, pack format, CDN layout, and chronIdx.

Frontend-specific additions:
- `channels` in `IDB` is `Record<number, IChannel>` (JSON object keyed by channel ID); defaults to `{}` if absent. `channel.id` is populated from object keys at init.
- **IArticle**: `{ s, a, p, t, l, c }` — chan_id, fetched_at, published, title, link, content. Loaded from JSONL data packs.
- **IShowFeed**: `{ article, has_left, has_right, filtered, channel, countRight }` — `countRight`: always `number` (never null); count of filtered articles strictly after `pos`.
- Dev: `../packs/` sibling directory served on port 3000 with CORS.

## Key Behaviors

**guard() mutex** (app.ts): all async UI actions go through it. Drops concurrent calls. On error → popup with retry.

**Eager fetch**: `data.ts` starts `fetch("db.gz")` at module load (before `init()` call).

**Init**: `data.init()` loads all idx packs in parallel, calls `makeIdxPack()` (from `idx.ts`) to lazily parse each binary pack into `chanIds`/`fetchedAts` typed arrays and `bounds`. Latest packs use `data_tog` filename toggle.

**Article loading**: `loadArticle(chronIdx)` resolves pack+offset via binary search on `IdxPack.bounds`, fetches and parses the JSONL data pack (LRU-cached by pack ID, max 20 packs).

**Neighbor prefetch** (nav.ts): after each `left()`/`right()`, `schedulePrefetch(nextLeft/nextRight)` warms the neighbor's images on `requestIdleCallback` (`{timeout:500}`) — it `loadArticle()`s the neighbor, runs `fmt.extractImageUrls()` over its content, and for each URL creates an `Image` with `fetchPriority="low"`/`decoding="async"` and `img.src = imgProxy(...)`. `abortPrefetch()` cancels in-flight loads by setting `img.src=""` (WHATWG image-update steps) and dropping the refs. The `currentPrefetch` array (also the freshness token: a pending idle callback bails when `my !== currentPrefetch`) bounds memory to one neighbor at a time. Edits to nav must preserve this abort/freshness discipline.

**Content fade-in**: double `requestAnimationFrame` for opacity transition.

## State Machines (nav.ts)

State: `pos` (chronIdx), `filter` (object with `active`, `channels`, `chanTotal`, `tokens`, `matches()`, `clear()`, `set(tokens)`).

**`filter`** — active when `tokens` non-empty:
- `filter.clear()`: empties tokens, repopulates `channels` from all channels with `total_art > 0`
- `filter.set(tokens)`: resolves tokens (numeric channel IDs or tag names) into `channels` map (`chan_id → add_idx`); falls back to `clear()` if no token resolves
- `last(token?)`: no arg = use current filter; `""` = clear filter; otherwise `filter.set([token])`; always jumps to last matching article
- `goTo(idx)`: navigate to chronIdx; if filter active and target doesn't match, snap forward to next match; falls back to `last()` if none
- `switchFilter(token)`: sets filter to token (or clears if `""`); resumes at last seen position for that channel/tag if valid, otherwise jumps to `first()`
- `cycleFilter(dir)`: steps through `getFilterEntries()` by `dir` (+1/-1), calls `switchFilter()`
- `getFilterEntries()`: returns `["", "tagName", ..., "channelId", ...]` built via `data.groupChannelsByTag()`
- `getCurrentFilterKey()`: returns `""`, the single token, or `""` for multi-token filters (URL-only edge case)
- Navigation uses `findLeft`/`findRight` — synchronous linear scans via `data.getChannelId()`
- Hash: `#pos[!tokens]` — `!` segment, `+`-separated tokens, each `encodeURIComponent`-wrapped to survive special chars in tag names.

**Time-range jumps** (dropdown.ts channel menu): "8h"/"16h"/"1d"/"7d" chips compute `Math.floor(Date.now()/1000) - seconds` (unix seconds; the chips carry `t:<seconds>` data-values — `t:28800`/`t:57600`/`t:86400`/`t:604800`), look up `data.findChronForTimestamp(ts)`, and call `nav.goTo(chron)` so the user lands at the article from that point and can navigate right.

## Test Patterns

`src/js/nav.test.ts` — large nav suite. `src/js/data.test.ts` — pure-function cases only. `src/js/idx.test.ts` — idx binary-parsing unit tests. `src/js/fmt.test.ts` — sanitizeHtml / timeAgo / formatDate tests. `src/js/cache.test.ts` — LRU cache tests.

**nav.test.ts**:
- **Mock**: `vi.hoisted()` + `vi.mock("./data", ...)` with same shape as data.ts exports. Mocks `getChannelId`, `loadArticle`, `groupChannelsByTag`, `findLeft`, `findRight`, `countLeft`, `findChronForTimestamp`.
- **Reset**: `beforeEach` resets data state, calls `nav.filter.clear()`, and re-spies `history.pushState`/`replaceState`.
- **Helpers**: `makeArticle(overrides)`, `makeChannel(overrides)` — factory with defaults. `setupIndex(entries)` — populates `db.channels` and wires `getChannelId`/`loadArticle` mocks.
- **Hash checks**: spy on `history.pushState`/`replaceState` (note the spy accumulates across tests in the same describe).

**data.test.ts**: mocks `./data` with inline reimplementations of `findChronForTimestamp` and `groupChannelsByTag` driven by writable `db`/`fetchedAts` state — data.ts's module-load `fetch` would otherwise fire under jsdom.

**E2e (`e2e/`)** — writer↔reader contract: the unit tests above mock `./data`; the e2e suite runs the REAL `srrb` binary to write packs from canned feeds (`e2e/harness.ts` `srr()` + in-process `feedServer()`, `e2e/fixtures.ts`), then reads them back with the REAL frontend code. Two layers + their own configs (excluded from `npm test` via `vitest.config.ts` `test.exclude`):
- **contract** (`e2e/contract/`, `vitest.contract.config.ts`, jsdom, in `make verify`): `mountReader()` installs a `fetch` shim mapping CDN URLs → store files (raw `.gz` bytes, no `Content-Encoding` — data.ts decompresses via `DecompressionStream`), `vi.resetModules()` + dynamic-imports the real `data.ts`/`nav.ts` (its module-load `db.gz` fetch must hit the shim, so stub-before-import), then asserts every chronIdx round-trips, pack splits, dedup/toggle, and nav filtering. Cross-checks `srr inspect --validate`.
- **browser** (`e2e/browser/`, `vitest.browser.config.ts`, Puppeteer, opt-in via `make test-browser`/`test-e2e`): `serve.ts` global-setup builds the real bundle with relative `SRR_CDN_URL=/packs/` and serves it + a per-run pack dir from one origin; scenarios drive headless Chrome (render, keyboard nav, deep-link, tag filter). Reuses the Chromium under `~/.cache/puppeteer/` (`puppeteer` pinned to 25.0.2). Gotcha: set `Connection: close` + `server.closeAllConnections()` or `server.close()` stalls on Chrome keep-alive sockets.
- Content that must force data-pack splits has to be incompressible (`fixtures.ts` seeded alphanumeric) — packs roll on COMPRESSED size (`db_pack.go` `data.Len() >= PackSize<<10`).

## Conventions

- 3-space indent, no semicolons in TypeScript
- ESLint + Prettier (`eslint.config.mjs`, `.prettierrc`)

## Deployment

GitHub Actions (`release.yml` `pages` job): version tags (`v*.*.*`) or manual. Deploys to GitHub Pages. Reads `SRR_CONFIG_INLINE` (a `ci` environment secret carrying YAML config) and extracts `cdn-url:` from it at build time.
