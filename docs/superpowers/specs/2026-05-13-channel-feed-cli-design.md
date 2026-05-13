# Channel & Feed Management CLI — Design

**Date:** 2026-05-13
**Status:** Design approved, pending implementation plan
**Scope:** `backend/` — CLI surface for adding/removing/updating channels and feeds

## Goals

- Eliminate the create-vs-update overload in `srr chan add` (today: `--upd <id>` flips it to update mode).
- Eliminate the asymmetric/confusing pair `chan add -u` (replace feeds) vs `chan add-feed` (append feeds).
- Provide a state-preserving way to edit per-feed config (`Feed.Ingest`) without losing fetch state (`ETag`, `LastModified`, `Watermark`, `BoundaryGUIDs`).
- Provide focused inspection: a single-channel `show` and a feeds-only `feed ls`.
- Provide bulk/scripted editing via JSON (`chan apply`) and an `$EDITOR` flow (`chan edit`).

## Non-Goals

- Renaming a feed URL while preserving fetch state. (Wash trade: easy in code, but allowing it conflicts with "URL is the dedup key" mental model. Out of scope.)
- A "force re-fetch" flag that clears `Watermark`/`BoundaryGUIDs`. Separate feature.
- Deprecation aliases for removed commands. This branch already churns related names (`subscription` → `channel`, `cmd_subs` → `cmd_chans`); one more rename is acceptable.
- Frontend changes. All work is in `backend/`.

## CLI Surface

### Channel group (`srr chan …`)

```
srr chan add   -t TITLE -u URL... [-g TAG] [-p PARSER...] [-i INGEST]
srr chan upd   ID [-t TITLE] [-g TAG] [-p PARSER...] [-i INGEST]
srr chan rm    ID...
srr chan ls    [-g TAG] [-f json|yaml]
srr chan show  ID [-f json|yaml]
srr chan edit  ID
srr chan apply [--file PATH | -]
srr chan import …
```

### Feed group (`srr feed …`, new top-level group)

```
srr feed add   ID URL... [-i INGEST]
srr feed rm    ID URL...
srr feed upd   ID URL [-i INGEST]
srr feed ls    ID [-f json|yaml]
```

### Removed

- `srr chan add --upd ID` — replaced by `srr chan upd ID`.
- `srr chan add-feed ID URL...` — replaced by `srr feed add`.
- `srr chan rm-feed ID URL...` — replaced by `srr feed rm`.

No aliases are kept. This branch is pre-release for the related rename churn; downstream call sites are migrated in the same change.

## Per-Command Semantics

### `chan add` (strict create)

- **Required**: `-t/--title`, `-u/--url` (≥1).
- **Optional**: `-g/--tag`, `-p/--parsers` (repeatable; an empty entry clears the pipeline — preserved CLI convention), `-i/--ingest`.
- Validates URLs (`validFeedURL`), rejects duplicates within args.
- Calls `db.AddChannel` to allocate the first free id in `[0, 255]`; errors if all slots are taken.
- Feeds are fresh (no pre-existing state to preserve on create).

### `chan upd ID` (strict update of channel-level fields only)

- **Required**: `ID`, plus at least one field flag (else error "nothing to update").
- **Optional**: `-t/--title` (empty rejected), `-g/--tag` (empty clears), `-p/--parsers` (empty entry clears), `-i/--ingest` (empty clears).
- **Does not touch feeds.** Use the `feed` subcommands or `chan edit`/`chan apply` for feed changes.
- Errors if channel id is missing.

### `chan rm ID...`

Unchanged from current implementation. Silent no-op on missing ids (matches the existing `delete(map, id)` semantics; documented behaviour).

### `chan ls`

Unchanged inputs (`-g/--tag`, `-f/--format`). Output schema gains a `pipe` field for round-trip compatibility with `chan apply`. The `error` field on each feed is unchanged.

### `chan show ID`

- Errors if id missing.
- Emits the same per-channel JSON/YAML shape as `chan ls` (single object, not array).

### `chan edit ID`

1. Load channel; error if missing.
2. Marshal to indented JSON in a temp file under `os.TempDir()` (path includes channel id for clarity in editor tab title).
3. Spawn `$EDITOR` (fallback `vi`); inherit stdio; wait for exit. Non-zero exit code from the editor is a fatal error.
4. If the user did not change the file (byte-for-byte equal), exit silently with status 0.
5. Re-parse JSON. Reject if:
   - JSON is invalid (report parse error).
   - `id` field is missing or differs from the argument.
6. Apply via the same code path as `chan apply` (single-object case).
7. Clean up the temp file on success or error.

### `chan apply [--file PATH | -]`

- Reads from `--file PATH`, or stdin if `-` or no flag is given.
- Input is a single channel object OR a JSON array of channel objects.
- Per-object dispatch:
  - **`id` absent** → create. Same validation as `chan add` (title + ≥1 feed required).
  - **`id` present + channel exists** → full-replace of channel fields and feed list. Feed state preserved via URL match (same logic as the current `parseFeeds`).
  - **`id` present + channel missing** → error. No specific-id creates (avoids slot races and surprise reuse of formerly-deleted ids).
- All-or-nothing transactional: every input is validated first; on any failure no writes occur. Single `db.Commit` at the end.
- Read-only `error` field on input feeds is ignored.
- **Round-trip safety:** because `chan show` emits every non-empty field and `apply` is full-replace, `chan show ID > file && $EDITOR file && chan apply --file file` is faithful. A user editing JSON by hand who wants to keep a field unchanged must include it in the payload; omitting a field clears it (same as HTTP `PUT`). Partial-update is intentionally not supported — use `chan upd` / `feed upd` for surgical field edits.

### `feed add ID URL... [-i INGEST]`

Behavior identical to the current `chan add-feed`:
- Idempotent on URLs already present on the channel (silent skip; `mkdir -p` semantics).
- Idempotent on duplicates within args.
- Invalid URL formats fail.
- `-i/--ingest`, if set, applies only to newly-added URLs; existing URLs retain their prior `Ingest` value.

### `feed rm ID URL...`

Behavior identical to the current `chan rm-feed`:
- Strict: errors if any URL is not currently on the channel.
- Errors if all the channel's feeds would be removed (use `chan rm` to delete the channel instead).
- Errors on duplicate URLs within args.

### `feed upd ID URL [-i INGEST]`

- Errors if channel missing or URL is not a feed on that channel.
- `-i ""` clears `Feed.Ingest`, falling through to the channel-level default.
- Internal state (`ETag`, `LastModified`, `Watermark`, `BoundaryGUIDs`, `FetchError`) is untouched.
- This is the state-preserving fix for the gap that today forces `rm-feed` + `add-feed`.

### `feed ls ID [-f json|yaml]`

- Errors if channel missing.
- Emits an array of per-feed objects in the channel's stored feed order: `[{url, ingest?, error?}, …]`.
- Same per-feed shape used inside `chan ls` / `chan show`.

## Data Shapes

### Channel JSON (canonical — emitted by `ls`/`show`, accepted by `apply`/`edit`)

```json
{
  "id": 0,
  "title": "News",
  "tag": "tech",
  "ingest": "#telegram",
  "pipe": ["#sanitize"],
  "feeds": [
    { "url": "https://…/feed", "ingest": "#rss", "error": "" }
  ]
}
```

Field rules:
- `id` — required on output; required on `apply` for update mode; absent for create.
- `title` — required and non-empty.
- `tag`, `ingest`, `pipe` — `omitempty` on output. On input, presence means "set"; explicit empty string/array means "clear".
- `feeds` — required, ≥1 entry. Per-feed: `url` required; `ingest` `omitempty`; `error` read-only.

Per-feed shape used by `feed ls`:

```json
[
  { "url": "https://…", "ingest": "#rss", "error": "" }
]
```

## File Layout

| File | Contents |
|---|---|
| `backend/cmd_chans.go` (modified) | `AddCmd`, `UpdCmd`, `RmCmd`, `LsCmd`, `ShowCmd`, `EditCmd`, `ApplyCmd`; `parseFeeds`, `printFormatted`, channel-view types. |
| `backend/cmd_feeds.go` (new) | `FeedAddCmd`, `FeedRmCmd`, `FeedUpdCmd`, `FeedLsCmd`. |
| `backend/cmd_chans_test.go` (modified) | Existing tests renamed mechanically; new tests for `upd` / `show` / `edit` / `apply`. |
| `backend/cmd_feeds_test.go` (new) | Tests for the `feed` group. |
| `backend/main.go` (modified) | Add `FeedGroup`; rename `ChannelGroup` members (drop `AddFeed`/`RmFeed`; add `Show`, `Edit`, `Apply`; rename `Add` → ensure no `--upd` flag; add `Upd`). |
| `backend/CLAUDE.md` (modified) | Update `cmd_chans.go` blurb; add `cmd_feeds.go` entry; update the `chan`/`art` command-list line. |
| Root `CLAUDE.md` | No changes required. |

## Error Handling

- All errors wrap with `fmt.Errorf("context: %w", err)` per repo convention.
- `chan upd` with no field flags: `"nothing to update"`.
- `chan show ID` missing: error from `db.ChannelByID` (`"channel %d not found"`, existing message).
- `chan edit` editor non-zero exit: `"editor exited with status N"`.
- `chan edit` id changed: `"edited document changed id from N to M; refusing to rewrite"`.
- `chan apply` id given but missing: `"channel %d not found (apply does not create with specific id)"`.
- `chan apply` shape errors: `"input must be a channel object or array of channel objects"`.
- `feed upd` URL not on channel: `"url %q is not a feed of channel %d"` (matches `feed rm` wording).
- Atomicity guarantee for `apply`: failures during validation never commit; one `db.Commit` at the end of the loop.

## Tests

### Migrated (mechanical renames in `cmd_chans_test.go`)

| Existing | Becomes |
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
| `TestAddCmdUpdateReplacesFeedsPreservingState` | _removed_ (`chan upd` no longer touches feeds; coverage moves to `TestChanApplyUpdatePreservesFeedState`) |
| `TestAddCmdUpdateRejectsInvalidURL` | _removed_ (same reason) |
| `TestAddCmdUpdateRejectsDuplicateURLs` | _removed_ (same reason) |
| `TestAddCmdUpdateChannelNotFound` | `TestChanUpdChannelNotFound` |
| `TestRmCmdRemovesChannels` | unchanged |
| `TestRmCmdNoOpForMissingID` | unchanged |
| `TestAddFeedCmd*` | move to `cmd_feeds_test.go` as `TestFeedAdd*` |
| `TestRmFeedCmd*` | move to `cmd_feeds_test.go` as `TestFeedRm*` |
| `TestLsCmdFiltersByTag` | unchanged + assert `pipe` field is present in output |
| `TestParseFeeds*` | unchanged |
| `TestValidFeedURL` | unchanged |
| `TestChannelURLs*` | unchanged |

### New tests

In `cmd_chans_test.go`:

- `TestChanUpdRequiresFieldFlag` — bare `chan upd 0` errors with "nothing to update".
- `TestChanUpdDoesNotTouchFeeds` — calling `upd` with no feed-related flags leaves `ch.Feeds` byte-identical (verified via deep-equal of `URL`/`ETag`/`Watermark`/`BG`).
- `TestChanShowFound` — emits expected JSON for existing channel.
- `TestChanShowMissing` — errors on bad id.
- `TestChanApplySingleCreate` — JSON object with no `id` → creates.
- `TestChanApplySingleUpdate` — JSON object with `id` matching existing → full-replace; per-feed state preserved by URL match.
- `TestChanApplyUpdatePreservesFeedState` — covers what `TestAddCmdUpdateReplacesFeedsPreservingState` did, but through the JSON path.
- `TestChanApplyArray` — array of mixed creates and updates committed atomically.
- `TestChanApplyAtomicRollback` — last item in array is invalid; no writes occur.
- `TestChanApplyIdMissingErrors` — JSON with `id` of a non-existent channel → error, no writes.
- `TestChanApplyInvalidJSON` — well-formed parse error reported.
- `TestChanEditNoChangeNoOp` — `$EDITOR` is a script that re-saves the same bytes; no write to the DB.
- `TestChanEditIdChangedErrors` — `$EDITOR` script mutates the id; error, no DB write.
- `TestChanEditInvalidJsonErrors` — `$EDITOR` script writes non-JSON; error, no DB write.
- `TestChanEditApplies` — `$EDITOR` script changes title; applied; feeds preserved by URL match.

In `cmd_feeds_test.go`:

- `TestFeedUpdChangesIngest`
- `TestFeedUpdEmptyIngestClears`
- `TestFeedUpdPreservesFetchState` — ingest changes but `ETag`/`Watermark`/`BG`/`LastModified` are byte-identical.
- `TestFeedUpdUrlNotOnChannel`
- `TestFeedUpdChannelNotFound`
- `TestFeedLsEmpty` — channel with one feed (can't be empty in practice; verifies output shape).
- `TestFeedLsOutputOrder` — order matches stored `ch.Feeds` order.
- `TestFeedLsChannelMissing`
- `TestFeedLsFormatYAML`

### `$EDITOR` test harness

`chan edit` spawns `$EDITOR` and waits. Tests set `EDITOR` to a tiny shell script — a per-test temp file with `#!/bin/sh` followed by a `cat > "$1" <<EOF` block writing the desired payload — and make it executable via `os.Chmod`. The current Go test infra in `cmd_chans_test.go` already uses `t.TempDir()`, so the same pattern is reused.

## Migration Notes

- All existing call sites in `backend/` for `AddCmd`'s `--upd` form, `AddFeedCmd`, `RmFeedCmd` are confined to `cmd_chans.go` and `main.go` plus tests. None of `cmd_fetch.go`, `cmd_art.go`, `cmd_import.go`, `cmd_preview.go`, `cmd_inspect*.go`, `cmd_config.go` reference these (verified during exploration).
- `parseFeeds` is reused by `chan add`, the `chan apply` update path, and the `chan edit` apply path.
- `db.Channels()` API and `Channel` struct are unchanged.
- No DB format changes.
