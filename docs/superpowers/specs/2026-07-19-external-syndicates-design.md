# External Syndicates — Design

**Date:** 2026-07-19
**Status:** Approved design, pre-implementation
**Scope:** backend only (the frontend/service-worker ignore `out` entirely; that does not change)

## Goal

Allow a syndication output (`out/<name>.rss|json`) to be **externally updated**: SRR reserves
and manages the *slot* (name, key, listing, GUI link, cleanup) but never generates its bytes.
An external tool — running on its own schedule, e.g. the daily-digest generator — publishes
the file through a new `srr syndicate push` command (payload from stdin/file) and reads the
currently published file back through its counterpart `srr syndicate fetch` (payload to
stdout) — together enabling stateless read-modify-write generators:
`srr syndicate fetch digest | merge-new-item | srr syndicate push digest`.

This is the inverted-control companion to long-running ingest work: instead of SRR running a
slow generator inside a fetch cycle, the generator runs wherever/whenever it likes and pushes
a finished feed. Today the digest pipeline hand-rolls this with a SigV4 PUT to R2 at an
undeclared key; this design gives that pattern a first-class home.

## Background (current behavior)

- `DBCore.Out []OutFeed` holds syndication config; `SyncOutFeeds` (db_out.go) regenerates
  every `out/<name>.<ext>` each fetch cycle from tag/feed selectors, gated by `outFeedsSig`
  and by `SRR_CDN_URL` being set.
- `setOutFeed` (cmd_syndicate.go) validates: name grammar (`validOutName`), format `rss|json`,
  **≥1 selector required**, feed ids exist, `Limit` defaulted to 50. Shared by the CLI and
  `PUT /api/syndicate/{name}` (serve_syndicate.go), so the GUI inherits any validation change.
- `removeOutFeed` deletes both extension files (files-first, `rmIfPresent`) before the Commit
  that forgets the entry.
- `out/` is a documented mutable object class: `cacheControlForKey` (store/main.go) stamps
  `no-cache, must-revalidate` on the `out/` prefix; `syncOneOutFeed` writes via
  `AtomicPut(key, ObjectMeta{ContentType: outContentType(of)})`.

## Design

### 1. Wire: `OutFeed.External`

```go
// External marks an externally-updated output: SRR reserves the slot
// (name, key, listing, rm cleanup) but never generates its bytes —
// SyncOutFeeds skips it; `srr syndicate push`/`fetch` are the only writers.
External bool `json:"ext,omitempty"`
```

- `omitempty`: absent == false == managed. No migration; existing db.gz unchanged. This is
  the **only** wire addition.
- `make generate` regenerates `format.gen.ts` (`IOutFeedWire` gains `ext?: boolean`);
  the frontend/service-worker keep ignoring `out` — reader contract untouched.

### 2. Config semantics + validation (`setOutFeed`)

`SyndicateSetCmd` gains `--external` (bool, `short:"x"` optional). The API body carries
`"ext": true` through the existing `decodeJSON` into `OutFeed` — no handler change.

Validation matrix in `setOutFeed` (single shared gate, CLI + API):

| Field | Managed (today, unchanged) | External |
|---|---|---|
| `Name` | `validOutName` | same |
| `Format` | `rss` \| `json` (names key + Content-Type) | same |
| `Title` | optional, output channel title | optional, **display label only** (ls/GUI); never written anywhere |
| `Tags`/`Feeds` | ≥1 selector required; feed ids must exist | **must be empty** — hard error ("external syndicate takes no selectors") |
| `Limit` | ≤0 → default 50 | **must be 0** — hard error ("external syndicate takes no limit") |

The `Limit` defaulting moves inside the managed branch so an external entry persists `Limit: 0`
(config never lies about a generation parameter that doesn't apply).

**Transitions** (full-replace semantics, as today):
- managed → external: existing file at the same key stays (now externally owned; next push
  overwrites it). Format change still reaps the old-extension file via the existing
  key-compare + `rmIfPresent` block.
- external → managed: normal selector validation applies; the entry re-enters `outFeedsSig`,
  so the next cycle's `SyncOutFeeds` overwrites the file with generated content.

### 3. `SyncOutFeeds` + `outFeedsSig`: skip external entries

- `SyncOutFeeds` iterates **managed entries only**. With zero managed entries it returns nil
  *before* the `SRR_CDN_URL` check — a store with only external syndicates must not warn
  about a CDN URL it doesn't need.
- The partial-failure denominator ("N of M syndication output(s) failed") counts managed
  entries only.
- `outFeedsSig` encodes the **filtered managed slice** (plus the per-feed tag/AddIdx suffix,
  unchanged). External-entry config edits (e.g. a title) no longer trigger managed rewrites;
  a managed↔external transition changes the filtered slice and un-gates the rewrite pass,
  which is exactly right. All-external stores return `""` like the empty case.
- `syncOneOutFeed`'s defense-in-depth `validOutName` re-check is unaffected (external entries
  never reach it).

### 4. `srr syndicate push <name> [path]` and `srr syndicate fetch <name>`

Symmetric plumbing over the slot: **push** writes the published file (payload from stdin
`-`, the default, or a file); **fetch** reads it back, always to stdout. Together they make
read-modify-write generators stateless — the published file itself is the state.

```
gen-digest | srr syndicate push digest      # publish from stdin (the default)
srr syndicate push digest feed.rss          # publish from a file
srr syndicate fetch digest                  # print the published file to stdout
srr syndicate fetch digest | merge-new-item | srr syndicate push digest
```

**Shared**: both commands run **lock-free** under `withDB(false, …)` (read-only db.gz load,
no `.locked`, no Commit) → resolve the entry by name → operate on `outFileKey(entry)`. They
never contend with a running fetch cycle or GUI mutation; `out/` is a mutable class and
db.gz is only read. Same spirit as `srr frontend update` (which skips the lock entirely).
An unknown name is a hard error on both: "unknown syndication output %q — declare it
first: srr syndicate set %q -f rss|json --external".

**`push`** (`Name string arg`, `Path string arg optional default:"-"`):

- Entry must be `External` — hard error otherwise: "syndication output %q is managed
  (generated from selectors each fetch cycle); a pushed file would be overwritten.
  Recreate it with --external."
- **Payload cap**: 64 MiB (consistent with the subprocess-stdout and frontend-download caps).
  Empty payload is a hard error.
- **Validation gate** (well-formedness only, before any store write):
  - `rss`: full `xml.Decoder` token walk (rejects malformed XML anywhere in the document);
    the first start element's local name must be `rss`.
  - `json`: must unmarshal to a JSON object whose `version` field is a string prefixed
    `https://jsonfeed.org/version/` (the JSON Feed marker).
  - No `--no-validate` escape hatch (YAGNI; revisit only if a real generator needs one).
- **Write**: `AtomicPut(outFileKey(entry), payload, ObjectMeta{ContentType: outContentType(entry)})`
  — byte-identical header discipline to `syncOneOutFeed`'s write; `cacheControlForKey`
  stamps `no-cache, must-revalidate` by prefix as it already does.
- **Output** (to stderr/log, never stdout): the key and byte count; when `SRR_CDN_URL` is
  set, also the public URL (`joinURL`).

**`fetch`** (`Name string arg` — no path argument, output is always stdout; redirect to
save a copy):

- Reads `Get(outFileKey(entry))` through the **store backend** — same config/credentials
  as push, not an HTTP GET of the CDN (no `SRR_CDN_URL` needed, no edge/cache between; the
  bytes are exactly what the store holds).
- Works on **any** declared entry, managed included — it is read-only, and reading what
  `SyncOutFeeds` last generated is a legitimate inspection use. Only push is external-only.
- A missing object (external entry never pushed; managed entry never synced) is a hard
  error naming the key — explicit beats silently piping empty input into a merge step.
  Read-modify-write generators bootstrap their first run with
  `srr syndicate fetch digest || true` (or by pushing an initial file once).
- **No validation gate and no cap** — it returns exactly the published bytes, streamed.
- Writes the payload alone to stdout, so it is pipe-clean for the read-modify-write flow;
  diagnostics go to stderr.

### 5. Serve API / GUI

- `PUT /api/syndicate/{name}` needs **no code change** — `decodeJSON` picks up `ext` and
  `setOutFeed` enforces the matrix. `GET /api/overview` ships it automatically (it
  marshals `db.core.Recipes`/`Out` directly).
- Webui syndicate modal: an "External" checkbox that hides the tag/feed pickers and the
  limit field (sends `ext: true`, omitting selectors/limit). List rows wear an `external`
  chip; the existing live-URL link (via `cdn_url`) works as-is.
- **No HTTP push endpoint.** Pushing bytes stays a store-credential operation via the CLI
  (Option 3 territory — can be layered on later by having a handler call the same
  internals, without changing this design).

### 6. `rm` / `ls`

Unchanged. `removeOutFeed` already sweeps both extension files files-first — external files
are covered with zero changes. `ls` includes `ext` via plain JSON marshaling.

## Concurrency & failure model

- **push/fetch vs fetch cycle**: no interaction — neither command takes the lock or writes
  db.gz, and `SyncOutFeeds` never touches external keys. `fetch` is read-only, so the
  races below concern `push` alone; a `fetch` racing any writer just returns the previous
  or the new complete object (`AtomicPut` is temp-then-rename on local/SFTP,
  object-atomic overwrite on S3).
- **push vs concurrent `rm`** (accepted race, documented): a push landing after `rm`'s file
  delete but before/after its Commit can strand `out/<name>.<ext>` with no config entry.
  Recovery is trivial (`set --external` + `rm` again, or a manual delete). Removing the race
  would require push to take the lock, which defeats its purpose; an operator deleting a slot
  while its push timer is live is a config-lifecycle mistake, not a crash mode.
- **push vs concurrent `set` format change**: same class — a push may write the
  old-extension file that `set` just reaped; the next push (with the reloaded entry) writes
  the new key, and `rm` sweeps both extensions regardless. Self-healing.
- **push crash mid-write**: `AtomicPut` is temp-then-rename on local/SFTP and a plain
  overwrite on S3/HTTP — readers never see a torn file on local/SFTP; S3 overwrite is
  object-atomic anyway.
- **Older binary against a db.gz with external entries**: unmarshal drops the unknown `ext`
  field in memory, so the entry looks managed-with-no-selectors — `syncOneOutFeed` hits
  "no matching feeds; skipping" and **does not overwrite the external file** (safe). But a
  Commit from that binary strips `ext` from db.gz (standard new-field caveat). Rollout rule,
  same as every db.gz addition: update all binaries (`srr-update be` on gateway/bastion/dmz)
  before declaring the first external entry.

## Testing

- `cmd_syndicate_test.go`: external validation matrix (selectors → error, limit → error,
  title ok, format still required); managed↔external transitions incl. format-change reap;
  `rm` deletes an external file; `ls` round-trips `ext`.
- New push/fetch tests (`cmd_syndicate_test.go` or `cmd_push_test.go`): happy path rss +
  json (bytes land at the right key; `ObjectMeta.ContentType` correct), stdin vs file path,
  unknown name, managed-entry rejection, malformed XML / non-JSON-Feed JSON / empty /
  over-cap payload rejections, no `.locked` created, db.gz byte-identical after publish.
  Fetch-specific: push→fetch round-trip is byte-identical on stdout, fetch of a managed
  entry's synced file works, missing object → hard error naming the key, unknown name →
  hard error.
- `db_out_test.go`: `SyncOutFeeds` leaves an external entry's file bytes untouched across a
  cycle; no CDN-unset warning when only external entries exist; `outFeedsSig` unchanged by
  external-entry edits, changed by a managed↔external transition.
- `cmd_serve_test.go`: `PUT /api/syndicate/{name}` with `ext: true` round-trips; overview
  carries `ext`.
- `make generate` + `generate-check` (gen-ts picks up the new field).

## Documentation updates

- Root `CLAUDE.md`: `out` row — note the `ext` flag and that external entries are updated
  only by `syndicate push`/`fetch`, never by `SyncOutFeeds`.
- `backend/CLAUDE.md`: `cmd_syndicate.go` bullet (new `push`/`fetch` subcommands +
  validation matrix), `db_out.go` bullet (managed-only iteration + sig).
- `backend/README.md`: syndication section — declare/push/fetch workflow, payload
  validation rules, the external-writer contract (key, Content-Type, cache headers all
  handled by SRR).

## Out of scope

- HTTP push endpoint on `srr serve` (Option 3; composable later).
- **SRR pulling the payload from a remote URL** (a stored source URL on the entry, an
  earlier draft's `fetch <name> <url>`, and with either, any auto-refresh of external
  entries during the fetch cycle) — considered and dropped: "updated externally" is the
  point, the cycle never writes these slots, and `fetch` reads the store, not the web.
- SRR executing external generators on a schedule (that's the long-running-ingest topic,
  tracked separately).
- Arbitrary formats/extensions beyond `rss`/`json`.
- `srr inspect` validation of `out/` objects (not validated today; unchanged).

## Operational payoff (non-normative)

The gateway digest timer becomes
`srr syndicate fetch digest | …merge today's item… | srr syndicate push digest` — retiring
the hand-rolled SigV4 PUT and the undeclared `feeds/digest.xml` key, and letting the
generator keep its rolling item window with no local state (the published file is the
state). Feed 48 then subscribes to `https://cdn.llera.eu/out/digest.rss`, making the store
both the digest's home and its source.
