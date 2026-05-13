# Channel Management CLI — Design

**Date:** 2026-05-13
**Status:** Design approved, pending implementation plan
**Scope:** `backend/` — CLI for adding/removing/updating channels and their feeds; removes per-feed ingest from the data model.

## Goals

- Eliminate the create-vs-update overload in `srr chan add` (today: `--upd <id>` flips it to update mode).
- Eliminate the asymmetric pair `chan add -u` (replace feeds) vs `chan add-feed` (append feeds).
- Remove `Feed.Ingest` from the data model — ingest strategy is channel-level only.
- Add focused inspection (`chan show`) and scripted/bulk editing (`chan apply`, `chan edit`).
- Provide a state-preserving way to add or remove a single feed (via `chan upd --add-url` / `--rm-url`) without losing fetch state (`ETag`, `LastModified`, `Watermark`, `BoundaryGUIDs`) on surviving feeds.

## Non-Goals

- Force re-fetch flag that clears `Watermark` / `BoundaryGUIDs`. Separate feature.
- Renaming a feed URL while preserving fetch state. URL is the dedup key.
- Deprecation aliases for removed commands. This branch already churns related names (`subscription` → `channel`); one more rename is acceptable.
- A `feed` top-level Kong group. With `Feed.Ingest` gone, every feed-level operation collapses to a flag on `chan upd`.
- Frontend changes. All work is in `backend/`.

## Data-Model Change: drop `Feed.Ingest`

`Feed.Ingest` is removed from [backend/channel.go](backend/channel.go). Ingest precedence collapses from:

```
Feed.Ingest > Channel.Ingest > Globals.DefaultIngest > #rss
```

to:

```
Channel.Ingest > Globals.DefaultIngest > #rss
```

Cascading edits:

- [backend/ingest/main.go](backend/ingest/main.go) — `Select(feed, channel, global)` → `Select(channel, global)`.
- [backend/feed.go](backend/feed.go) — `pickIngest` (currently at line 147) becomes a two-level lookup; nil-globals guard preserved.
- [backend/cmd_preview.go](backend/cmd_preview.go) — call site at line 74 updates from `ingest.Select(o.Ingest, "", globals.DefaultIngest)` to `ingest.Select(o.Ingest, globals.DefaultIngest)`. (Preview has no real `Channel`; `-i/--ingest` plays the channel-level role.)
- [backend/channel.go](backend/channel.go) line 20 — comment referring to `Feed.Ingest` deleted alongside the field.
- [backend/CLAUDE.md](backend/CLAUDE.md) — `Ingest (ingest/)` paragraph rewritten; `Feed` struct field list updated.

DB compatibility: the existing `ingest` JSON tag on `Feed` was `omitempty`. Removing the field means the JSON decoder silently discards `"ingest"` on feed objects in pre-existing DBs. No migration step.

## CLI Surface

```
srr chan add   -t TITLE -u URL... [-g TAG] [-p PARSER...] [-i INGEST]
srr chan upd   ID [-t TITLE]
                  [-u URL... | --add-url URL... | --rm-url URL...]
                  [-g TAG] [-p PARSER...] [-i INGEST]
srr chan rm    ID...
srr chan ls    [-g TAG] [-f json|yaml]
srr chan show  ID [-f json|yaml]
srr chan edit  ID
srr chan apply [--file PATH | -]
srr chan import …
```

### Removed

- `srr chan add --upd ID` → `srr chan upd ID`.
- `srr chan add-feed ID URL...` → `srr chan upd ID --add-url URL...`.
- `srr chan rm-feed ID URL...` → `srr chan upd ID --rm-url URL...`.
- All `-i/--ingest` flags previously on feed-side commands (the field they targeted is gone).

No deprecation aliases.

## Per-Command Semantics

### `chan add` (strict create)

- Required: `-t/--title`, `-u/--url` (≥1).
- Optional: `-g/--tag`, `-p/--parsers` (repeatable; a single empty-string entry clears the pipeline — preserved convention), `-i/--ingest`.
- Validates URLs via `validFeedURL`; rejects duplicates within args.
- `db.AddChannel` allocates the first free id in `[0, 255]`; errors if full.

### `chan upd ID`

- Required: `ID`, plus at least one field flag (else `"nothing to update"`).
- Channel-level flags: `-t` (empty rejected), `-g` (empty clears), `-p` (empty entry clears), `-i` (empty clears).
- Feed-list flags (mutually-exclusive group; combining errors out):
  - `-u/--url URL...` — REPLACE the feed list. URLs already on the channel keep their internal state (`ETag`, `LastModified`, `Watermark`, `BoundaryGUIDs`, `FetchError`) via URL match; new URLs start fresh. Same logic as today's `parseFeeds`.
  - `--add-url URL...` — APPEND. Idempotent: URLs already on the channel or duplicated within args are silently skipped (`mkdir -p` semantics). Invalid URL formats fail.
  - `--rm-url URL...` — REMOVE. Strict: errors on URLs not currently on the channel, on duplicate args, or if all feeds would be removed (`use chan rm to delete the channel instead`).
- Errors if channel id is missing.

### `chan rm ID...`

Unchanged. Silent no-op on missing ids (matches `delete(map, id)` semantics; documented behavior).

### `chan ls [-g TAG] [-f json|yaml]`

Unchanged inputs. Output schema gains a `pipe` field for round-trip compatibility with `chan apply`. The per-feed `error` field is unchanged. Output is an array, sorted alphabetically by lower-cased title (current behavior).

### `chan show ID [-f json|yaml]`

- Errors if id missing.
- Emits a single channel object in the canonical shape (see Data Shape below).

### `chan edit ID`

1. Load channel; error if missing.
2. Marshal to indented JSON in a tempfile under `os.TempDir()`; filename includes the channel id (e.g. `srr-chan-3-XXXX.json`) so the editor tab is readable.
3. Resolve the editor: `$VISUAL` → `$EDITOR` → `vi`. Spawn with stdio inherited; wait for exit.
4. Editor exit with non-zero status: error; tempfile preserved and path printed.
5. If the file is byte-identical to the original, exit silently with status 0 (no DB write, no lock acquisition beyond the read).
6. Re-parse the JSON. Failures:
   - Invalid JSON → error with line number; tempfile preserved.
   - `id` field missing or differs from the CLI argument → error; tempfile preserved.
7. Apply through the same code path as `chan apply` (single-object update case). DB write lock is taken only here.
8. On success, delete the tempfile.

### `chan apply [--file PATH | -]`

- Reads from `--file PATH`; if `-` or no flag is given, reads stdin.
- Input is either a single channel object OR a JSON array of channel objects (auto-detected on the first non-whitespace byte).
- Per-object dispatch:
  - `id` absent → create. Same validation as `chan add` (title and ≥1 feed required). Allocates the next free id.
  - `id` present + channel exists → full-replace of channel fields and feed list. Feed state preserved by URL match.
  - `id` present + channel missing → error.
- Whole-input atomic: every object is validated up-front, then a single `db.Commit` is issued. Any error during validation produces zero writes.
- Read-only feed fields on input (`etag`, `last_modified`, `wm`, `bg`, `ferr`) are accepted but ignored — they cannot be poked from the CLI.
- Read-only channel fields on input (`total_art`, `add_idx`) are similarly ignored.

## Data Shape

### Channel JSON — canonical (emitted by `ls` and `show`, accepted by `apply` and `edit`)

```json
{
  "id": 0,
  "title": "News",
  "tag": "tech",
  "ingest": "#telegram",
  "pipe": ["#sanitize"],
  "feeds": [
    { "url": "https://example.com/feed", "error": "" }
  ]
}
```

Field rules:

- `id` — required on output; required on `apply` for the update branch; absent for create.
- `title` — required and non-empty.
- `tag`, `ingest`, `pipe` — `omitempty` on output. On `apply` input, absence clears (full-replace semantics); presence sets.
- `feeds` — required, ≥1 entry. Per-feed `url` required; `error` read-only.

`ls`/`show` do NOT emit internal per-feed state (`etag`, `last_modified`, `wm`, `bg`). They emit only `url` (required) and `error` (read-only, populated when the last fetch failed). State preservation across `show > file && apply file` is achieved through URL match inside `apply`, not by piping state through JSON — so the output stays terse and the `bg` arrays don't bloat it. `apply` accepts these internal fields if a hand-written input contains them, but silently ignores them.

## File Layout

| File | Change |
|---|---|
| [backend/channel.go](backend/channel.go) | Drop `Feed.Ingest` field; delete the line-20 comment that referenced it. |
| [backend/ingest/main.go](backend/ingest/main.go) | `Select(channel, global)` — drop feed param. |
| [backend/feed.go](backend/feed.go) | `pickIngest` becomes two-level (currently at line 147). |
| [backend/feed_test.go](backend/feed_test.go) | Delete the two tests that exercise `Feed.Ingest` (lines 41 and 56 reference it). |
| [backend/cmd_preview.go](backend/cmd_preview.go) | Update `ingest.Select` call site at line 74. |
| [backend/cmd_chans.go](backend/cmd_chans.go) | Rewrite: `AddCmd`, `UpdCmd` (replaces old `AddCmd --upd`, `AddFeedCmd`, `RmFeedCmd`), `RmCmd`, `LsCmd`, `ShowCmd`, `EditCmd`, `ApplyCmd`; keep `parseFeeds`, `printFormatted`. |
| [backend/cmd_chans_test.go](backend/cmd_chans_test.go) | Migrate existing tests; add new ones (see Tests). |
| [backend/main.go](backend/main.go) | `ChannelGroup` replaced: drop `AddFeed`/`RmFeed`; add `Upd`, `Show`, `Edit`, `Apply`. |
| [backend/CLAUDE.md](backend/CLAUDE.md) | Update `cmd_chans.go` blurb; update `Channel`/`Feed` field list; update ingest precedence paragraph. |
| Root [CLAUDE.md](CLAUDE.md) | No changes required. |

No new file. No `cmd_feeds.go`.

## Error Handling

All errors wrap with `fmt.Errorf("context: %w", err)` per repo convention. Existing message phrasings reused where applicable.

| Condition | Error message contains |
|---|---|
| Channel id not found | `"channel %d not found"` |
| Channel id out of range | `"id %d not in [0, 255]"` |
| URL fails `validFeedURL` | `"invalid url %q"` |
| Duplicate URL in args | `"duplicate url %q"` |
| `--rm-url` URL not on channel | `"url %q is not a feed of channel %d"` |
| `--rm-url` would empty feed list | `"channel %d would have no feeds after removal"` |
| `chan add` missing title or url | `"title is required"` / `"--url is required"` |
| `chan upd` no field flags | `"nothing to update"` |
| `chan upd` empty `--title` | `"title cannot be empty"` |
| `chan upd` `-u` combined with `--add-url`/`--rm-url` | `"--url cannot be combined with --add-url/--rm-url"` |
| `chan apply` create missing title or feeds | `"channel %q: title required"` / `"channel %q: feeds required"` |
| `chan apply` update id missing | `"channel %d not found"` |
| `chan apply` shape error | `"input must be a channel object or array of channel objects"` |
| `chan edit` editor non-zero exit | `"editor exited with status N (tempfile: %s)"` |
| `chan edit` id changed | `"edited document changed id from N to M; refusing to apply"` |
| `chan edit` invalid JSON | `"invalid JSON at line N: %s (tempfile: %s)"` |

Atomicity guarantee: every command runs inside a single `withDB(true, fn)` that issues exactly one `db.Commit` at the end. `chan apply` validates all entries up-front; failures during validation never reach `Commit`.

## Tests

### Mechanical migrations in `cmd_chans_test.go`

| Old test name | New name / fate |
|---|---|
| `TestAddCmdCreatesChannel` | `TestChanAddCreates` |
| `TestAddCmdCreateRequiresTitle` | `TestChanAddRequiresTitle` |
| `TestAddCmdCreateRequiresURL` | `TestChanAddRequiresURL` |
| `TestAddCmdCreateMultipleURLs` | `TestChanAddMultipleURLs` |
| `TestAddCmdUpdateChangesTitle` | `TestChanUpdChangesTitle` |
| `TestAddCmdUpdateEmptyTitleRejected` | `TestChanUpdEmptyTitleRejected` |
| `TestAddCmdUpdateClearsTag` | `TestChanUpdClearsTag` |
| `TestAddCmdUpdateSetsPipeline` | `TestChanUpdSetsPipeline` |
| `TestAddCmdUpdateClearsPipeline` | `TestChanUpdClearsPipeline` |
| `TestAddCmdUpdateReplacesFeedsPreservingState` | `TestChanUpdReplaceFeedsPreservingState` (now via `-u` on `UpdCmd`) |
| `TestAddCmdUpdateRejectsInvalidURL` | `TestChanUpdReplaceRejectsInvalidURL` |
| `TestAddCmdUpdateRejectsDuplicateURLs` | `TestChanUpdReplaceRejectsDuplicateURLs` |
| `TestAddCmdUpdateChannelNotFound` | `TestChanUpdChannelNotFound` |
| `TestRmCmdRemovesChannels` | unchanged |
| `TestRmCmdNoOpForMissingID` | unchanged |
| `TestAddFeedCmd*` (7 cases) | re-cast as `TestChanUpdAddURL*` against `UpdCmd` |
| `TestRmFeedCmd*` (6 cases) | re-cast as `TestChanUpdRmURL*` against `UpdCmd` |
| `TestLsCmdFiltersByTag` | unchanged + assert `pipe` field present in output |
| `TestParseFeeds*` (4 cases) | unchanged |
| `TestValidFeedURL` | unchanged |
| `TestChannelURLs*` | unchanged |

### Tests removed

- Any test that exercised `Feed.Ingest` (the field is gone). If `AddFeedCmd`'s `-i` had a dedicated test, drop it.

### New tests

In `cmd_chans_test.go`:

- `TestChanUpdRequiresFieldFlag` — bare `chan upd 0` errors with `"nothing to update"`.
- `TestChanUpdMutexUrlFlags` — `-u X --add-url Y` errors.
- `TestChanUpdNoFeedFlagsLeavesFeedsUntouched` — title-only update leaves `ch.Feeds` byte-identical (URL, ETag, Watermark, BG, FetchError preserved).
- `TestChanShowFound`
- `TestChanShowMissing`
- `TestChanShowEmitsPipe`
- `TestChanApplySingleCreate`
- `TestChanApplySingleUpdate`
- `TestChanApplyArray`
- `TestChanApplyAtomicRollback` — second item in array invalid; no writes occur.
- `TestChanApplyIdMissingErrors`
- `TestChanApplyInvalidJSON`
- `TestChanApplyPreservesFeedState`
- `TestChanApplyIgnoresReadOnlyFields` — input includes `etag`/`wm`; stored values unchanged after apply.
- `TestChanEditNoChangeNoOp`
- `TestChanEditIdChangedErrors`
- `TestChanEditInvalidJsonErrors`
- `TestChanEditApplies`
- `TestChanEditEditorNonZeroExit`

### `$EDITOR` test harness

`chan edit` resolves the editor via `$VISUAL` → `$EDITOR` → `vi` and `exec.Command`s it. Tests write a tiny shell script into `t.TempDir()`, `os.Chmod(0o755)` it, and `t.Setenv("EDITOR", scriptPath)`. The script reads `$1` (the path supplied by `chan edit`), writes the desired payload (or exits non-zero, or writes garbage), and returns. Variants per test cover the four edit branches (no-change, id-changed, invalid-JSON, valid-edit, non-zero-exit).

## Migration Notes

- `Feed.Ingest` references in `backend/`, confirmed via `grep -rn "Feed\.Ingest\|feed\.Ingest\|ingest\.Select" backend/`:
  - [backend/channel.go:20](backend/channel.go) — comment.
  - [backend/cmd_chans.go:155](backend/cmd_chans.go) — `feed.Ingest = *o.Ingest` in `AddFeedCmd`.
  - [backend/cmd_preview.go:74](backend/cmd_preview.go) — `ingest.Select` call site.
  - [backend/feed.go:147](backend/feed.go) — `ingest.Select` call site in `pickIngest`.
  - [backend/feed_test.go:41,56](backend/feed_test.go) — two tests exercising the field.
  - [backend/ingest/main.go](backend/ingest/main.go) — `Select` signature.
- `parseFeeds` is reused by `chan add`, the `chan upd -u` replace path, the `chan apply` update branch, and the `chan edit` apply path.
- `db.Channels()` API and `Channel` struct (other than the `Feed.Ingest` removal) unchanged.
- On-disk DB format: unchanged at the byte level. The `ingest` JSON tag on `Feed` objects in pre-existing DBs becomes an unknown field, silently discarded on unmarshal. New writes never emit it.
