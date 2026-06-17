---
name: test
description: Write or update unit tests following the established patterns in frontend/src/js/nav.test.ts. Use when asked to add tests, fix tests, or create test files.
---

Write or update unit tests for the frontend project following the established patterns in `frontend/src/js/nav.test.ts`.

## Before writing any tests

1. Read `frontend/src/js/nav.test.ts` to see the full current test structure, helpers, and mock setup
2. Read the source file being tested to understand every code path
3. Read `frontend/src/js/types.d.ts` for type definitions

## Test conventions

- Framework: vitest with jsdom environment
- 3-space indent, no semicolons (matches project Prettier config)
- Use `describe` blocks to group related tests; `it` for individual cases
- Test descriptions should be lowercase, concise, and describe the behavior

## Mocking pattern

- **data.ts**: `vi.hoisted()` + `vi.mock("./data", () => data)` with a mock object mirroring data.ts's exports: `IDX_PACK_SIZE`, `db`, `loadArticle`, `getFeedId`, `groupFeedsByTag`, `countLeft`, `countAll`, `findLeft`, `findRight`. Note `init` is a data.ts export that the mock omits (nav never calls it). `findLeft`/`findRight`/`countLeft` are NOT bare `vi.fn()` — they wrap working inline reimplementations that scan via `data.getFeedId()`/`data.db.total_art`. See nav.test.ts (lines 3-39) for the exact shape.
- **Mock invariants (do not break these)**: in the `vi.hoisted()` block, `countLeft`/`findLeft`/`findRight` are REAL reimplementations scanning `data.getFeedId(i)` and matching `addIdx !== undefined && i >= addIdx`. Do NOT replace them with bare `mockReturnValue`/`mockResolvedValue` stubs — every traversal/count/filter assertion depends on these loop bodies, and `beforeEach` only `mockClear()`s `findLeft`/`findRight` (leaving `countLeft` untouched), so they persist across the suite. `setupIndex(entries)` is the single seeding entry point that drives navigation off typed arrays read by `getFeedId`: pass `[{ feedId, fetchedAt? }]` and it sets `db.total_art`, builds `Uint32Array` arrays, wires the typed-array-backed `getFeedId`/`loadArticle` via `mockImplementation`, populates `db.feeds`, and clears `nav.filter`.

## Factory functions (defined in nav.test.ts)

- `makeArticle(overrides?)` — returns `IArticle` with defaults `{ f: 1, a: 0, p: 0, t: "", l: "", c: "" }`
- `makeFeed(overrides?)` — returns `IFeed` with defaults `{ id: 1, title: "Test", url: "http://test.com", total_art: 1 }`
- `setupIndex(entries: Array<{ feedId: number; fetchedAt?: number }>)` — the single seeding entry point: sets `data.db.total_art`, builds `Uint32Array` feedId/fetchedAt arrays, wires the `data.loadArticle`/`data.getFeedId` mock implementations off those arrays, seeds `data.db.feeds` (one `makeFeed` per distinct feedId), and calls `nav.filter.clear()`

## State reset

Every `beforeEach` resets `data.db.total_art` (to 0) and `data.db.feeds` (to `{}`), calls `mockReset()` on `data.loadArticle`/`data.getFeedId` and `mockClear()` on `data.findLeft`/`data.findRight`, then `nav.filter.clear()`, `localStorage.clear()`, and spies `history.pushState`/`replaceState` via `vi.spyOn`. Filter state is reset through the exported `filter` object (`nav.filter.clear()`), not setter functions — nav.ts exports no `setFilterSubs`/`setFloorChron`. There is no idxPack, db.seq, subscriptions, subs_mapped, articles, or loadIdxPack to reset, and no ts.ts module/mock exists. See nav.test.ts `beforeEach` for the exact sequence.

## Hash verification

Spy on `history.pushState`/`history.replaceState` to verify hash updates without triggering navigation.

## Existing test files

| File | Module | Approach |
|---|---|---|
| `nav.test.ts` | nav.ts | Hoisted mock for data.ts, factory functions, beforeEach reset |
| `data.test.ts` | data.ts | `vi.mock('./data')` with an inline pure-fn reimplementation of `groupFeedsByTag` + `await import('./data')` to dodge data.ts's module-load fetch |
| `idx.test.ts` | idx.ts | Binary idx-pack parsing, direct imports |
| `fmt.test.ts` | fmt.ts | Direct imports, no mocks (pure functions) |
| `cache.test.ts` | cache.ts | Direct imports, no mocks (pure factory) |

## Adding tests

- **Existing file**: Add new `describe`/`it` blocks within existing structure. Reuse factory functions — do not duplicate.
- **New module**: Create new test file in `frontend/src/js/`. Modules depending on `data.ts` need hoisted mock; pure modules import directly.
- Run `cd frontend && npm test` after writing to verify all tests pass.

## Backend test conventions

Write or update unit tests for the backend Go project following patterns in existing `backend/*_test.go` files.

### Before writing any tests

1. Read the existing test file closest to what you're testing (e.g., `backend/db_test.go`, `backend/feed_test.go`)
2. Read the source file being tested to understand every code path

### Test patterns

- **Table-driven tests**: `tests := []struct{ ... }{ ... }` with `t.Run(tt.name, ...)` sub-tests
- **Helpers**: Mark with `t.Helper()`. Use `t.TempDir()` for temp dirs, `t.Cleanup()` for resource teardown
- **Assertions**: `t.Errorf` for soft failures (continue), `t.Fatalf` for hard stops. Format: `"got X, want Y"`
- **No mocking frameworks**: Use real dependencies (filesystem, XML parsing, subprocess). Integration-style.
- **Package-level context**: `var ctx = context.Background()` at top of test file
- **DB tests**: Use `setupTestDB(t)` helper from `db_test.go` which creates temp dir + DB instance

### Existing test files

| File | Module | Focus |
|---|---|---|
| `db_test.go` | db.go | Pack storage, idx/data series, commit cycle |
| `feed_test.go` | feed.go | Feed-level ingest-strategy inheritance (feed override + db.gz root fallthrough) |
| `feed_test.go` | feed.go | Feed fetch/dedup, watermark/boundary GUIDs, future-date clamping, strip-control sanitization helpers |
| `processing_test.go` | processing.go | Content-pipeline processing: immutable-field guard, explicit `#sanitize`, ordering hazards |
| `ingest/rss_test.go` | ingest/rss.go | RSS/Atom/RDF parsing, date formats, `ErrStopFeed` |
| `cmd_import_test.go` | cmd_import.go | OPML import selection logic |
| `opml_test.go` | opml.go | OPML parsing, group normalization |
| `mod/main_test.go` | mod/main.go | Module pipeline, external processor |

### Adding tests

- **Existing file**: Add new table entries or `t.Run` sub-tests within existing structure
- **New module**: Create `<module>_test.go` in same package. Follow table-driven pattern.
- Run `cd backend && go test ./...` after writing to verify all tests pass.
