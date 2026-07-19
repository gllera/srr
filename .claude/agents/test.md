---
name: test
description: Write or update unit tests for either half of the monorepo — frontend vitest suites (patterns in frontend/src/js/*.test.ts, e.g. nav.test.ts) or backend Go table-driven tests (backend/**/*_test.go). Use when asked to add tests, fix tests, or create test files.
---

Write or update unit tests following the established patterns of whichever half of the monorepo you're testing. Do NOT rely on a memorized inventory of test files — the suite is large and grows constantly. Discover it fresh:

- Frontend: `ls frontend/src/js/*.test.ts` (~20 suites)
- Backend: `ls backend/*_test.go backend/*/*_test.go` (~70 files across the root package, `store/`, `mod/`, `ingest/`)

## Before writing any tests

1. Find the test file closest to what you're testing (same module, or the nearest sibling) and read it in full — it is the authoritative pattern, not this document.
2. Read the source file being tested to understand every code path.
3. Frontend: also read `frontend/src/js/types.d.ts` for the ambient types.
4. Check the layer split before calling something a coverage gap: low UNIT coverage on `data.ts`/`app.ts`/`sw.ts` is by design — the e2e contract/browser layers (`frontend/e2e/`) carry the bulk, while the existing unit suites (`data.test.ts`, `data.edge.test.ts`, `app.test.ts`, `sw-grammar.test.ts`) pin only the pure-logic parts. Extend those files rather than creating parallel ones.

## Frontend conventions

- Framework: vitest with jsdom environment. Run with `cd frontend && npm test` (or `make test-fe`).
- 3-space indent, no semicolons (project Prettier config).
- `describe` blocks group related tests; `it` descriptions are lowercase, concise, behavioral.
- Modules that depend on `data.ts` need a hoisted mock (`vi.hoisted()` + `vi.mock("./data", …)`); pure modules import directly. Modules that capture DOM refs or hold lazy slots at load time need `vi.resetModules()` + dynamic import per test (see `dropdown.test.ts`, `search.test.ts`).
- **nav.test.ts mock invariants (do not break)**: in its `vi.hoisted()` block, `countLeft`/`findLeft`/`findRight` are REAL reimplementations that scan `data.getFeedId(i)` — never replace them with bare `mockReturnValue`/`mockResolvedValue` stubs; every traversal/count/filter assertion depends on those loop bodies. `setupIndex(entries)` is the single seeding entry point (builds the typed arrays, wires `getFeedId`/`loadArticle`, seeds `db.feeds`, clears the filter). Reuse the existing factories (`makeArticle`, `makeFeed`) — do not duplicate them. Read the current hoisted block and `beforeEach` for the exact shape before extending the suite.
- Counting behavior belongs in nav.test.ts's badge↔pill differential-oracle walks (scripted walks + brute-force reference counts) — extend the walks/seeds rather than adding hand-picked count scenarios.
- Hash verification: spy on `history.pushState`/`replaceState`.

## Backend conventions

- Run with `cd backend && go test ./...` (or `make test-be`); single test: `go test -run TestName .`.
- **Table-driven tests**: `tests := []struct{ … }{ … }` with `t.Run(tt.name, …)` sub-tests.
- Helpers marked `t.Helper()`; `t.TempDir()` for temp dirs, `t.Cleanup()` for teardown.
- `t.Errorf` for soft failures, `t.Fatalf` for hard stops; message format `"got X, want Y"`.
- No mocking frameworks — real dependencies (filesystem, XML parsing, subprocess). Integration-style.
- DB tests use `setupTestDB(t)` from `db_test.go` (temp dir + DB instance; it also stubs `finalGzip` to identity so 50k-boundary tests skip the zopfli CPU).
- Note the zero-value test globals run with `SRR_MAX_DELTAS=0` semantics (the delta kill switch); delta-chain behavior is pinned in `delta_test.go` — follow its setup when testing the tail write path.

## Adding tests

- **Existing file**: add new `describe`/`it` blocks or table entries within the existing structure. Reuse the file's factories and helpers.
- **New module**: frontend — new `<module>.test.ts` in `frontend/src/js/`; backend — new `<module>_test.go` in the same package, table-driven.
- Run the relevant test command after writing and confirm everything passes before reporting done.
