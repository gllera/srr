# `[ALL]` list anchors at the oldest unread article

## Goal

When `[ALL]` is the active filter, the **list surface** selects/anchors the
**oldest unread article across all feeds** — the start of the global unread
backlog, to read forward (newer) from there — exactly like a tag does over its
member feeds. When everything is read (or the store is empty), it falls back to
the newest-first default, unchanged.

This is **list-surface only**. The reader still opens `[ALL]` at the newest
article (`switchFilter("")` → `last()`), the same list-vs-reader asymmetry that
tags already have today.

## Current behavior

`nav.ts` `listAnchor()` decides which chronIdx the list anchors on and selects
for a fresh filter:

- A **feed or tag**: oldest unread article (raise each member's bound past its
  seen high-water, take the oldest match), falling back to `-1` (newest) when
  fully caught up. `list.ts` turns a non-`-1` anchor into a top-aligned,
  `nav.select`-highlighted row.
- **`[ALL]`**, ★ Saved, search: always `-1` (newest-first), nothing selected.

`[ALL]` is excluded only because `filter.clear()` leaves `tokens` empty, so the
`!filter.active` guard short-circuits — even though `filter.feeds` is populated
with **every** feed that has articles.

## Change

One guard in `listAnchor()`:

```js
// before
if (!filter.active || filter.saved || filter.search) return -1
// after
if (filter.saved || filter.search || filter.feeds.size === 0) return -1
```

Rationale for the new predicate:

- `[ALL]`: `saved`/`search` false, `feeds.size > 0` → falls through to the
  existing oldest-unread scan, which already loops `filter.feeds` and so spans
  every feed for `[ALL]`.
- feed/tag: unchanged (still falls through).
- ★ Saved / search: `filter.feeds` is empty by design → still `-1`.
- empty store / no feeds with articles: `feeds.size === 0` → `-1` (also guards
  `Math.min(...unread.values())` against `Infinity`).

No other production code changes. `list.ts`'s `anchoredMid` path already
selects + top-aligns any non-`-1` anchor, so "shown selected" is free.

## Accepted side effects (tag parity)

- A fresh device (nothing read) lands `[ALL]` at the very oldest article in the
  archive — identical to how a never-opened tag behaves today.
- The reader's `[ALL]` open stays at newest.

## Tests (`nav.test.ts`, `listAnchor` describe)

- Rewrite "returns -1 (newest-first) for [ALL] with no live position" to the new
  contract: `[ALL]` with unread present → the oldest unread; `[ALL]` fully
  caught up → `-1`; empty/no-feeds store → `-1`.
- Add a multi-feed `[ALL]` case asserting it anchors at the oldest unread across
  feeds (older read articles and newer unread skipped correctly).
- ★ Saved / search cases stay `-1`.

## Docs

- Update the `listAnchor` doc comment in `nav.ts` (the "[ALL], ★ Saved and
  search keep the newest-first default" bullet).
- Update the two `frontend/CLAUDE.md` lines stating `[ALL]` is "always -1" /
  "a fresh [ALL] boot shows nothing selected".

## Follow-up: oldest-anchor scroll-into-view (found during live testing)

Surfacing the oldest-unread anchor on `[ALL]` (the home view) exposed a
**pre-existing** list bug (it affected tags too, just less visibly): when the
anchored/selected row is near the oldest end, the list scrolled to a position
computed on still-skeleton, pre-font rows, then the rows painted/reflowed taller
and grew the document — leaving the selected row **below the fold** (reported as
"selected but not visible"). Re-anchoring as it grew fixed visibility but
introduced a visible two-stage **scroll bump** (reported next).

Fix (`list.ts` `render`): split the anchor path by `landOnceMode = anchoredMid &&
!center`.

- **Reader-return (`center`)**: unchanged — anchor immediately, re-assert during
  fill (the article's pack is warm, lands instantly).
- **Fresh anchor (boot / filter change)**: stay at the top during load and
  **hold the `IntersectionObserver`** (so the top sentinel can't runaway-page a
  large filter), then **land once**: after `document.fonts.ready`, converge the
  measurement without moving — each frame re-pin every row's true height and
  recompute `chronScrollTarget(seed)` — and only when the target stabilizes
  (layout settled; bounded ~20 frames) scroll a single time and start the
  observer. Abandoned if the user scrolls first.

`scrollChronToView` was split into `chronScrollTarget` (pure target) +
`scrollChronToView` (target → `scrollTo`) so the convergence loop can detect a
settled target before committing one scroll.

Verified live (headless Chrome against the dev store): `#!science` and `[ALL]`
now go `scrollY 0 → final` in a single step with the selected oldest row visible
above the toolbar (previously `0 → 886 → 1571`, or under-scrolled below the fold).
Behavioral coverage: the `e2e/browser` "never-opened tag" test (rewritten to a
`#!world` deep-link) asserts the oldest row is selected and on-screen.

## Verification

`make verify-fe` (lint + format + unit tests + build). Opt-in `make test-browser`
covers the e2e behavior. Note: the browser suite has **2 pre-existing failures**
unrelated to this change (`search renders…`, `saves an article…`) — they drive
the retired `#srr-feed-menu` / `.srr-search .srr-search-icon` selectors from the
earlier config-surface refactor and fail at baseline.
