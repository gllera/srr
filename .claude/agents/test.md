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

- **data.ts**: `vi.hoisted()` + `vi.mock("./data", ...)` with a mock object mirroring all data.ts exports (db, articles, idxPack, init, loadIdxPack, getContent, makeLRU, streamSplit, numFinalizedIdx, latestIdxCount, activeSubs). See nav.test.ts for the exact shape.
- **ts.ts**: Same hoisted pattern with `findCandidateIdxPacks` and `findChronForTimestamp` mocks (default: `mockResolvedValue(null)`).

## Factory functions (defined in nav.test.ts)

- `makeEntry(overrides?)` — returns `IIdxEntry` with defaults `{ fetched_at: 0, pack_id: 1, pack_offset: 0, sub_id: 1, published: 0, title: "Test", link: "" }`
- `makeSub(overrides?)` — returns `ISub` with defaults `{ id: 1, title: "Sub1", url: "" }`
- `setArticles(entries)` — replaces `data.articles` contents from an array
- `mockIdxLoad(entries)` — sets `data.loadIdxPack` mock to always load given entries (also calls `setArticles`)
- `mockIdxLoadOnce(entries)` — same but only for the next call (chain for cross-pack sequences)

## State reset

Every `beforeEach` must reset all data state (idxPack, db.total_art, db.data_tog, subscriptions, subs_mapped, articles), restore default loadIdxPack implementation, reset ts mocks, and call `nav.setFilterSubs(undefined)` + `nav.setFloorChron(0)`. See nav.test.ts `beforeEach` for the exact reset sequence.

## Hash verification

Spy on `history.pushState`/`history.replaceState` to verify hash updates without triggering navigation.

## Existing test files

| File | Module | Approach |
|---|---|---|
| `nav.test.ts` | nav.ts | Hoisted mocks for data.ts + ts.ts, factory functions, beforeEach reset |
| `data.test.ts` | data.ts | Direct imports, mock fetch |
| `ts.test.ts` | ts.ts | Hoisted mock for data.ts |
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
| `db_test.go` | db.go | Pack storage, idx/data/ts series, commit cycle |
| `feed_test.go` | feed.go | RSS/Atom/RDF parsing, date formats, stop feed |
| `subscription_test.go` | subscription.go | Text sanitization helpers |
| `cmd_import_test.go` | cmd_import.go | OPML import selection logic |
| `opml_test.go` | opml.go | OPML parsing, group normalization |
| `mod/main_test.go` | mod/main.go | Module pipeline, external processor |

### Adding tests

- **Existing file**: Add new table entries or `t.Run` sub-tests within existing structure
- **New module**: Create `<module>_test.go` in same package. Follow table-driven pattern.
- Run `cd backend && go test ./...` after writing to verify all tests pass.
