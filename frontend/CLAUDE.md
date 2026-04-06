# CLAUDE.md

## Project

SRR Frontend — single-page RSS reader. Zero runtime deps. Parcel + TypeScript + plain CSS.

## Commands

`npm run dev|build|test|lint|format` — dev server, production build (`dist/`), vitest+jsdom, ESLint, Prettier.

## Architecture

Entry: `src/index.html` → `src/styles.css` + `src/js/app.ts`. Bundler: Parcel 2. `SRR_CDN_URL` replaced at build time.

Dependency chain: `app → nav → data → idx`, `data → cache`, `app → fmt`. All in `src/js/`, strict mode.

| Module | Role |
|---|---|
| `idx.ts` | Binary idx pack parsing. Exports `IDX_PACK_SIZE` (50000), `IdxPack` interface, `makeIdxPack()`. |
| `data.ts` | CDN data layer: fetches `db.gz`, loads all idx packs at init via `makeIdxPack()`. Loads JSONL data packs on demand (LRU cache, size 5). Exports `loadArticle(chronIdx)`, `getArticleSync(chronIdx)`, `findChronForTimestamp(ts)`, `abortPending()`, `groupSubsByTag()`. Re-exports `IDX_PACK_SIZE`. |
| `nav.ts` | Navigation state machine: hash routing (`#floor,pos[!tokens]`), traversal, filtering, floor. Returns `IShowFeed`. Uses `pushState`/`replaceState`. Tokens are sub IDs or tag names. Exports `cycleFilter(dir)`, `getFilterEntries()`, `getCurrentFilterKey()`. |
| `cache.ts` | Generic LRU cache factory (`makeLRU`). Used by data.ts. |
| `fmt.ts` | Pure utilities (no imports): `sanitizeHtml`, `timeAgo`, `formatDate`. `sanitizeHtml` strips dangerous elements/attributes for defense-in-depth. |
| `app.ts` | UI: DOM rendering, events, dropdowns, error popup, loading, dark mode. All async handlers via `guard()` mutex. Position persisted to localStorage. Registers service worker (`sw.ts`) on init. |
| `sw.ts` | Service worker. Caching strategies: `cacheFirst` for finalized packs (`N.gz`), custom `getDB` (stale-while-revalidate with validity flag) for `db.gz`, `cacheFirst`/`networkFirst` for latest packs (`true.gz`/`false.gz`) depending on DB validity. Cache name: `srr-v1`. |
| `types.d.ts` | Ambient types: `IDB`, `ISub`, `IArticle`, `IShowFeed`. |

CSS: native nesting, `srr-` prefix on all classes, dark mode via `prefers-color-scheme`.

## Data Structures

See root `CLAUDE.md` Data Contract for db.gz, ISub, IArticle, pack format, CDN layout, and chronIdx.

Frontend-specific additions:
- `subscriptions` in `IDB` is `Record<number, ISub>` (JSON object keyed by subscription ID); defaults to `{}` if absent. `sub.id` is populated from object keys at init.
- **IArticle**: `{ s, a, p, t, l, c }` — sub_id, fetched_at, published, title, link, content. Loaded from JSONL data packs.
- **IShowFeed**: `{ article, has_left, has_right, filtered, floor, sub, countLeft }` — `countLeft`: always `number` (never null).
- Dev: `../packs/` sibling directory served on port 3000 with CORS.

## Key Behaviors

**guard() mutex** (app.ts): all async UI actions go through it. Drops concurrent calls. On error → popup with retry.

**Eager fetch**: `data.ts` starts `fetch("db.gz")` at module load (before `init()` call).

**Init**: `data.init()` loads all idx packs in parallel, calls `makeIdxPack()` (from `idx.ts`) to lazily parse each binary pack into `subIds`/`fetchedAts` typed arrays and `bounds`. LRU(5) cache for data packs keyed by pack ID. HTTP `force-cache` for finalized packs. Latest packs use `data_tog` filename toggle.

**Article loading**: `loadArticle(chronIdx)` resolves pack+offset via binary search on `IdxPack.bounds`, fetches and parses JSONL data pack. `getArticleSync(chronIdx)` returns from cache only (no fetch).

**Content fade-in**: double `requestAnimationFrame` for opacity transition. `data.abortPending()` cancels in-flight fetches when a new article is rendered.

## State Machines (nav.ts)

State: `pos` (chronIdx), `filter` (object with `active`, `subs`, `tokens`, `matches()`, `clear()`, `set(tokens)`), `floorChron`.

**`filter`** — inactive when `tokens` is empty (`ALL_SUBS` proxy matches everything); active when tokens set:
- `toggleFilter()`: inactive ↔ single-sub filter on current article's sub
- `last(subId)`: sets filter to single sub
- `last()` when filtered: preserves current filter
- `filter.set(tokens)`: resolves tokens (numeric sub IDs or tag names) into `subs` map (`sub_id → add_idx`)
- `applyFilter(tokens)`: calls `filter.set()` or `filter.clear()`, then navigates
- `cycleFilter(dir)`: steps through `getFilterEntries()` list by `dir` (+1/-1), calls `applyFilter()`
- `getFilterEntries()`: returns `["", "tag:x", ..., "subId", ...]` built via `data.groupSubsByTag()`
- `getCurrentFilterKey()`: maps current filter state to a key matching `getFilterEntries()` format
- Navigation uses `findLeft`/`findRight` — synchronous linear scans via `data.getSubId()`
- Hash: `!` segment, `+`-separated tokens (sub IDs or tag names)

**`floorChron`** — `0` (no floor) or chronIdx lower bound:
- Constrains `left()` and `has_left`; does NOT prevent `load()` below floor
- Hash: always the `floor` part before the comma (e.g. `#0,pos` when no floor, `#N,pos` when set)
- `setFloorHere()` / `clearFloor()` — synchronous, return `IShowFeed`

## Test Patterns

`src/js/nav.test.ts` — ~141 cases. `src/js/data.test.ts` — 13 cases (pure functions only).

**nav.test.ts**:
- **Mock**: `vi.hoisted()` + `vi.mock("./data", ...)` with same shape as data.ts exports. Mocks `getSubId`, `loadArticle`, `getArticleSync`, `groupSubsByTag`, `activeSubs`.
- **Reset**: `beforeEach` resets all data state + `nav.filter.clear()` + `nav.setFloorChron(0)`
- **Helpers**: `makeArticle(overrides)`, `makeSub(overrides)` — factory with defaults. `setupIndex(entries)` — populates `db.subscriptions` and wires `getSubId`/`loadArticle`/`getArticleSync` mocks.
- **Hash checks**: spy on `history.pushState`/`replaceState`

**data.test.ts**: mocks the module, re-exports pure functions (`numFinalizedIdx`, `findChronForTimestamp`) with writable `db`/`fetchedAts` state.

## Conventions

- 3-space indent, no semicolons in TypeScript
- ESLint + Prettier (`eslint.config.mjs`, `.prettierrc`)

## Deployment

GitHub Actions (`gh-pages.yml`): version tags (`v*.*.*`) or manual. Deploys to GitHub Pages. Uses `SRR_CDN_URL` repo variable.
