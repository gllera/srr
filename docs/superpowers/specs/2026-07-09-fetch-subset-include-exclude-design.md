# Fetch a subset of feeds/tags via include/exclude — design

**Date:** 2026-07-09
**Scope:** backend (`srr`)

## Goal

Let an operator restrict a fetch cycle to a subset of feeds, selected by tag
and/or feed id, with both **include** and **exclude** logic. Works for a one-off
`srr art fetch` invocation and for the persistent `srr serve --interval` /
`srr art fetch --interval` loop (env-driven, so a systemd unit can pin it).

Motivating case: on the `dmz` box the 16 X/Twitter-via-nitter feeds fail from a
datacenter IP. Tagging them (e.g. `social/x`) and running dmz's loop with
`SRR_FETCH_EXCLUDE_TAG=social/x` skips them cleanly, while a bastion cron could
run `SRR_FETCH_TAG=social/x` to fetch only those into the same store.

## Non-goals

- No per-feed persistent "fetch on this box" state in db.gz — this is
  invocation-scoped, not a data-contract change.
- No change to the frontend/reader, the pack format, or syndication.
- No change to the GUI single-feed fetch contract (`FetchCmd.only`).

## Surface

One shared, embedded selector struct (`feedFilter`) carrying four fields,
mirroring the existing `srr syndicate set` idiom (`Tags`/`FeedIDs`, `sep:","`):

| Flag | Short | Env | Meaning |
|---|---|---|---|
| `--tag` | `-g` | `SRR_FETCH_TAG` | include tags (hierarchical prefix) |
| `--feed` | `-i` | `SRR_FETCH_FEED` | include feed ids |
| `--exclude-tag` | — | `SRR_FETCH_EXCLUDE_TAG` | exclude tags (hierarchical prefix) |
| `--exclude-feed` | — | `SRR_FETCH_EXCLUDE_FEED` | exclude feed ids |

- All four are `sep:","` slices → **comma-separated and repeatable**
  (`--tag news,tech` ≡ `--tag news --tag tech`). Kong splits env-var values on
  the same separator, so `SRR_FETCH_EXCLUDE_TAG=twitter,news` works with no
  custom parsing.
- Short flags `-g` (tag) / `-i` (feed) match `srr art ls` and `srr syndicate set`.
- The struct is **embedded in both** `FetchCmd` (backs `srr art fetch`) and
  `ServeCmd` (backs `srr serve --interval`), so the same `SRR_FETCH_*` env
  reaches the persistent loop. Kong flattens embedded structs into each
  command's flag set. `ServeCmd` copies its `feedFilter` into the `FetchCmd`
  it constructs (`cmd_serve.go:61`).

## Selection semantics

A new resolver `FetchCmd.selectFeeds(db *DB) ([]*Feed, error)` replaces the
inline feed-set block in `runFetch` (`cmd_fetch.go:210–223`):

1. **GUI path unchanged.** If `len(o.only) > 0` (the GUI single-feed fetch),
   resolve exactly those ids via `db.FeedByID`, hard-erroring on an unknown id
   (existing contract). The filter fields are ignored on this path (the GUI
   never sets them).
2. **Include.** Otherwise, candidate set = union of feeds matching any `--tag`
   (prefix) OR any `--feed` id. If no include selectors are given, the candidate
   set is **all feeds** — a bare `srr art fetch` still fetches everything
   (backward compatible).
3. **Exclude.** Drop any candidate matching any `--exclude-tag` (prefix) OR any
   `--exclude-feed` id.
4. Result = feeds to fetch.

**Hierarchical prefix match** (`matchTag(feedTag, sel)`):
`feedTag == sel || strings.HasPrefix(feedTag, sel+"/")`. So `-g news` matches
`news`, `news/tech`, `news/world`; `news2` is **not** matched (the trailing `/`
guards against false prefixes).

**No-match handling = warn, never abort.** Each individual selector (include or
exclude, tag or feed id) that matched zero feeds logs one `slog.Warn`. If the
final set is empty, log one WARN and run the cycle with **zero feeds** — global
maintenance (expiration, `SyncIdxSummary`, `SyncMeta`, `SyncOutFeeds`, GC) still
runs, exactly as today's single-feed (`only`) path already runs global
maintenance. This is the forgiving contract wanted for a shared systemd config
where a box may legitimately have none of a referenced tag.

The resolver is a pure function over `db.Feeds()` for the filter path
(collecting warnings), which keeps it unit-testable without HTTP.

## Files touched

- **`cmd_fetch.go`** — add the embedded `feedFilter` struct (four `sep:","`
  fields with `env:` + help), the `matchTag` helper, and `selectFeeds`; replace
  the inline feed-set block (`210–223`) with a `selectFeeds` call. Emit the
  no-match / empty-set WARNs from the resolver.
- **`cmd_serve.go`** — embed `feedFilter` in `ServeCmd`; pass it into the
  constructed `FetchCmd` at line 61 (`&FetchCmd{Interval: o.Interval, feedFilter: o.feedFilter}`).
- **`cmd_fetch_test.go`** — unit tests for `selectFeeds` / the filter:
  - include by tag (hierarchical prefix hits `news` and `news/tech`, misses `news2`)
  - include by feed id
  - include union (tag ∪ feed id)
  - exclude by tag (prefix) removes from an otherwise-all set
  - exclude by feed id
  - include then exclude combined
  - no include selectors ⇒ all feeds
  - a no-match selector warns but does not error; result still correct
  - empty result set ⇒ warn, zero feeds, no error
  - the `only` GUI path still hard-errors on an unknown id

  Tests drive `selectFeeds` by setting the `feedFilter` fields directly (no CLI
  parsing) — comma-splitting is kong's job and is already proven by the
  identical `sep:","` fields on `srr syndicate set`, so it is not re-tested here.
- **`backend/CLAUDE.md`** — document the four flags + env vars and the
  include/exclude/prefix/warn semantics under the `cmd_fetch.go` bullet.

## Testing / verification

- `make verify-be` (vet + gofmt + build + test + generate-check) stays green.
- No `format.gen.ts` impact (no format-atom or struct-tag change), so the
  generate-check is unaffected.
- Manual smoke: `srr art fetch --exclude-tag <tag> -w1` against a test store
  logs the expected feed subset; `SRR_FETCH_TAG=... srr art fetch` honors env.

## Risks / edge cases

- **Kong short-flag collisions:** `-g`/`-i` are free on `art fetch`; `ServeCmd`
  uses `-a` only. Verify no collision when embedding into `ServeCmd`.
- **Env reaching the wrong command:** kong only env-populates the *selected*
  command's fields; embedding the struct in both commands (not relying on
  `FetchCmd`'s fields for the serve path) is exactly what makes `SRR_FETCH_*`
  work under `srr serve`.
- **Empty result surprise:** mitigated by the explicit WARN; documented that
  maintenance still runs.
