# OPML Import — Merge & Channel-Level Config — Design

**Date:** 2026-05-14
**Status:** Design approved, pending implementation plan
**Scope:** `backend/cmd_import.go` — extend `srr chan import` to (1) merge selected OPML outlines into a single channel with multiple feeds, and (2) apply channel-level `pipe` / `ingest` to every imported channel.

## Motivation

Today `srr chan import` emits one `Channel` per OPML outline with `xmlUrl`. A channel can hold multiple feeds (`Channel.Feeds []*Feed`), but the importer cannot exercise that — operators must import outlines individually and then run `srr chan upd --add-url` repeatedly to reassemble a multi-feed channel. Likewise, channel-level `Pipe` and `Ingest` must be set with a follow-up `chan upd` per channel.

This change lets the importer:

1. Collapse any selection (one group, multiple leaves, a mix, or the whole OPML) into one channel with N feeds.
2. Stamp every emitted channel with a shared `Pipe` and/or `Ingest`.

## Goals

- Universal **`-t/--title`** flag triggers "merge selected outlines into one channel with this title".
- **`-p/--parsers`** flag stamps every emitted channel's `Pipe` — merged or per-leaf.
- **`--ingest`** flag stamps every emitted channel's `Ingest` — merged or per-leaf.
- Preserve current behavior when none of the new flags is set.

## Non-Goals

- Renaming or removing existing flags (`-i/--id`, `-a/--all`, `-g/--tag`, `-n/--dry-run`).
- Reusing `-i` for ingest. It is already taken by `ID`; `--ingest` is long-only here.
- Auto-detecting "similar" channels by URL or title and merging them. The merge is explicit (`-t`).
- Updating existing channels in db.gz. `chan import` only creates; existing-channel reconciliation is `chan apply`'s domain.
- OPML export. Out of scope.

## CLI Shape

`ImportCmd` in [backend/cmd_import.go](backend/cmd_import.go) gains three fields:

```go
type ImportCmd struct {
    Path   string   `arg:""    help:"Channels opml file."`
    ID     []string `short:"i" help:"Ids to import."`
    All    bool     `short:"a" help:"Import all."`
    Tag    *string  `short:"g" help:"Tag to assign to imported channels. Overrides OPML group tags."`
    DryRun bool     `short:"n" help:"Dry run. List resulting channels without importing."`

    // NEW
    Title   *string  `short:"t" help:"Title for the merged channel. Triggers merge mode (all selections become one channel)."`
    Parsers []string `short:"p" help:"Channel pipe applied to every imported channel. Repeatable. Empty string clears (inherit root)."`
    Ingest  *string  `         help:"Channel ingest strategy applied to every imported channel. Empty string clears (inherit root)."`
}
```

`-t` is the merge trigger (presence, not value: `Title != nil`). `-p` and `--ingest` are independent of `-t` — they stamp every channel emitted by the import, merged or not.

`Title` and `Ingest` are `*string` (not `string`) so we can distinguish "absent" (`nil`) from "passed empty" (non-nil pointing to `""`). This mirrors the existing `Tag *string` convention.

### Behavior Matrix

| Invocation | Result |
|---|---|
| `-a` | unchanged: every leaf → its own channel, auto-tag from group path |
| `-i 1` (group) | unchanged: each descendant leaf → its own channel, auto-tag |
| `-i 1.1` (leaf) | unchanged: one channel, one feed |
| `-a -t T` | one merged channel "T" containing every leaf's feed |
| `-i 1 -t T` (group) | one merged channel "T" containing every leaf in the subtree |
| `-i 1.1 -i 1.2 -t T` (leaves) | one merged channel "T" with the two feeds |
| `-i 1 -i 2.3 -t T` (mixed) | one merged channel "T" collecting subtree of 1 plus leaf 2.3 |
| `-i 1.1 -t T` (single leaf) | one channel "T" with one feed — legal, degenerate |
| `-a -p X --ingest Y` | every leaf-channel gets `Pipe=[X]`, `Ingest=Y` |
| `-a -t T -p X --ingest Y` | one merged channel "T" with `Pipe=[X]`, `Ingest=Y` |
| `-i 1.1 -p X` | one channel, one feed, `Pipe=[X]` |
| `-t T` only (no `-a`, no `-i`) | error: nothing selected |
| `-t ""` | error: empty title |

### Tag Handling

- **With `-t`** (merged): tag is empty unless `-g` is given.
  Rationale: when collapsing a heterogeneous selection, no single group-path is "the" tag. Forcing empty by default keeps the merge predictable. `-g` overrides explicitly.
- **Without `-t`** (current per-leaf path): unchanged — each emitted channel auto-derives tag from its OPML group path via `resolveTag`; `-g` overrides.

### Validation Rules

Run before the walker, before the DB lock:

1. `-t ""` (i.e. `Title != nil && *Title == ""`) → error `"title must be non-empty"`.
2. `-t` set and no `-a` and no `-i` → error `"merge requires -a or -i"`.

No `-a` / `-i` *without* `-t` remains today's silent no-op (prints the tree, imports nothing) — preserves the "tree preview" UX.

Pipe / ingest do not need their own validation: `filterPipe(Parsers)` already drops empty strings and returns `nil` for an all-empty input; `Ingest == ""` falls through to root via `ingest.Select`.

## Implementation Sketch

### `importWalker`

Add two fields:

```go
type importWalker struct {
    w           io.Writer
    selectedIDs []string
    merge       bool      // true when Title != nil
    mergedFeeds []*Feed   // accumulator used only in merge mode
}
```

The walker continues to print the tabular tree to `w` and to flag which IDs are "selected" (existing `isSelected` is unchanged). The mode change is in what selected nodes do:

- **`merge == false`** (today's path): selected leaves become their own `*Channel` in the returned slice. Group selection expands prefix-style. Auto-tag via `resolveTag(groupPath)`.
- **`merge == true`**: selected nodes append their `*Feed`(s) to `iw.mergedFeeds` instead of returning a `*Channel`. Group nodes with a self-feed (`n.Channel != nil && len(n.Children) > 0`) contribute their own feed too. `walk` returns `nil` channels in merge mode.

After `walk` finishes, `Run` builds the merged `*Channel` from `iw.mergedFeeds` (only when `iw.merge`):

```go
if iw.merge {
    newChannels = []*Channel{{
        Title: *o.Title,
        Feeds: iw.mergedFeeds,
    }}
}
```

Tag is assigned by the post-walk helper (see next section); leaving `Tag` unset here means "empty by default, overridable via `-g`".

### `ImportCmd.Run`

After `walk` returns and merge-mode (if any) assembles its single channel, apply Tag / Pipe / Ingest defaults to every emitted channel via a small helper:

```go
func applyImportDefaults(channels []*Channel, parsers []string, ingest, tag *string) {
    if parsers != nil {
        pipe := filterPipe(parsers) // nil if all-empty
        for _, c := range channels {
            c.Pipe = pipe
        }
    }
    if ingest != nil {
        for _, c := range channels {
            c.Ingest = *ingest
        }
    }
    if tag != nil {
        for _, c := range channels {
            c.Tag = *tag
        }
    }
}
```

`Run` becomes one call:

```go
applyImportDefaults(newChannels, o.Parsers, o.Ingest, o.Tag)
```

This replaces today's `if o.Tag != nil { for ... }` loop.

**Flag-presence detection**:
- `Parsers []string` — Kong leaves a nil slice when `-p` is absent; allocates a non-nil slice when `-p` is given at least once. `parsers != nil` distinguishes the two.
- `Ingest *string`, `Tag *string`, `Title *string` — `nil` when absent; non-nil pointing to a (possibly empty) string when the flag is given.

### Files Touched

- [backend/cmd_import.go](backend/cmd_import.go) — new fields, validation in `Run`, walker merge-mode, post-walk Pipe/Ingest application.
- [backend/cmd_import_test.go](backend/cmd_import_test.go) — update one test (`TestImportWalkerGroupSelectsChildren`), add merge + pipe/ingest tests.
- [backend/CLAUDE.md](backend/CLAUDE.md) — update the `cmd_import.go` bullet (one line addition for merge + pipe/ingest flags).

No other files change. The walker still uses `*Channel` / `*Feed` from `channel.go` exactly as today; the merge logic is local to `cmd_import.go`.

## Tests

Additions in [backend/cmd_import_test.go](backend/cmd_import_test.go) (new test functions; update one existing):

1. **`TestImportWalkerGroupSelectsChildren`** (UPDATE) — currently asserts 2 channels for `-i 1` (group). Split into two cases:
   - Without merge (current behavior): still 2 channels.
   - With merge: 1 channel, 2 feeds, title = test title.
2. **`TestImportMergeAllWithTitle`** — `-a -t "X"` over a tree with 3 leaves → 1 channel "X", 3 feeds, empty tag.
3. **`TestImportMergeGroupWithSelfFeed`** — group node has both an `xmlUrl` and children → merged channel has the group's feed plus each child's feed.
4. **`TestImportMergeDeepNested`** — group containing subgroups containing leaves → merged channel collects every leaf depth-first.
5. **`TestImportMergeMixedSelections`** — `-i 1 -i 2.3 -t "X"` (group + leaf) → 1 channel "X" with combined feeds.
6. **`TestImportMergeSingleLeaf`** — `-i 1.1 -t "X"` → 1 channel "X" with 1 feed (degenerate but legal).
7. **`TestImportPipeAppliedToMerged`** — `-a -t "X" -p "#sanitize"` → merged channel has `Pipe=["#sanitize"]`.
8. **`TestImportPipeAppliedToEachLeaf`** — `-a -p "#sanitize"` → every emitted channel has `Pipe=["#sanitize"]`.
9. **`TestImportPipeEmptyStringClears`** — `-a -p ""` → every emitted channel has `Pipe=nil` (inherits root).
10. **`TestImportPipeFiltersEmpty`** — `-a -p "#sanitize" -p ""` → `Pipe=["#sanitize"]` (consistent with `filterPipe`).
11. **`TestImportIngestApplied`** — `-a --ingest "#telegram"` → every emitted channel has `Ingest="#telegram"`.
12. **`TestImportIngestEmptyStringClears`** — `-a --ingest ""` → every emitted channel has `Ingest=""` (inherits root).
13. **`TestImportMergeEmptyTitleError`** — `-a -t ""` → error.
14. **`TestImportMergeTitleWithoutSelection`** — `-t "X"` (no `-a`, no `-i`) → error.

Tests 7–12 exercise `applyImportDefaults` (described in `ImportCmd.Run`) directly, so they don't need to stand up a DB.

## Backward Compatibility

- All current invocations behave identically. New flags default to "absent".
- The one test update (`TestImportWalkerGroupSelectsChildren`) is a test-level change to assert the unchanged non-merge path; production behavior for `-i <group>` without `-t` is preserved.

## Open Questions

None.
