# Findings Apply Plan

**Sources:** 1 — `docs/FINDINGS-2026-07-20.md` (2026-07-25 revision)
·  **Net actionable:** 12 step(s), S63–S74
**Coverage:** PARTIAL by design — user-directed selection of **GRO6, GRO7, STO1–STO6,
RDR3, RDR7, RDR11, RDR14**. Every other open finding remains in
`docs/FINDINGS-2026-07-20.md`. Numbering continues at S63 so plain-text references to
S1–S62 elsewhere stay unambiguous.

> Regenerable plan; the findings doc is the living backlog (planned entries are removed
> from it — user rule 2026-07-20). Apply with `/apply-findings --apply` (or `--apply -i`).
>
> All 12 findings were re-verified against HEAD (`3601ba8`) on 2026-07-26: **all
> ACTIONABLE**. Ground-truth shifts folded into the steps: the merged
> `fix/manifest-review-findings` work made SyncMeta's rebuild strictly all-or-nothing on
> a staged `names` clone (S68 must preserve its zero-progress-rebuild safety, not undo
> it); STO2's cited `db_meta.go:290` consequence is OBSOLETE (that path was rewritten at
> the cutover — the surviving hazards are `rmIfPresent`'s Stat==0-as-absence and the
> assets HEAD+GET double probe); STO5's `DetectContentType` half now contradicts the
> documented "assets are typed by peek/process alone — never by extension or
> byte-sniffing" convention (store/main.go, s3.go, backend/CLAUDE.md) — S70 overturns it
> for the no-peek case only and updates those comments in the same step. Frontend
> shifts: the S45–S62 batch grew app.ts to ~1,858 lines — anchor on symbols (the
> content error-capture is now `app.ts:1636`, the silent `onStoreGrown` call
> `app.ts:1555`); RDR1's undo machinery (S57, `nav.pendingFrontierUndo`) now exists, so
> S74's swipe read-toggle rides it instead of being irreversible.

## Previously applied batches (dropped from this plan's step list)

- **S30–S44** — manifest cutover, compaction, multi-store, admin console, MCP: applied,
  released (v4.8.0/v4.8.1), deployed.
- **S45–S62** — crash harness + fuzzers, lease lock + CAS root flip, reading-surface
  batch, undo, saved-asset pins, PWA badge/toast: applied on local main (`ebe9367` +
  three review rounds), all gates green, **not yet released or deployed**.

## Sequencing at a glance — four parallel batches

Four tracks: **A (store contract)** S63 → S64 → S65 → S66 → S67, strictly sequential
(same `store/` files, each step builds on the previous shape); **B (writer)** S68 ∥ S69,
independent of everything; **C (assets)** S70, after S63 only (S63 rewrites the same
probe region in assets.go); **D (frontend reader)** S71 → S72 → S73 → S74, sequential
within itself (S71/S72 share app.ts, S73/S74 grow the same gestures.ts touch state
machine) but fully parallel with the backend tracks — one frontend step rides each
batch.

Execution batches (worktree-agent friendly, disjoint files within each batch; run the
FULL `make verify` after each batch lands, plus `make test-race-be` for batches 1, 3, 4
and `make test-browser` for every batch carrying a frontend step — the browser layer is
NOT inside `make verify`):

| Batch | Steps in parallel | Files |
|---|---|---|
| 1 | **S63** ∥ **S68** ∥ **S69** ∥ **S71** | store/* + Get/Stat call sites ∥ db_meta.go ∥ db_pack.go ∥ list.ts + app.ts + styles.css |
| 2 | **S64** ∥ **S70** ∥ **S72** | store/* + manifest.go + cmd_inspect* + cmd_frontend.go ∥ assets.go ∥ app.ts + lightbox.ts (new) + styles.css |
| 3 | **S65** ∥ **S66** ∥ **S73** | store/main.go + s3.go + manifest.go + db_expire.go ∥ sftp.go + http.go ∥ gestures.ts + list.ts + styles.css |
| 4 | **S67** ∥ **S74** | store/* (wraps the settled shape) ∥ gestures.ts + list.ts + styles.css |

**Couplings:** S64 needs S63's error contract (List's missing/unsupported semantics
follow it). S65 completes the GC rework S64 starts — never reorder them or the sweep is
rewritten twice. S67 needs S63 (retry classifies wrapped sentinels) and S66 (redial
invalidates the session memo). S70 needs S63 (probe region overlap). S72 follows S71
(both edit app.ts); S74 follows S73 (both extend gestures.ts single-finger tracking —
land the vertical pull first, then the horizontal row swipe, so the two never race in
one diff). S74 consumes S57's undo machinery (already applied). Nothing here touches
the idx/data/meta wire format, gen-ts atoms, or sanitizer parity — but batch
verification stays `make verify` (full) per the parallel-execution rule, and the
gesture steps (S73, S74) additionally need an on-device sanity pass: headless cannot
reproduce touch/overscroll behavior.

## Apply order

### store/ — the contract foundation (Track A)

- [x] **S63** — STO2: unify missing-key semantics on `fs.ErrNotExist`; fix `Stat` conflation  ·  **P2 · M**  ·  from STO2 (BE-S2)
  - **Edit:** every backend wraps missing-key errors in `fs.ErrNotExist`: `s3.go:139`
    (Get's unwrapped `"key %q not found on s3"`) and the HeadObject not-found arms;
    `http.go:134` (Get 404/410); local/SFTP already surface `fs.ErrNotExist` — pin it.
    Change `Stat`'s contract from missing=(0, nil) to missing=`fs.ErrNotExist`-wrapped
    error, and update every call site by intent: `cmd_syndicate.go:378` `rmIfPresent`
    treats ONLY `errors.Is(statErr, fs.ErrNotExist)` as proof-of-absence (fixes the
    present-but-undeletable out-file getting its config dropped when an HTTP HEAD omits
    Content-Length); `assets.go:339-353` probe — a nil-error Stat now proves presence, so
    **delete the body-carrying Get fallback** (the HEAD+full-GET tax on every new asset);
    `cmd_asset.go:78`, `cmd_fetch.go:733` (inbox probe), `config_sidecar.go:146`,
    `db_expire.go`'s stat phase (absent-as-zero stays, now via `errors.Is`). Retire
    `Get`'s `ignoreMissing` flag — callers use `errors.Is` on the returned error. Add a
    shared conformance test in `store_test.go` pinning missing-key behavior for
    Get/Stat/Rm across all four backends.
  - **Why:** three ad-hoc absence contracts let a transient error impersonate absence;
    `rmIfPresent` can strand a real file forever, and every asset upload pays a
    redundant GET.
  - **Verify:** `make verify-be`; new conformance test + an `rmIfPresent`
    undeletable-but-present test.
  - **Risk / deps:** touches every backend and ~all Get/Stat call sites — the track's
    foundation; land FIRST. The assets.go edit is confined to the probe (S70 rewrites
    the buffering around it afterwards).

- [x] **S64** — STO1: add `List` to the Backend interface — retire the compensation economy  ·  **P2 · L**  ·  from STO1 (BE-S1)
  - **Edit:** `List(ctx, prefix string) ([]string, error)` on `Backend`
    (`store/main.go`): local = `filepath.WalkDir`, SFTP = `client.Walk`, S3 =
    paginated `ListObjectsV2`, HTTP = `errors.ErrUnsupported` (callers keep their
    fallback). Adopt where the compensation economy lives: (a) `GC`
    (`manifest.go:192-260`) gains a list-and-delete mode when List is supported —
    reachable set unchanged (current names ∪ oldest-in-window manifest), deletable set
    **strictly scoped to the pack grammar** (`packKeyRe` prefixes + `manifest/`), never
    `assets/`/`out/`/`inbox/`/roots/frontend-shell keys; the `gcm` low-water drain stays
    as the ErrUnsupported fallback. (b) `srr inspect --validate` reports orphaned
    pack-grammar objects no in-window manifest names (informational). (c)
    `cmd_frontend.go` prefers List over the `sitemap.txt` superset dance when supported
    (sitemap path kept for HTTP stores).
  - **Why:** the missing List is why the GC drains instead of listing (its own comment
    names this finding), why `sitemap.txt` exists, and why orphaned assets are
    permanently unfindable. Three of four backends list natively.
  - **Verify:** List conformance test over all four backends; GC list-mode unit test
    (orphan reclaimed, non-pack classes untouched); `make verify-be`.
  - **Risk / deps:** after S63 (same files; List's semantics follow the unified error
    contract). The deletable-set scoping is the safety-critical line — a List-driven
    sweep must never see `assets/` or mutable classes as garbage. S65 builds directly
    on the GC shape this lands.

- [x] **S65** — STO6: batch + parallelize GC deletes (`RmAll`)  ·  **P3 · S–M**  ·  from STO6 (BE-S6)
  - **Edit:** package helper `store.RmAll(ctx, be, keys, parallel)` — bounded-errgroup
    fan-out over `Rm`, with an optional per-backend override interface that S3
    implements via `DeleteObjects` (1000 keys/call, mapping per-key failures). Adopt in
    `GC`'s sweep (both the low-water drain and S64's list-and-delete), preserving
    "advance `gcm` only over generations actually cleared" on partial failure; adopt in
    `db_expire.go`'s delete phase (replacing its hand-rolled errgroup) and
    `cmd_frontend.go`'s orphan removal.
  - **Why:** the sweep issues one sequential round-trip per dead key — `gcMaxSweep=64`
    exists purely to bound that; `db_expire.go` already proved the fan-out pattern.
  - **Verify:** `make test-race-be`; GC partial-failure test (gcm unadvanced); S3 fake
    DeleteObjects test.
  - **Risk / deps:** after S64 (one GC rework, not two). Parallel Rm keeps per-key
    silent-on-missing semantics.

- [x] **S66** — STO3: memoize SFTP sessions; isolate the HTTP transport  ·  **P3 · M**  ·  from STO3 (BE-S3)
  - **Edit:** `sftp.go` — memoize dialed sessions like `s3Clients` (`s3.go:54-98`
    precedent), keyed on (config, addr, user), liveness-probed on lookup, with `Close`
    becoming a ref-release that never tears down the shared session (today `newSFTP`
    pays TCP + SSH handshake + subsystem on EVERY `store.Open`, i.e. per serve API
    request). `http.go` — give the backend its own cloned per-config transport instead
    of the shared `http.DefaultTransport`, so `Close()`'s `CloseIdleConnections()`
    (`http.go:264-267`) stops flushing keep-alives for every DefaultTransport user in
    the process.
  - **Why:** per-request SSH handshakes and a process-wide connection flush are both
    accidental; the S3 backend already shows the intended shape.
  - **Verify:** sftp test counting dials across two Opens; HTTP transport-isolation
    test; `make verify-be`.
  - **Risk / deps:** session sharing across concurrent serve scopes (pkg sftp client is
    concurrent-safe); dead-session invalidation pairs with S67's redial — land S66
    first. P3 because prod is S3/R2.

- [ ] **S67** — STO4: `withRetry` on transient store errors; SFTP redial  ·  **P3 · M**  ·  from STO4 (BE-S4)
  - **Edit:** small `withRetry(ctx, op)` in `store/` — 2-3 attempts, jittered backoff,
    connection-class errors only (`net.Error` timeout, ECONNRESET, pre-response EOF,
    `sftp.ErrSSHFxConnectionLost`); **never** exclusive-create Put (a retried lock
    create sees its own `os.ErrExist` and self-deadlocks), never `ErrPreconditionFailed`,
    never `fs.ErrNotExist`. Wrap Get/Stat/Rm/AtomicPut/overwrite-Put (and S64's List) on
    SFTP and HTTP; S3 keeps the SDK retryer, local needs none. SFTP: a connection-class
    failure invalidates the S66 memo entry and redials once.
  - **Why:** one mid-cycle TCP reset currently fails every subsequent SFTP op;
    expiration is all-or-nothing so one flaky Stat aborts the whole retention pass.
  - **Verify:** fail-then-succeed fake backend tests incl. the exclusive-create
    exclusion; SFTP redial test; `make test-race-be`.
  - **Risk / deps:** last in the track — wraps the final shape (S63 sentinels, S66
    memo). All wrapped ops are idempotent by construction.

### backend writer (Track B — parallel with everything)

- [x] **S68** — GRO6: adopt meta-sync progress per saved shard  ·  **P3 · S**  ·  from GRO6 (BE-G6)
  - **Edit:** `db_meta.go SyncMeta` — on a mid-sync failure after ≥1 newly finalized
    shard saved, adopt the staged `names` clone and its coverage for the shards that DID
    save (`c.Names = names`, `c.MetaTail = 0`) before returning the error, so the
    cycle's warn-only Commit publishes partial progress and the next sync resumes at
    `mp'·5000` instead of re-paying the full-store walk + zopfli. Safe by construction:
    `names.putAt` runs strictly AFTER `saveMetaShard` succeeds, so the staged clone
    only ever names durable objects (M4). **Preserve the merged staging invariant**: a
    failure with ZERO new shards saved leaves `c.Names` untouched — never adopt a bare
    truncation (the exact hazard the `fix/manifest-review-findings` staging fix closed).
    `SSum` may lag (`covers ≤ mp`) — legal, readers fall back to eager loading.
  - **Why:** the rebuild paths (pre-meta first run, coverage-inconsistency self-heal,
    failed-sync catch-up) are all-or-nothing; a transient error at shard 190/200
    discards everything, and a flaky store can make the rebuild never complete.
  - **Verify:** new unit test — backend failing at shard k of n (`metaTPutFailBackend`
    precedent), next SyncMeta resumes from k, and a zero-progress rebuild failure leaves
    coverage untouched; `make test-be`.
  - **Risk / deps:** none — db_meta.go only, independent of every other step.

- [x] **S69** — GRO7: chunk oversized batches through materialization  ·  **P3 · M**  ·  from GRO7 (BE-G7)
  - **Edit:** `db_pack.go PutArticles` — when the batch's encoded bytes exceed a cap
    (new flag, e.g. `--max-batch-bytes`, default ~32 MiB, 0 = off), split the articles
    into sub-batches and drive each through the existing accounting + `shouldConsolidate`
    → `emitDelta`/`consolidateTail` decision sequentially, building `lines` (the JSONL
    copy) **per sub-batch** so peak transient memory is bounded by the cap instead of
    the batch (today: `written`+`lines` dual copy at :497-512, the full in-memory delta
    gzip at :594-610, and the `entries`/`entryLines` chain copies at :734-737). Return
    the concatenated `written` slice (SyncMeta's input, unchanged). SyncMeta's
    exact-cover fast paths may miss on a multi-chunk cycle and fall back to
    `walkArticles` — correct, and only on the rare oversized backfill; document that at
    the split site.
  - **Why:** steady-state packs are bounded but the batch is not — a backfill import
    yields ~3-4× the batch in transient RSS, under the lock, on an 8 GB SBC.
  - **Verify:** new chunked-vs-unchunked byte-equivalence test (the
    `TestConsolidationEquivalence` pattern — chunking must be byte-invisible in the
    store); `make test-be` + `make test-race-be`.
  - **Risk / deps:** none on other steps (db_pack.go only). Zero format impact by
    construction; the equivalence test is the gate.

### assets (Track C)

- [x] **S70** — STO5: stream assets from disk; sniffed ContentType fallback  ·  **P2 · M**  ·  from STO5 (BE-S5)
  - **Edit:** `assets.go` — hash via `io.Copy(sha256.New(), f)` instead of
    `os.ReadFile` (:218); upload from the seekable `*os.File` (re-`Seek(0)` after
    hashing — S3 signing/retries keep working), keeping bytes in memory only below a
    small threshold (~1 MiB); in `{output}` mode upload from the staging file (size
    guard via `os.Stat`) instead of `readProcOutput`'s slurp (:547). The singleflight
    body's `orig []byte` parameter becomes path+size+sum. ContentType: when NO peek is
    configured and meta is empty, fall back to `http.DetectContentType` on the first
    512 bytes — **a deliberate convention change** for the zero-config case only
    (S3 objects currently default to `application/octet-stream`); update the "never by
    sniffing" comments (`store/main.go` contentTypeForKey, `s3.go` put,
    `backend/CLAUDE.md`) in the same edit so the docs and code can't disagree.
    Peek-configured installs are unchanged — peek stays the single source of truth.
  - **Why:** peak heap ≈ `SRR_ASSET_WORKERS × (orig + payload)` for stream-shaped work —
    video-heavy Telegram feeds spike hundreds of MB of transient heap on the 8 GB
    hosts; zero-config installs serve every asset as `octet-stream`.
  - **Verify:** existing asset tests + new streaming/threshold + DetectContentType
    tests; `make test-be`.
  - **Risk / deps:** after S63 lands (it rewrites the Stat/Get probe in the same
    function). The corrupt-media guard and peek paths already take the file path —
    unaffected.

### frontend reader (Track D — one step per batch, parallel with the backend)

- [x] **S71** — RDR3: "N new" pill + pending-pill pulse  ·  **P2 · M**  ·  from RDR3 (FE-M3)
  - **Edit:** list surface — a tappable "N new" pill overlaid at the list top, shown
    when `onStoreGrown` (`list.ts:954`, called silently from `app.ts:1555`) prepends
    rows above the fold while the user is scrolled down (the scroll-pinned prepend
    already computes the inserted-above count); tap = smooth scroll-to-top + dismiss;
    auto-dismiss when the user reaches the top organically. Reader surface — a subtle
    one-shot pulse on the pending/next pill when its count grows (the silent re-derive
    around `app.ts:834-913`). The pill is an overlay signal, never a layout shift —
    the documented no-jank scroll-pinning contract stays intact. No persistence.
  - **Why:** fresh arrivals are undiscoverable without scrolling up on a hunch —
    silence is the documented contract, but it lacks any signal.
  - **Verify:** `make verify` + `make test-browser`; visual check of the pulse via the
    design harness (`make design-shots`) or on-device.
  - **Risk / deps:** list.ts + app.ts + styles.css; counting stays in nav.ts's
    `tallyWith` — the pill only consumes counts, never re-derives them. Complements
    the applied S62 badge (app-icon) without overlap. First app.ts step — S72 follows.

- [x] **S72** — RDR7: image lightbox / tap-to-zoom  ·  **P2 · M**  ·  from RDR7 (FE-F4)
  - **Edit:** minimal zero-dep overlay viewer for `.srr-content img`: a new small
    `lightbox.ts` (fixed overlay, centered image, backdrop dim, transform-based zoom
    toggle on desktop; close on tap/Esc, focus-trapped via the `dropdown.ts` dialog
    patterns), hooked by ONE delegated click listener on `el.content` next to the
    existing error capture (`app.ts:1636` — today the only content listener). An
    `<img>` wrapped in a content `<a href>` keeps its link behavior — the lightbox
    claims only bare images (the common case).
  - **Why:** content images are inert; desktop has no enlargement path at all.
  - **Verify:** `make verify` + `make test-browser` (click opens, Esc closes, focus
    returns); keyboard/a11y pass by hand (no automated axe yet — TST11 open).
  - **Risk / deps:** after S71 lands (same app.ts; batches are sequential so no race).
    Keep the viewer outside `nav.ts`/`fmt.ts` — pure UI module.

- [ ] **S73** — RDR11: pull-to-refresh on the list  ·  **P2 · M**  ·  from RDR11 (FE-F8)
  - **Edit:** `gestures.ts` gains an opt-in overscroll pull on the LIST surface: a
    one-finger downward drag starting at `scrollTop == 0`, past a threshold with a
    small progress affordance, calls `refresh.refreshNow()` (`refresh.ts:41` — exists,
    post-dates the "no refresh button" decision; a gesture honors that decision rather
    than reopening it). Compose with the existing state machine (must not fire the
    horizontal swipe, the two-finger cycle, or fight the pinch guard) and set
    `overscroll-behavior-y: contain` on the list so Chrome Android's native
    pull-to-reload doesn't double-fire.
  - **Why:** the only manual refresh today is a full page reload.
  - **Verify:** `make verify` + `make test-browser` where expressible; **on-device
    check mandatory** — headless cannot reproduce touch/overscroll.
  - **Risk / deps:** gestures.ts + list.ts + styles.css; land BEFORE S74 (both grow
    the same single-finger tracking).

- [ ] **S74** — RDR14: list-row swipe actions  ·  **P3 · M**  ·  from RDR14 (IM-I13)
  - **Edit:** one-finger horizontal swipe ON A LIST ROW — right = toggle ★ save,
    left = toggle read — extending `gestures.ts`'s single-finger tracking with the
    surface awareness the two-finger cycle already has (reader keeps horizontal
    prev/next nav untouched); row visual affordance (translate + icon reveal) in
    list.ts/styles.css. The read-toggle rides the applied S57 undo machinery
    (`nav.pendingFrontierUndo`) so an accidental swipe is reversible, matching RDR1's
    snackbar contract.
  - **Why:** the standard mobile reader idiom; the star and frontier menu cover the
    functionality today, but less ergonomically.
  - **Verify:** `make verify` + `make test-browser`; on-device check mandatory (swipe
    thresholds/feel).
  - **Risk / deps:** after S73 (same touch state machine). Horizontal row swipe must
    not swallow vertical list scrolling — axis-lock like the existing swipe handler.

## Stale / unverified — needs re-check (NOT auto-applied)

*(none — all 12 findings re-verified ACTIONABLE against `3601ba8`)*

## Skipped

- **STO2's `db_meta.go:290` consequence** ("treats a transient Stat error as absence") —
  OBSOLETE: that path was rewritten at the manifest cutover; the meta series no longer
  Stats. The nearest surviving relative (`config_sidecar.go:146`) fails SAFE (a
  transient error merely forces a harmless config rewrite). The finding's other
  consequences remain and are covered by S63.

## Coverage detail

- FINDINGS-2026-07-20 (user-selected subset: GRO6, GRO7, STO1–STO6, RDR3, RDR7, RDR11,
  RDR14) — this plan covers only those 12 entries. STO7 (`HTTP.AtomicPut` atomicity)
  was NOT selected and stays in the findings doc; its temp-name+MOVE idea composes with
  S64's List if picked up later. The remaining RDR entries (RDR5, RDR6, RDR8–RDR10,
  RDR13, RDR15–RDR18) stay open in the findings doc.
- Reminder: S45–S62 are applied but **not released/deployed** — releasing this batch
  ships them too.
