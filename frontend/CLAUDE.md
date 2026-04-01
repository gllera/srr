# CLAUDE.md

## Project

SRR Frontend — single-page RSS reader. Zero runtime deps. Parcel + TypeScript + plain CSS.

## Commands

`npm run dev|build|test|lint|format` — dev server, production build (`dist/`), vitest+jsdom, ESLint, Prettier.

## Architecture

Entry: `src/index.html` → `src/styles.css` + `src/js/app.ts`. Bundler: Parcel 2. `SRR_CDN_URL` replaced at build time.

Dependency chain: `app → nav → data`, `app → ts → data`, `nav → ts → data`, `app → fmt`. All in `src/js/`, strict mode.

| Module | Role |
|---|---|
| `data.ts` | CDN data layer: fetches `db.gz`, gzip TSV idx packs, gzip null-delimited data packs. Exports live-binding state (`db`, `articles`, `idxPack`) read by nav. Dual LRU caches (size 5). |
| `ts.ts` | Time-series optimization for filtered navigation. Fetches/caches ts/ weekly packs. Exports `findCandidateIdxPacks` (used by nav) and `findChronForTimestamp` (used by app for floor). |
| `nav.ts` | Navigation state machine: hash routing (`#chronIdx[~floor][!tokens]`), traversal, filtering, floor. Returns `IShowFeed`. Uses `pushState`/`replaceState`. Tokens are sub IDs or tag names. |
| `cache.ts` | Generic LRU cache factory (`makeLRU`). Used by data.ts and ts.ts. |
| `fmt.ts` | Pure utilities (no imports): `sanitizeHtml`, `timeAgo`, `formatDate`. |
| `app.ts` | UI: DOM rendering, events, dropdowns, error popup, loading, dark mode. All async handlers via `guard()` mutex. Position persisted to localStorage. |
| `types.d.ts` | Ambient types: `IDB`, `ISub`, `IIdxEntry`, `IShowFeed`. |

CSS: native nesting, `srr-` prefix on all classes, dark mode via `prefers-color-scheme`.

## Data Structures

See root `CLAUDE.md` Data Contract for db.gz, ISub, IIdxEntry, pack format, CDN layout, and chronIdx.

Frontend-specific additions:
- `subs_mapped` — computed at runtime: `Map<id, ISub>`
- **IShowFeed**: `{ article, has_left, has_right, filtered, floor, sub, countLeft }` — `countLeft`: `number | null` (`null` when earlier packs unscanned in filtered mode). Respects floor.
- Dev: `../packs/` sibling directory served on port 3000 with CORS.

## Key Behaviors

**guard() mutex** (app.ts): all async UI actions go through it. Drops concurrent calls. On error → popup with retry.

**Eager fetch**: `data.ts` starts `fetch("db.gz")` at module load (before `init()` call).

**Caching**: LRU(5) for idx + LRU(5) for data, keyed by pack number. HTTP `force-cache` for finalized. Latest packs use `data_tog` filename toggle.

**Streaming TSV**: `loadIdxPack` streams `DecompressionStream → TextDecoderStream`, handles partial lines via remainder buffer.

**Lazy content**: `render()` shows metadata immediately, loads content async via `getContent()`. Generation counter discards stale loads.

**Sanitization**: `<template>` element (no script exec). Removes: script/style/iframe/embed/object/form/link/meta/base. Strips: `on*` attrs, `javascript:` URLs. Adds: `rel="noopener noreferrer"`, `loading="lazy"`.

**Content fade-in**: double `requestAnimationFrame` for opacity transition. `window.stop()` cancels prior resource loads.

## State Machines (nav.ts)

**`filterSubs`** — `undefined` (all articles) or `Set<number>` (filtered subs):
- `toggleFilter()`: `undefined` ↔ `Set([current sub_id])`
- `last(subId)`: → `Set([id])`
- `last()` when filtered: preserves current set
- `setFilterSubs(set)`: direct setter (rebuilds `filterTokens` from numeric IDs)
- `setFilterTokens(tokens)`: resolves tokens (numeric sub IDs or tag names) into `filterSubs`
- Hash: `!` segment, `+`-separated tokens (sub IDs or tag names)

**`floorChron`** — `0` (no floor) or chronIdx lower bound:
- Constrains `left()` and `has_left`; does NOT prevent `load()` below floor
- Hash: `~floorChron` segment
- `setFloorHere()` / `clearFloor()` — synchronous, return `IShowFeed`

## Test Patterns

`src/js/nav.test.ts` — ~107 cases. Only nav.ts is tested.

- **Mock**: `vi.hoisted()` + `vi.mock("./data", ...)` with same shape as data.ts exports. `loadIdxPack` default just sets `data.idxPack`.
- **Reset**: `beforeEach` resets all data state + `nav.setFilterSubs(undefined)` + `nav.setFloorChron(0)`
- **Helpers**: `makeEntry(overrides)`, `makeSub(overrides)` — factory with defaults. `mockIdxLoad(entries)` / `mockIdxLoadOnce(entries)` — also reassign `data.articles`.
- **Hash checks**: spy on `history.pushState`/`replaceState`
- **Cross-pack**: chain `mockIdxLoadOnce` calls

## Conventions

- 3-space indent, no semicolons in TypeScript
- ESLint + Prettier (`eslint.config.mjs`, `.prettierrc`)

## Deployment

GitHub Actions (`gh-pages.yml`): version tags (`v*.*.*`) or manual. Deploys to GitHub Pages. Uses `SRR_CDN_URL` repo variable.
