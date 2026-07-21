# Sync: raise-only read progress + navigator re-anchor

**Date:** 2026-07-09
**Area:** frontend — `sync.ts`, `profile.ts`, `app.ts`, `config.ts`, `dropdown.ts`
**Status:** approved design, pending implementation plan

## Model — one person, many devices

The foundational assumption (stated by the requester): **all devices belong to
the same person reading the same feeds.** There is no multi-writer conflict to
arbitrate — different devices only ever hold the *same reader's* progress
captured at different times. Every rule below follows from it:

- The "true" read state is the **union of everything that one person has read on
  any device** ⇒ per-feed `max` (raise-only) is not a heuristic, it is the
  correct merge. A device that is "behind" is simply one that hasn't caught up
  yet, never a disagreement. And a person reads *forward*; they do not
  "un-read" — so `seen` only ever rises, and there is no legitimate automatic
  decrease to model.
- **The newest device state is the person's current intent** for everything that
  is a *choice* rather than accumulated progress: the saved set (un-saves must
  propagate) follows last-write-wins by `ts`.
- The old **parking** state (pause the cycle, wait for a human to resolve a
  would-be regression) modeled *two writers disagreeing*. With one reader that
  can never occur, so parking is removed as a wrong model, not merely as a
  simplification. The surviving `flush` guard is **not** conflict resolution —
  it exists only to keep a stale tab from erasing the one reader's
  furthest/latest state.
- **Switching devices should land you where you left off.** The manual sync IS
  the browser page refresh — there is deliberately no button: the boot pull
  re-anchors the list to the new range when it changed read progress (before
  the first interaction). Mid-session background pulls stay gentle — the
  navigable set stays stable while reading.

## Problem

Cross-device profile sync (`sync.ts`) today runs whole-blob **last-write-wins by
`ts`** with a progress-regression guard. A *background* cycle that pulls a newer
remote which would lower read progress on **any** feed **parks** the entire cycle
— which also blocks the *increases* carried in that same pull — and waits for a
manual "Sync now" (pure LWW, which can rewind). Two problems fall out of this:

1. Read progress does not flow as freely as it should. One regressive feed stalls
   a whole pull; and a manual sync can silently *lower* read progress.
2. After a manual sync changes read positions, the on-screen **navigator** (the
   unseen-only navigable range, the next-count pill, the list anchor) is not
   re-derived to match the new read state.

## Goals

- **Read progress (`seen`) is raise-only across sync.** Every cycle — background
  *and* the manual Refresh — may only ever *increase* a feed's read position,
  never decrease it. Increases flow at any time, in both directions
  (this device ↔ the endpoint), with no "parked" stall.
- **No automatic decrease, and no explicit-decrease UI in this change.** Lowering
  read progress via sync is simply not a path that exists after this change. (A
  future explicit "discard local progress" action is out of scope.)
- **Saved (★) stays last-write-wins.** Removing a save on one device still
  propagates (deletes travel), exactly as today.
- **Re-anchor the navigator at the device-switch moment** — the **boot pull**
  (a browser page refresh is the manual sync; there is deliberately no sync
  button): when it changed the profile and the user hasn't interacted yet,
  re-derive the unseen bounds/counts **and** rebuild the list at the new
  range's oldest-unread position. Reader boots and mid-session background
  cycles stay gentle (no jump), preserving the "nav set is stable while you
  read" invariant. The Refresh quick-action is content-only.

## Non-goals

- Any explicit UI to *lower* read progress (adopt-remote / discard-local /
  force-publish). Dropped by the requester.
- Changing the sync transport (still one user endpoint answering GET/PUT of the
  `v:2` profile blob) or the backup/restore file path (`importProfile` merge mode
  is unchanged for file restores).
- Changing background-cycle UX beyond removing the now-dead "parked" state.

## Design

### 1. Hybrid merge in `profile.ts`

Replace `importProfile`'s boolean `adopt?` with a mode, and give sync its own
mode so the whole policy lives in `profile.ts` (thin `sync.ts`, testable in
`profile.test.ts`):

```
importProfile(json, { prefs, mode })   // mode: "merge" (default) | "sync"
```

- **`merge`** (file restores, and the v1-remote legacy path) — unchanged:
  `seen` per-key `Math.max`, `saved` union, `ts` bumped only on a real raise.
- **`sync`** (the sync pull; replaces the old wholesale `adopt`) — a **hybrid**:
  - `seen` — per-key `Math.max(local, incoming)`. **Never lowers.** Applied
    unconditionally (independent of `ts`), so an increase flows in even from an
    older-`ts` remote. Unlike merge mode, a sync-mode seen raise does **NOT**
    stamp `ts` to now: the raise came from the remote, not from a local user
    action, and stamping would make this device "newest" and steal the saved-LWW
    ordering from the device where the person actually acted (same reasoning as
    the existing prefs-don't-stamp rule).
  - `saved` + `ts` — **last-write-wins by `ts`**: when `incoming.ts > localTs`,
    replace `saved` wholesale with the blob's and set `ts` from the blob;
    otherwise keep local `saved`/`ts` untouched. Net effect: after a sync-mode
    import, local `ts` = `max(localTs, incoming.ts)`.
  - `prefs` — gated by `opts.prefs` exactly as today (`sync.ts` always passes
    `prefs:false`).

The old wholesale `adopt` behavior (seen replaced, could lower) is **removed** —
nothing needs it after this change. `profile.test.ts` updates: the `adopt`
whole-replace cases become `sync`-mode cases asserting *seen never lowers* while
*saved/ts follow LWW*.

Result of one `sync`-mode import over a just-pulled remote: local `seen ≥ remote
seen` on every feed, and local `saved`/`ts` equal to the newer of {local, remote}.

### 2. Simplified cycle in `sync.ts`

`syncNow(opts)` returns a **`boolean` (changed)** so the caller can decide whether
to re-anchor.

```
pull remote
if remote is v1:   importProfile(raw, {prefs:false, mode:"merge"}); dirty = true   // force upgrade push
else (v2):         importProfile(raw, {prefs:false, mode:"sync"})                  // raise seen + LWW saved
changed = (seen or saved actually differ from before)   // ts-only adoption is NOT a change
if changed: onMerged?.()
// push: safe with no guard — after a sync-mode merge, local ⊒ the just-pulled remote
// on seen (max) and on saved/ts (LWW newest), so a PUT can never lower the endpoint.
wantPush = opts.manual || dirty
        || remote === null                                // 404 → seed the endpoint
        || regressiveSeen(localSeen(), remote.seen)       // endpoint's seen is behind local's
        || profileTs() > remote.ts                        // endpoint's saved/ts is behind local's
if (wantPush) { await put(url); dirty = false }
return changed
```

**Removed:** the pull-side park (`regressiveSeen(localSeen, remote.seen)` →
`parked`), the main-cycle push-side park, `parkedFlag`, and `SyncState.parked`.
The `remote.ts > profileTs()` adopt/park branch collapses — the `sync` mode owns
the ts logic now.

**Push trigger is derived from the actual delta, not just `dirty`.** `dirty`
alone is *not* a complete trigger: it is an in-memory flag, so a page reload
loses it while local state can still be ahead of the endpoint (reads made, tab
closed before the debounced push / a failed `flush`). And the endpoint itself
can transiently regress below a device's state — a stale tab's `flush` (its
remembered remote snapshot predates another device's push) or an old-build
device still doing pure-LWW pushes. Deriving `wantPush` from the pulled remote
(`regressiveSeen(localSeen(), remote.seen)` — some local feed is ahead — or a
newer local `ts`) makes every cycle **self-healing**: any device holding the
higher value re-raises the endpoint on its next cycle, no matter what happened
to flags or blobs in between. `dirty` is retained for the case with no
remote delta (it drives the debounced background push and the v1 force-upgrade
push) and is cleared **only** after a successful PUT (never on merge).

**Retained:** `ts`/`touchProfile`/`pushSoon` (needed for saved LWW),
`lastRemoteSeen` **and** `lastRemoteTs` (the `flush()` pagehide guard still needs
both). `flush()` pushes without pulling first, so a *stale tab* — one whose local
state lags the reader's furthest progress recorded elsewhere — could otherwise
erase it: the guard refuses to lower the endpoint's `seen`
(`regressiveSeen(lastRemoteSeen, localSeen())`) or to overwrite a newer `saved`
(`profileTs() < lastRemoteTs`). This is furthest/latest-state protection for the
one reader, **not** inter-device conflict resolution — so it stays, unchanged.

**Module docblock** rewritten to describe the raise-only-seen / LWW-saved model
and the removal of parking.

### 3. Navigator re-anchor in `app.ts` (part 2)

**The profile syncs on page load — there is deliberately no sync button.** The
Refresh quick-action is content-only (`refresh.refreshNow()` + error popup);
under the raise-only model no cycle needs human authorization, and the
background triggers (the `pushSoon` debounce, tab re-focus, `online`) plus the
boot pull cover every sync moment. A browser page refresh IS the manual sync.

When the **boot pull** (the first cycle after load, kicked by `sync.init`)
changes the profile, `refreshAfterMerge` re-anchors instead of running the
gentle rebuild — but only when ALL of these hold:

- **`view === "list"`** — a boot into the READER stays gentle: that position is
  a restored mid-article read or a shared `#pos` deep link, and silently
  swapping the on-screen article ~1s after paint is wrong in both cases.
- **No interaction yet** — an `app.ts` flag flipped by the first
  pointerdown/keydown/wheel/touchstart (capture-phase `once` listeners); the
  device-switch moment is over once you've touched something.
- **Not saved/search** — peek modes, their navigable sets are seen-independent;
  they keep the gentle rebuild.

The re-anchor itself: `nav.applyFilter([...nav.filter.tokens])` re-snapshots the
unseen-only bounds from the *new* seen map (the same call `setUnreadOnly` uses)
and resets `filter.anchor`, then `list.render()` rebuilds anchored at
`nav.listAnchor()` — the new range's oldest unread, top-aligned. (Note
`list.rerender()` already re-anchors via the live seen map — `listAnchor` →
`oldestUnread` reads `readSeen()` at render time, pre-existing behavior; the
bounds re-snapshot is the genuinely new piece, dropping articles read elsewhere
from the unseen-only walk.)

Mid-session background cycles are unchanged: `onMerged` runs the gentle
`refreshAfterMerge` (prune seen, refresh save button, `list.rerender()` when not
in the reader, `config.render()` when open) — no bounds re-snapshot, no reader
move; what "gentle" specifically preserves is the unseen-only walk snapshot and
the reader position.

`syncNow` still returns whether the pull changed seen/saved; app.ts's boot path
keys off the `onMerged` callback instead (it only fires on a change), so the
return value is API surface for tests and future callers.

### 4. `config.ts` + `dropdown.ts` cleanup

- `config.ts`: drop `syncState.parked` from the status `sig` and remove the
  *"Sync paused — read progress would rewind. Sync now to resolve."* status flag.
- `dropdown.ts`: the `showSyncDialog` comment ("pure LWW: adopt the endpoint's
  blob …") is reworded — saving a new URL still kicks `syncNow({manual:true})`,
  which now *merges* (raise seen + LWW saved) rather than wholesale-adopts. A fresh
  device with empty local `seen` still fully takes the endpoint's progress (every
  value is a raise from absent), so "enabling sync pulls my progress" still holds.

## Data / contract impact

None on the writer↔reader pack contract. The profile blob stays `v:2`
(`{v, ts, seen, saved, unreadOnly, imgProxy}`); the wire shape is unchanged. A v1
endpoint still upgrades to v2 via the merge+force-push legacy path. Endpoints and
other devices on the old build interoperate: they read/write the same blob; the
only behavioral difference is this device no longer lowers its own `seen`.

## Testing

- `profile.test.ts` — new `sync`-mode cases: seen rises and **never lowers**
  regardless of `ts`; a sync-mode seen raise does **not** stamp `ts` (merge mode
  still does); saved/ts follow LWW (adopt when blob newer, keep when not; `ts`
  ends as `max`); prefs stay gated. Convert the old wholesale-`adopt` assertions.
- `sync.test.ts` — rewrite the park/LWW suite: a newer-but-regressive remote now
  *raises* seen (no park, no lower) and adopts saved by LWW; `syncNow` returns
  `changed` (false on a ts-only adoption); the derived push trigger — pushes with
  `dirty` false when local seen is ahead of the pulled remote (the reload-lost-
  dirty heal) or local `ts` is newer, seeds a 404 endpoint, and does NOT push
  when local ⊑ remote; `dirty` clears only on push; the main cycle never parks;
  `flush` guard behavior retained; `state()` no longer exposes `parked`.
- `app.test.ts` — the boot pull re-anchors the list (`applyFilter` +
  `list.render`) before any interaction; after the first interaction / in the
  reader / under saved/search it stays gentle (`list.rerender`); the Refresh
  quick-action runs a content refresh only (no profile cycle).
- `config.test.ts` — the "Sync paused" flag is gone; healthy/error/pending sync
  readouts unchanged.
- Full `make verify-fe`; check `sync.test.ts`, `profile.test.ts`, `config.test.ts`
  specifically.

## Consequences / trade-offs

- **Convergence:** the fleet converges to (per-feed **max** seen, **newest-`ts`**
  saved) regardless of cycle order, and cycles are idempotent. Transient endpoint
  regressions — a stale tab's `flush` whose remembered remote snapshot predates
  another device's push, or an old-build device still pushing pure LWW — are
  **self-healing**: any device holding the higher value re-raises the endpoint on
  its next cycle via the delta-derived push trigger.
- **Sync can no longer lower read progress at all** (no explicit path built).
  Accepted by the requester; a future explicit action can re-introduce a
  deliberate decrease using the removed wholesale-replace as a starting point.
- **Concurrent saved edits still lose under LWW** (unchanged from today) — the
  newest blob's saved set wins wholesale. Benign under the one-reader premise: a
  single person rarely edits saves on two devices in the same sync window, and
  their most recent action is the one they want kept.
- Removing parking simplifies the mental model and deletes a status-line state;
  the "increases blocked by one regressive feed" annoyance is gone.
