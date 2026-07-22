# Findings Apply Plan

**Sources:** 2 — `docs/FINDINGS-2026-07-20.md` (consolidated from the four 2026-07-20 reviews)
+ the settled MCP-endpoint plan (`~/.config/claude/plans/refactored-skipping-whistle.md`,
brainstormed 2026-07-20 — integrated in full as S41–S44, since the plans dir is session-scoped)
·  **Net actionable:** 15 step(s), S30–S44
**Coverage:** PARTIAL by design — user-directed selection of the radical-architecture batch
(**ARC1 (decided: static store), ARC2, ARC3, ARC5, ARC7, ARC8**) plus the MCP endpoint
feature. Every other open
finding remains in `docs/FINDINGS-2026-07-20.md`. The prior batches A–H (S1–S29, planned
earlier on 2026-07-20) are applied in the working tree and were dropped when this plan was
regenerated; numbering continues at S30 so plain-text references to S1–S29 elsewhere stay
unambiguous.

> Regenerable plan; the findings doc is the living backlog (planned entries are removed from
> it — user rule 2026-07-20). Apply with `/apply-findings --apply` (or `--apply -i`).
>
> **ARC1's decision is made by the operator: (a) — SRR stays a static store.** S30 records
> it; every later step assumes it.
>
> All six entries were re-verified against the current working tree (main @ `615b62e` +
> applied S1–S29): still actionable. Notably, db.gz now carries the **`inbox`** map and
> **`dd`** default (post-findings additions) on top of the ~10 pointer fields the ARC2
> write-up counted — the manifest design must cover those too. `gen --bump` still reuses
> finalized names; config still rides db.gz; `PACK_BASE` is still a singleton
> (`frontend/src/js/base.ts`, imported by data/fmt/app); the 2026-06-29 admin-into-reader
> spec exists, unimplemented.

## Sequencing at a glance

S30 (decision record) → S31 (one combined manifest design doc — the ARC2+ARC5+ARC3 shape is
one coherent design, decided together) → S32 (backend dual-write) → S33 (reader root
indirection — **ships first**, the delta-tail reader-first discipline) → S34 (writer cutover +
ordering-proof cleanup) → S35 (generation-scoped rebuild/compaction) → S36–S38 (multi-store:
design, singleton refactor, mounting) → S39–S40 (admin-into-reader: spec refresh, then
implementation).

**S41–S44 (MCP endpoint)** sit outside the ARC chain: they touch `cmd_serve.go` /
`cmd_art.go` / `serve_overview.go` + new files — none of the manifest seam — and can land at
any point; the natural slot is **before S32** (small, self-contained, immediately useful) or
in parallel with the design docs. Only couplings: S39's spec refresh counts `/mcp` as part
of the serve API surface that survives the webui retirement, and the MCP tools ride the same
db APIs the manifest work later refactors underneath them.

**Open-finding prerequisites deliberately NOT in this plan** (still in the findings doc —
fold in or land before S32+; Appendix E of the findings doc sequences them first):

- **REL3** (lease + CAS locking): the manifest root flip *wants* compare-and-swap (S3/R2
  conditional PUT). Without it the root swap keeps today's advisory-lock semantics — workable,
  but S34 is the natural moment to land CAS. Strongly recommended before S34.
- **STO1** (`Backend.List`): makes manifest GC ("delete what no recent manifest references")
  trivial; without it GC keeps a low-water-mark compensation like today's `gcs`.
- **FET5** (store lock held across the network fan-out): independent of the manifest, but it
  bounds how long the new commit path holds the lock; sequence it first if convenient.
- **ARC6 / FMT6** (idx+meta merge / meta-card enrichment) were **not selected**: S31 must not
  paint the manifest into a corner that blocks a later single-derived-series format —
  manifests referencing packs **by name** rather than by stride formula is exactly what keeps
  that door open.

## Apply order

### docs/STATIC-ENGINE-DECISION.md (new)

- [x] **S30** — ARC1: record the fork decision — static store; server reads rejected
  ·  **P1 · S**  ·  from ARC1 (AR-S1)
  - **Edit:** New decision record (`docs/STORE-VISIBILITY.md` is the template). State plainly:
    SRR has built a small database engine on object storage (`data/` = heap, `idx/` = index,
    `meta/` = covering index + blooms, db.gz = superblock, deltas = WAL, consolidation =
    checkpoint, GC = vacuum, `gen` = epoch) — and that is the product, not an accident.
    Record option (b) — SQLite + a tiny read API behind the already-24/7 `srr serve` — and
    reject it **explicitly**: static reads are the project's identity; readers survive server
    death; SW offline and year-long edge caching are free; the wire contract, `gen-ts`, the
    `idx_read.go` mirror, and two e2e layers are the price, and it is worth paying. State the
    consequence: the simplification budget goes to *leaning in* (S31–S35), never to server
    reads. Cross-link `DELTA-TAIL-SPEC.md`, `INBOX-SPEC.md`, `STORE-VISIBILITY.md`, and add a
    one-line pointer in the repo `CLAUDE.md` Data Contract preamble.
  - **Why:** every remaining finding assumes static reads; a large fraction of the backend
    exists to avoid a server that now runs anyway — the rejection should be recorded, not
    inertial.
  - **Verify:** prose review; no build impact.
  - **Risk / deps:** none; unblocks everything below.

### docs/MANIFEST-SPEC.md (new — ARC2 + ARC5 + ARC3 designed as one)

- [x] **S31** — design the generation-manifest commit model (design doc only)
  ·  **P1 · L (doc)**  ·  from ARC2 (BE-A1) + ARC5 (AR-S5 · BE-A4) + ARC3 (AR-S3 · BE-A2)
  - **Edit:** Write the spec (DELTA-TAIL-SPEC is the register to match). Decisions it must
    make, at minimum:
    1. **Objects & naming** — immutable `manifest/<n>.gz` per `Commit`, with its **own**
       monotonic counter (`seq` only moves on article cycles; Commits also happen on
       feed/config mutations). Root `db.gz` keeps its name (readers and infra point at it)
       but shrinks to `{v: 2, m: <n>}`, still no-cache. New grammar row in `store.PackSeries`
       (→ generated `PACK_SERIES_KINDS`, SW route, `cacheControlForKey` immutable).
    2. **Content split (the ARC5 axis)** — (a) *manifest*: everything reader-consumed —
       pointer fields (`seq`/`hdrs`/`mp`/`mt`/`nd`/`na`), `total_art`/`next_pid`/`pack_off`/
       `fetched_at`, the feeds' reader-facing fields, `head`/`hb`; (b) *config sidecar*
       (backend-only, mutable — the seen.gz precedent): `recipes`, `out`, `dd`, per-feed
       `recipe`/`ingest`/`pipe`/dedup knobs — config edits stop rewriting the reader-hot
       object and stop 409ing a running fetch cycle (decide its commit/lock story: same
       `.locked`, or CAS per REL3); (c) *writer state* (`sf`, `dby`, `gcs`, `inbox`) — tiny;
       recommend riding the manifest, but decide. Side effect: most of the SEC1-class
       metadata leak closes (`docs/STORE-VISIBILITY.md`'s "future leak-shrinker").
    3. **Boot/poll trade-off** (the `head`/`hb` question from the ARC2 write-up) — the reader
       polls the ~50-byte root; unchanged `m` ⇒ the manifest is already SW/HTTP-cached, zero
       marginal bytes; changed `m` ⇒ one immutable, edge-cacheable manifest fetch (≈ today's
       db.gz minus config). Net bandwidth strictly down; +1 RTT only when a new generation
       exists. Recommend `head`/`hb` stay in the manifest (it is fetched per change anyway).
    4. **Pack naming (the ARC3 axis)** — manifests list live pack names **explicitly** per
       series (a few KB at 1M articles) instead of the count-derived formulas. That kills
       name reuse (a rebuild writes new names + a new manifest; old manifests keep old bytes
       reachable through the grace window), makes GC = "unreachable from the last K
       manifests", and retires `gen`, `gen --bump`, the purge WARNs, and the SW
       purge-on-gen-change. Decide whether a computed-name fallback survives (recommend no —
       v2 is a clean break gated by the existing version handshake).
    5. **The universal crash argument, stated once** — every cycle writes only new immutable
       objects, then one immutable manifest naming them, then flips the root; a crash
       anywhere before the flip leaves unreferenced garbage, never corruption. The
       per-feature "write object first, publish pointer via Commit" proofs in `SyncSeen`,
       `SyncIdxSummary`, `SyncMeta`, `SyncOutFeeds`, and the delta/consolidation path all
       collapse into it.
    6. **Redundancies to retire at cutover** (feeds S34) — the `db/` snapshot series
       (manifests ARE snapshots; restore = repoint the root), the seen.gz `sf` ping/pong
       (slots can be manifest-named `seen/<n>.gz`), and the generation-named `h<N>`/`s<N>`
       summary objects (manifest-listed like everything else). Enumerate each with its own
       paragraph.
    7. **Device-state stability across compaction — the hard open question** (from ARC3):
       frontiers, ★-saved chronIdxs, and pins are keyed by chronIdx; a physical compaction
       renumbers chrons and strands them all. Options: a chron→chron mapping object published
       with a compacting manifest, or a stable per-article identity for device state. **Must
       be answered here before S35 permits physical drops.**
    8. **Migration & rollout** — reader-first, the delta-tail discipline: S32 dual-write
       (manifest published alongside the full legacy db.gz, root shape unchanged) → S33
       reader handles both root shapes → reader deployed everywhere (CF Pages + the
       store-root shell — the operator runs the shell update) → S34 writer flips the root
       and bumps `dbFormatVersion`; old readers get the clean version-reject popup.
  - **Why:** every 2026-06/07 feature added a db.gz field *and* a bespoke ordering proof;
    the complexity cost is per-feature and growing. One design doc buys one crash argument,
    edge-cacheable store state, config out of the hot path, and the end of name reuse.
  - **Verify:** design review against `docs/DELTA-TAIL-SPEC.md` + `docs/INBOX-SPEC.md`
    invariants (I2, the seam cross-checks, inbox drain atomicity) — each must map onto the
    manifest model or be explicitly retired.
  - **Risk / deps:** after S30. Sign-off gates S32–S35; the doc must leave the ARC6
    single-series door open (see prerequisites note above).

### backend — manifest commit model (ARC2 + ARC5 implementation)

- [x] **S32** — dual-write: publish `manifest/<n>.gz` + config sidecar alongside legacy db.gz
  ·  **P1 · L**  ·  from ARC2 + ARC5
  - **Edit:** Per S31: split `DBCore` into manifest state / config / writer state;
    `Commit` additionally writes the immutable manifest (and the config sidecar on config
    mutations) while still writing today's full db.gz with the root fields unchanged — every
    intermediate release stays readable by deployed readers. New `PackSeries` row + `gen-ts`
    regeneration (`make generate`).
  - **Why:** the incremental, always-compatible first half of the cutover.
  - **Verify:** full `make verify` (touches the wire contract → contract layer mandatory) +
    `make test-browser`; `srr inspect --validate` learns to cross-check manifest ↔ legacy
    fields and passes on a migrated copy of the prod store.
  - **Risk / deps:** S31 signed off. REL3/STO1/FET5 (open findings) ideally first — see
    prerequisites note.

- [x] **S34** — cut over: root becomes `{v:3, m:<n>}`; collapse the per-feature orderings
  ·  **NOTE:** shipped at `dbFormatVersion = 3`, not the spec's 2 — the dual-write release
  stamped manifests `v:2` with a *transitional* `names` encoding that the cutover replaces,
  so at `v:2` a v4.7.1 reader would pass the version gate and then misread the new `names`
  as an empty store (verified: hard delta-count error on any store with a live chain). At
  `v:3` it stops at the root with the intended version popup.
  ·  **P1 · L**  ·  from ARC2 + ARC5
  - **Edit:** Flip the writer: db.gz shrinks to the root pointer; bump `dbFormatVersion` to 2.
    Then the cleanup the manifest pays for: retire the `db/` snapshot series (+ its GC), the
    `sf` ping/pong naming (seen slots become manifest-named), the bespoke publish-order code
    in the four Sync functions, and the corresponding CLAUDE.md Data Contract + spec-doc
    sections (rewrite, don't append).
  - **Why:** the complexity win only lands when the old orderings are deleted, not shadowed.
  - **Verify:** full `make verify` + `make test-browser` + `make test-e2e`; crash-safety
    suite (the S1–S29 stop-anytime harness work) re-run against the new commit path;
    `srr inspect --validate` on the migrated store.
  - **Risk / deps:** **S33's reader must be deployed everywhere first** (CF Pages + store-root
    shell — operator-run) or every stale reader hard-errors; the version gate makes the
    failure clean but still user-visible. One-way door for the prod store — take a final
    legacy `db/` snapshot before the flip.

### frontend — manifest boot (ARC2 reader side)

- [x] **S33** — reader + SW dual-path: follow the root indirection when present
  ·  **P1 · M**  ·  from ARC2
  - **Edit:** `data.ts parseDb`: a root carrying `m` fetches `manifest/<n>.gz`
    (`force-cache`, immutable) and proceeds; a legacy full db.gz keeps today's path. SW route
    regex picks up the new series from the regenerated `PACK_SERIES_KINDS`; manifest names
    join the SW's GC-mirroring prune. Respect the Appendix D invariants — `refresh()`'s
    rollback snapshot and the `na` cross-check must cover the manifest-sourced fields.
  - **Why:** reader-first deploy discipline; this ships and deploys before S34 flips anything.
  - **Verify:** full `make verify`; e2e contract fixtures for BOTH root shapes;
    `make test-browser`.
  - **Risk / deps:** after S32 (needs the writer to produce manifests for fixtures). Deploy to
    CF Pages + store-root shell before S34.

### backend — generation-scoped rebuilds & compaction (ARC3 implementation)

- [ ] **S35** — rebuilds write fresh names; retire `gen`; physical compaction becomes routine
  ·  **P2 · L**  ·  from ARC3 (AR-S3 · BE-A2)
  - **Edit:** Per S31 §4/§7: a rebuild writes new pack names + a new manifest beside the old
    generation and flips the root — never overwrites. Retire `srr gen --bump`, the SW
    purge-on-gen-change, the edge-purge WARNs (`asset heal` gets a fresh-name path too), and
    the "preserve expired articles or strand `add_idx`/`xp`" rebuild-discipline rules. Add
    the scheduled compaction op that physically drops expired articles — **gated on S31 §7's
    device-state answer**.
  - **Why:** immutability currently has an asterisk; this removes it and turns compaction
    from a feared manual op into a routine one, finally reclaiming bytes.
  - **Verify:** full `make verify` + browser layer; rebuild+compact a copy of the prod store,
    then `srr inspect --validate` + a stale-tab reader session across the flip (grace-window
    behavior).
  - **Risk / deps:** after S34. Transient 2× storage during a rebuild — fine on R2, note it.

### frontend — multi-store mounting / federation (ARC7)

- [x] **S36** — multi-store design doc (`docs/MULTI-STORE-SPEC.md`)
  ·  **P2 · M (doc)**  ·  from ARC7 (IM-I22)
  - **Edit:** Decide: the mount table (where it lives — device localStorage + profile
    backup); namespacing of **every** per-store device key (seen frontiers, ★-saved, pins,
    sync, caches — audit `keys.ts` + the bypassers flagged in ENG5); SW cache partitioning
    and route matching across N roots; merged timeline vs per-store lanes (the big UX
    question); per-store auth/CORS (each mounted store's origin must allow the reader origin,
    the srr.32b.io lesson; private stores via Access service tokens per
    `docs/STORE-VISIBILITY.md`); federation mounts are read-only + per-store version
    handshake; out of scope: cross-store dedup.
  - **Why:** mounting N roots turns the pack format into a static, serverless federation
    protocol — the most conceptually distinctive direction available — and enables
    public/private store splits.
  - **Verify:** design review; explicitly rebased on the post-S33 boot contract (root →
    manifest), not on legacy db.gz.
  - **Risk / deps:** after S33 stabilizes the boot contract, else this gets designed twice.

- [ ] **S37** — refactor the `PACK_BASE` singleton into a store context (single-store,
  zero behavior change)  ·  **P2 · M**  ·  from ARC7
  - **Edit:** `base.ts`'s `PACK_BASE` becomes a per-store context object threaded through
    `data.ts` (5 uses), `fmt.ts` (4), `app.ts` (3), and the SW message prefixing; module
    state in `data.ts`/`nav.ts` keys off the context. Pure refactor — single-store output
    byte-identical where testable.
  - **Why:** the mechanical prerequisite for N roots, worth landing early while the area is
    warm from S33; shrinks S38 to wiring + UI.
  - **Verify:** full `make verify` + `make test-browser` + `make test-stress` (nav/data hot
    paths touched).
  - **Risk / deps:** after S33 (same files); before S38. Respect the Appendix D fragile
    invariants (`buildLatestIdx`, `deltaLoad` ordering, `refresh()` snapshot).

- [ ] **S38** — implement mounting per the spec  ·  **P2 · L**  ·  from ARC7
  - **Edit:** mount management UI, N-root boot (parallel root+manifest fetches),
    namespaced lanes/picker grouping, per-store sync/profile, SW multi-root caching —
    exactly as S36 decided.
  - **Verify:** browser layer + a manual two-store smoke (prod store + a local `packs/`
    store); offline/SW behavior with one store unreachable.
  - **Risk / deps:** after S36 + S37.

### admin-into-reader (ARC8)

- [x] **S39** — refresh the 2026-06-29 admin-into-reader spec under the Access topology
  ·  **P3 · M (doc)**  ·  from ARC8 (FE-R4)
  - **Edit:** Update `docs/superpowers/specs/2026-06-29-admin-ui-into-reader-design.md`
    (or supersede it beside the other specs): the "no auth, loopback-only" blocker is stale —
    serve runs on dmz behind Cloudflare Access. Must decide the cross-origin topology: reader
    at srr.32b.io vs serve API at admin-srr.llera.eu (CORS + credentialed fetches through
    Access, vs serving the admin route only from the admin origin). Ride SEC3's security
    headers along. Shipping path is release.yml → CF Pages (the operator's store-root shell
    rule stands: never `srr frontend update` from automation). Inventory the `backend/webui/`
    features to migrate (feed CRUD, overview, fetch-now, preview, import/export, dedup,
    syndication). The `/mcp` endpoint (S41–S44) is part of the API surface that stays.
  - **Why:** retires the hand-written vanilla webui and unifies the design system; the
    original blocker no longer exists.
  - **Verify:** design review.
  - **Risk / deps:** independent of S31–S38; P3 — do last, or when the itch returns.

- [ ] **S40** — implement: admin becomes a same-origin console; serve keeps serving it
  ·  **P3 · XL**  ·  from ARC8
  - **AMENDED 2026-07-21** (operator-confirmed, per S39's `docs/superpowers/specs/
    2026-07-21-admin-console-same-origin-design.md`): the original "serve becomes API-only"
    is **revised — `srr serve` KEEPS its static file server**, now serving a Parcel-built
    bundle via `//go:embed` instead of hand-written sources. Rationale: the cross-origin
    alternative must delete `hostGuard`'s Origin/`Sec-Fetch-Site` check (which Access does
    not backfill) and would hand the untrusted-HTML-rendering reader origin credentialed
    write access to the store's only writer. Keeping it same-origin also keeps deployment at
    exactly `srr-update be`, with no console↔API version skew. The edge path-split that
    would make serve truly API-only is recorded as alternative B2 and stays a pure
    *deployment* change later, because the bundle hardcodes no API base.
  - **Edit:** per the refreshed spec — port the 36 inventoried webui features into a
    Parcel-built admin bundle embedded in the binary, delete the hand-written
    `backend/webui/` sources **and** the `minifiedWebUI()` startup minify step (both still
    go, as originally planned), keep `hostGuard` semantics on the API, and ride SEC3's
    security headers along. Build the admin bundle in its own `parcel build` invocation —
    not a shared multi-entry build, which could hoist chunks and rewrite the reader's
    content hashes.
  - **Verify:** full `make verify` + browser layer + a manual admin smoke against a local
    `srr serve`; confirm the reader bundle size for non-admin users is unchanged.
  - **Risk / deps:** after S39 sign-off. Coordinate the admin-srr.llera.eu tunnel/Access
    config at deploy time (operator).

### backend — MCP endpoint (`/mcp` in serve + `srr mcp` stdio)

*From the settled MCP plan, not the findings doc — nothing to trim from the findings doc for
these. Settled decisions: clients now are on-box agents (loopback), off-box Claude Code
(Access service token via MCP headers), stdio anywhere the CLI lives; claude.ai/phone is
**phase 2, out of scope** (public OAuth'd hostname — `mcpHTTPHandler()` is the wrap seam,
nothing here constrains it). Tool surface is read + curated writes; **excluded on purpose**:
feed delete, gen bump, dedup, syndicate, import/export, inspect.*

- [x] **S41** — prep: SDK dep + the two extractions the tools reuse
  ·  **feature · M**  ·  from mcp-plan steps 1–3
  - **Edit:** (1) `go.mod`/`go.sum`: official `github.com/modelcontextprotocol/go-sdk`
    pinned **v1.6.x** (Go ≥1.25; repo is go 1.26.0; avoid v1.7.0-pre) + its
    `google/jsonschema-go` dep, `go mod tidy`; confirm the exact v1.6 signatures used
    (`AddTool`, `Tool.Annotations`, `StreamableHTTPOptions` fields) — compile-time
    mechanical. (2) `serve_overview.go`: extract `getOverview`'s inlined projection
    (lines 40–81) into plain `buildOverview(db *DB) overviewView`; handler becomes a thin
    wrapper, no wire change (pinned by serve_overview_test.go). (3) `cmd_art.go`: extract
    the collection body of `ArtCmd.Run` (~118–203, minus `printJSON`) into
    `listArticles(ctx, db, artQuery) (*articlesOutput, error)` with
    `artQuery{ids, tags, limit, before, since, until, query}`; NEW `query` filter — fold
    via `foldSearchText` (db_meta.go:54; error if it folds empty), match closure (feed
    filter first, then title fold + `strings.Contains` via the shared `packReader.at`)
    applied in BOTH the total-count and collection loops; dangling entry = non-match. CLI
    parity: `Query string` with `short:"q"` on `ArtCmd` (`-q` is free).
    `readAllIdx`/`packReader`/`findWindow`/`loadContent` untouched.
  - **Why:** tool handlers wrap existing logic instead of forking it — GUI, CLI, and MCP
    stay on one body.
  - **Verify:** `go build ./...`; existing overview tests; new `TestArtListQueryFold`
    (accent/case-insensitive match, Total inside window, query + `--before` paging).
  - **Risk / deps:** independent of S30–S40. `ArtCmd.window`'s error wording is
    test-pinned — MCP parses its own bounds (`parseMCPWindow`, S42) rather than sharing it.

- [x] **S42** — registry + the 7 tools  ·  **feature · L**  ·  from mcp-plan steps 4–6
  - **Edit:** New `mcp.go`: `newMCPServer()` = `mcp.NewServer(&mcp.Implementation{Name:
    "srr", Version: version}, nil)` (reuse `var version`, main.go:20) + `addMCPTools`;
    `mcpHTTPHandler()` = `mcp.NewStreamableHTTPHandler(..., &mcp.StreamableHTTPOptions{
    Stateless: true, JSONResponse: true})` — stateless because the binary restarts on
    deploys and no server-initiated messages are needed; JSONResponse so nothing SSE
    buffers through the tunnel; **this function is the single seam a phase-2 auth
    middleware wraps**. `mcpToolErr(err)`: `os.ErrExist` → "store busy: fetch cycle in
    progress; retry shortly" (mirrors `writeErr`'s 409 / `msgLockContention`,
    cmd_serve.go:185–209); context cancellation → "cancelled: …"; else pass through
    (validation messages are already operator-grade). New `mcp_tools.go` — named top-level
    handlers (testable without transport), **`srr_` name prefix**:

    | Tool | Wraps | Annotations |
    |---|---|---|
    | `srr_list_articles` | S41's `listArticles` in `withDBCtx(false)` | ReadOnly, Idempotent |
    | `srr_overview` | S41's `buildOverview` in `withDBCtx(false)` | ReadOnly, Idempotent |
    | `srr_preview_feed` | `renderPreview` (cmd_preview.go) in `withDBCtx(false)` | ReadOnly, Idempotent, OpenWorld |
    | `srr_resolve_feed` | `previewFetch` (serve_tools.go:64) + `validFeedURL` gate | ReadOnly, Idempotent, OpenWorld |
    | `srr_add_feed` | two-phase: `resolveFeedViewURL` in `withDBCtx(false)` → `saveFeed` in `withDBCtx(true)` (mirrors handleFeedSave, serve_feeds.go:143–171); returns `listViewOf(saved)` | write, non-destructive, OpenWorld |
    | `srr_update_feed` | phase 1 also loads the current feed (`db.FeedByID` → `viewOf`) and overlays non-nil inputs, then the same two-phase | write, Destructive, Idempotent |
    | `srr_fetch` | `runCycleSafe(func(){ (&FetchCmd{only: in.FeedIDs}).runFetch(ctx, client, onFeed) })` (cmd_fetch.go:220,351); `newFetchClient(globals.Workers)` + `defer CloseIdleConnections`; collect `feedProgress` under a mutex (onFeed runs on worker goroutines), sort by id, derive fetched/failed/new counts | write, non-idempotent |

    I/O structs use **descriptive JSON keys** (not the pack short keys) with `jsonschema:`
    descriptions on every field: `listArticlesIn{FeedIDs, Tags, Query, Limit, Before *int,
    Since, Until string, IncludeContent bool}` → `listArticlesOut{Articles []mcpArticle,
    Total, NextCursor *int}` (content only when `include_content`; feed titles resolved in
    the same DB scope; since/until via `parseMCPWindow` over the shared `parseTimeBound`);
    `previewFeedIn{URL, Recipe, Ingest, Pipe, Limit=5, MaxContentChars=5000, rune-safe
    truncate}`; `addFeedIn{Title, URL, Tag, Recipe, Ingest, Pipe, NoTitle, ExpireDays,
    DedupDays, DedupTitle}`; `updateFeedIn{ID int; all other fields pointers}` —
    **merge-on-absent** (omitted = keep, explicit empty = clear where the CLI convention
    allows; a deliberate deviation from the GUI's full-replace contract, safe for LLM
    callers); `fetchIn{FeedIDs []int}` → `fetchOut{NewArticles, Fetched, Failed,
    Feeds []feedProgress}` (`feedProgress` is already JSON-tagged, cmd_fetch.go:249–254).
  - **Why:** agents currently operate the store by shelling out to the CLI; a typed,
    transport-agnostic tool registry makes them first-class at the same trust boundary.
  - **Verify:** `go vet ./...`; handler unit tests (S44 details them).
  - **Risk / deps:** after S41. Preview/resolve are network tools behind an LLM — same
    SSRF-guarded client as the GUI (`newFetchClient` → `mod.SafeTransport`); tool
    descriptions must state "performs outbound requests". `query`'s exact Total reads every
    data pack in the window (packReader caches each once) — fine on the dmz-local store;
    say "pair `query` with `since`" in the description, cap later if it bites. `srr_fetch`
    can run minutes with no progress (stateless+JSON forgoes progress notifications —
    wiring `req.Session.NotifyProgress` later is additive); cancellation is honest (ctx
    threads into `runFetch`; lock released by `db.Close`).

- [x] **S43** — transports: mount `/mcp` in serve + the `srr mcp` stdio subcommand
  ·  **feature · S**  ·  from mcp-plan step 7
  - **Edit:** `cmd_serve.go newMux()`: `mux.Handle("/mcp", mcpHTTPHandler())` — **no
    method prefix** (streamable HTTP needs POST+GET+DELETE; exact "/mcp" beats the
    "GET /" wildcard); sits inside `hostGuard` unchanged (non-browser MCP clients send no
    Origin, and the tunnel rewrites Host to `localhost:8088`). No `--no-mcp` flag: `/mcp`
    is a strict subset of what `/api/*` already exposes to the same trust boundary. New
    `cmd_mcp.go`: `McpCmd.Run` = `signal.NotifyContext(SIGINT, SIGTERM)` +
    `newMCPServer().Run(ctx, &mcp.StdioTransport{})`; `main.go` gains
    `Mcp McpCmd` (`cmd:"" help:"Serve the SRR MCP tool interface over stdio."`). Stdout
    cleanliness already holds (slog → stderr via `log.SetOutput(status)`, main.go:170 +
    progress.go:18; the fetch progress line no-ops on non-tty stderr; `printJSON`/banners
    live only in CLI `Run()` methods not traversed) — document the invariant in a comment:
    tool handlers must never call `printJSON`/`fmt.Print*`.
  - **Verify:** HTTP tests (S44); manual `dist/srr mcp` initialize echo — parseable
    response on stdout, logs on stderr.
  - **Risk / deps:** after S42.

- [x] **S44** — tests, docs, gate  ·  **feature · M**  ·  from mcp-plan steps 8–10
  - **Edit:** `mcp_test.go`, three layers on existing patterns (`setupTestDB`,
    `seedFeed`/`doReq`, `stubPassthroughResolve`): (1) **handler-level** — overview carries
    feed vitals + version; list_articles folded query (`"cafe"` matches `"Café"`), window,
    cursor, include_content on/off; add→update with only `tag` set preserves
    title/url/pipe (pins merge-on-absent) and `ingest: ""` clears; fetch against a held
    lock (`NewDB(ctx, true)` open) → "store busy"; unknown feed id → error naming it; bad
    `since` → `parseTimeBound` message. (2) **HTTP** — `mcpReq` helper (doReq +
    `Content-Type: application/json`, `Accept: application/json, text/event-stream`)
    against `newMux()`: initialize → tools/list (all 7 names) → tools/call `srr_overview`
    (JSONResponse ⇒ plain JSON body); negative: non-loopback Host on `/mcp` → 403.
    (3) **stdio-equivalent smoke** — `mcp.NewInMemoryTransports()` + `newMCPServer().Run`
    in a goroutine + `mcp.NewClient` ListTools/CallTool (the `srr mcp` code path minus OS
    pipes; no subprocess builds in tests). Docs: README "MCP" section (tool table; client
    registrations — loopback `claude mcp add --transport http srr
    http://localhost:8088/mcp`; remote via `https://admin-srr.llera.eu/mcp` +
    `CF-Access-Client-Id`/`-Secret` headers (the Access Service Auth policy + token is an
    operator step, not part of this change; or `headersHelper` to keep the secret out of
    `.mcp.json`); stdio `claude mcp add srr -- srr mcp`; recommend
    `MCP_TOOL_TIMEOUT=600000` when whole-store `srr_fetch` is expected); backend/CLAUDE.md
    + root CLAUDE.md bullets.
  - **Why:** the three test layers pin exactly the three contracts (handler semantics,
    HTTP transport through hostGuard, stdio).
  - **Verify:** `go test ./...`, then full `make verify-be` (nothing reachable from
    `cmd_gents.go` is touched, so generate-check stays green). Manual e2e against a local
    test store (**`-o packs` — NEVER the default prod config**): `dist/srr serve` + a
    scratch-session `claude mcp add --transport http srr-test http://localhost:8088/mcp` →
    list feeds, query articles, add a feed, trigger a single-feed fetch.
  - **Risk / deps:** after S43. Deployment is docs-only — the next release's `srr serve`
    grows `/mcp` automatically on dmz; MCP writes during the 5-min loop's cycle get "store
    busy" (the same 409 contract as the GUI). The digest pipeline may later swap its
    `srr art ls` shell-outs for `srr_list_articles{include_content: true}` — optional,
    decoupled.

## Stale / unverified — needs re-check (NOT auto-applied)

- none — all six entries re-verified against the working tree on 2026-07-20.

## Skipped

- none — the selection was user-directed; unselected findings were not evaluated here and
  remain in `docs/FINDINGS-2026-07-20.md` (notably ARC6, deliberately left to a combined
  decision with FMT6).

## Coverage detail

- `docs/FINDINGS-2026-07-20.md` is itself a merge of four COMPLETE review documents, but
  this plan covers only the six user-selected ARC entries — it is NOT exhaustive of the
  findings doc, let alone the codebase.
- S41–S44 come from the separate, settled MCP-endpoint plan
  (`~/.config/claude/plans/refactored-skipping-whistle.md`), integrated here in full so the
  session-scoped plans file is no longer load-bearing; they are a feature, not a finding —
  nothing was removed from the findings doc for them.
- Prior plan batches A–H (S1–S29) were applied in the working tree earlier on 2026-07-20 and
  are not repeated here; the plan file is regenerated fresh per the skill contract.
- Open-finding prerequisites REL3 / STO1 / FET5 are flagged inline above but NOT planned —
  re-run `/apply-findings` with them selected to fold them in before S32.
