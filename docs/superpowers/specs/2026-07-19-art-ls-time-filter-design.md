# `srr art ls` time filtering — `--since` / `--until`

Date: 2026-07-19
Status: approved design, not yet implemented

## Goal

Let `srr art ls` restrict its output to a time window, so callers stop paging
the whole store with `--limit`/`--before` and filtering client-side.

## Clock: `fetched_at`

The window filters on `ArticleData.FetchedAt` (`a` in the data-pack JSONL) —
ingest time, not published time. Two reasons:

- **Semantics**: the question the flag answers is "what landed in my store in
  this window", which is also the clock `ExpireArticles` retires articles by.
- **Cost**: `cmd_fetch.go` stamps one `db.core.FetchedAt` per cycle and
  `db_pack.go` applies it to every article of that batch, so `fetched_at` is
  globally chron-monotone (non-decreasing). A window is therefore a contiguous
  chron range, findable by binary search. `published` is not monotone, so
  filtering on it would require reading every candidate's data pack — the whole
  data series on a large store, on every invocation.

Accepted consequence: a feed backfill ingests old articles under a recent
`fetched_at`, so they fall in a recent window. This matches expiration's view of
the store and is the documented meaning of the flags.

Accepted assumption: monotonicity depends on the wall clock not stepping
backwards between cycles. This is the same assumption `db_expire.go` already
makes ("expiration clock is fetched_at — globally chron-monotone"), so no new
risk is introduced.

## Flags

On `ArtCmd` in `backend/cmd_art.go`:

```
--since   Only articles fetched at or after this time.
--until   Only articles fetched at or before this time.
```

Both optional and independent: either may be given alone (open-ended window).

**No short flags.** The design originally assumed short flags were scoped per
command; they are not — kong flattens `Globals` into every command, where `-s`
is already `--pack-size`. A `-s` short fails at `kong.New` time (caught by
`TestCacheDirDefaultResolved`), so both flags are long-form only.

## Value syntax

One shared parser, formats tried in this order:

1. **Relative** — `24h`, `90m`, `7d`, `2w`: that long *before now*. Go's
   `time.ParseDuration` extended with `d` (24h) and `w` (168h) units, which it
   does not support, so `7d` need not be written `168h`. A relative value is
   resolved against the process start time once, so both bounds of one
   invocation share a single "now".
2. **Date** — `2026-07-15`: local midnight.
3. **RFC3339** — `2026-07-15T10:00:00Z`, or with an explicit offset: that exact
   instant.

Bare unix seconds are **not** accepted (deliberately dropped — it adds a
grammar ambiguity with no use case the three forms above miss).

Timezone: forms without an explicit zone (the date form) resolve in **local**
time, matching `git log --since`. An explicit `Z` or offset is honoured as
given.

An unparseable value is a hard error naming the accepted forms.

## Semantics

- Both bounds are **inclusive**: an article is in the window iff
  `since <= fetched_at <= until`, matching git.
- `since > until` is a **hard error**, not a silent empty result.
- An empty window (valid, but no articles fall in it) returns
  `{"articles": [], "total": 0}` — the same shape the command already returns
  for an empty store.

## Resolution

`ArtCmd.Run` already builds `entries` — the live idx entries in ascending chron
order — via `readAllIdx`. The window becomes two binary searches over that
slice rather than a scan:

- `windowLo` = lowest index whose `fetched_at >= since` (0 when `--since` absent)
- `windowHi` = highest index whose `fetched_at <= until` (`len(entries)-1` when
  `--until` absent)

Probing entry *i*'s `fetched_at` requires its data pack. Probes go through a
small cached resolver holding the same `map[int][]ArticleData` cache
`loadContent` uses; delta-region entries (`packID == deltaPackID`) resolve from
the already-parsed delta chain at no I/O cost. `log2(n)` probes over a 50k store
is ~16, most landing in a handful of distinct packs.

The cache is shared with the subsequent `loadContent` call so a pack read during
the search is not read again when filling in article content.

## Interaction with existing flags

- **`--before`**: still chooses the scan start; the window clamps it —
  `start = min(beforeIdx, windowHi)` — and the backward scan stops at
  `windowLo` instead of 0.
- **`total`**: counts entries matching the feed/tag filter **within the
  window**. `total` stays "how many articles this query matches"; a store-wide
  count that no longer relates to the returned rows would be misleading.
- **`next_cursor`**: unchanged — still the last returned chronIdx. Paging with
  it stays inside the window because the window is re-derived on each call from
  the same `--since`/`--until` values.
- **`-i`/`-g`** (feed/tag filter): orthogonal, applied to entries inside the
  window as today.

## Testing

In `backend/cmd_art_test.go`:

**Parser unit tests** — each accepted form (`24h`, `90m`, `7d`, `2w`,
`2026-07-15`, RFC3339 with `Z` and with an offset), local-midnight resolution of
the date form, and rejection of: bare unix seconds, empty string, unknown unit,
garbage.

**Command tests** over a fixture store built across several fetch cycles with
distinct `fetched_at` stamps:

- window fully inside the store's range
- `--since` only, `--until` only
- window matching nothing (empty result, `total: 0`)
- window combined with `-i` and with `-g`
- window combined with `--before` paging (cursor stays inside the window)
- `since > until` → error
- window spanning the pack↔delta seam (articles in both the consolidated packs
  and the live delta chain)

## Out of scope

- Filtering by `published`. Adding a `--by published|fetched` switch later is
  possible but would need the full-scan path; not built now.
- Any change to the `articles`/`total`/`next_cursor` output shape.
- The reader/frontend: `art ls` is a backend CLI command with no wire contract.
