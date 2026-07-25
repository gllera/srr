# Findings Apply Plan

**Sources:** 1 — `docs/FINDINGS-2026-07-20.md`, its **Do first** list (2026-07-25 revision)
·  **Net actionable:** 18 step(s), S45–S62 (19 findings; POL1–POL4 share one step)
**Coverage:** PARTIAL by design — user-directed selection of the six Do-first rows:
**TST1, TST4, FMT2(a), FEB1–FEB4 + RDR4 + POL1–POL5, RDR1 + RDR2, REL3, PWA1 + PWA2 +
RDR12**. Every other open finding remains in `docs/FINDINGS-2026-07-20.md`. The prior
batch S30–S44 (manifest cutover, multi-store, admin console, MCP) is fully applied,
released (v4.8.0/v4.8.1) and deployed; it was dropped when this plan was regenerated,
and numbering continues at S45 so plain-text references to S1–S44 elsewhere stay
unambiguous.

> Regenerable plan; the findings doc is the living backlog (planned entries are removed
> from it — user rule 2026-07-20). Apply with `/apply-findings --apply` (or `--apply -i`).
>
> All 19 findings were re-verified against HEAD (`c51bd9a`) on 2026-07-25: **all
> ACTIONABLE**. Ground-truth shifts folded into the steps: the reader render site (now
> also hosting the §9.3 tombstone) is the same `replaceChildren` block FEB2/RDR4 must
> edit (`app.ts:416-423`); app.ts already has a `controllerchange` listener (mounts
> re-post) that S61's toast must EXTEND, not race; pins are per-mount since S38, so
> S59/S60 key the pinned-asset work by store.

## Sequencing at a glance

Two independent tracks; steps inside each are ordered.

**Backend track:** S45 (crash harness) → S46 (fuzzers) — the safety net — then S47
(lease lock) → S48 (CAS root flip), the write-path change the net exists for. S50
(sanitizer `id`) lands with/after its reader half S49.

**Frontend track:** S49 (fragment anchors + `id` tolerance — reader-first) ⇢ pairs with
S50; S51–S56 are the reading-surface batch (natural single PR together with S49/S50);
S57 → S58 (undo machinery, then its second consumer); S59 → S60 (saved-asset pinning,
then `persist()`); S61 and S62 fit anywhere.

**Couplings:** S49 lands WITH or BEFORE S50 (reader-first: the reader must tolerate
`id`-bearing content before the writer bakes it into immutable packs). S58 needs S57's
snapshot machinery. S60's `persist()` call sites include S59's new pin path. Nothing
here touches the idx/data/meta wire format; S49+S50 touch **sanitizer parity** → full
`make verify` plus the sanitizer-parity review lens on the pair.

## Apply order

### backend — tests first (the safety net)

- [x] **S45** — TST1: mechanize the stop-anytime crash audit  ·  **P1 · M**  ·  from TST1 (BE-V1)
  - **Edit:** new `backend/crash_test.go`: a `stopAfterN{k}` Backend wrapper erroring
    every mutation past the k-th (embed-and-override like `metaTPutFailBackend`/
    `statFailBackend`/`gateBackend`); loop k = 1..K over a scripted multi-batch fetch
    (delta cycles + a consolidation + an expiration + a GC); after each halt: reopen,
    `validateAll` + delta-chain check, re-run to convergence, assert zero article loss
    and chron permanence (M8). ~150 lines on `setupTestDB`.
  - **Why:** the commit protocol spans ≥5 ordered store mutations per dirty cycle and was
    just rewritten (S31–S35) with only hand-run crash audits; every new write silently
    adds crash points nobody hand-writes a test for.
  - **Verify:** `make test-be` (the new test runs inside it).
  - **Risk / deps:** none — pure test add. Land FIRST: it guards S47/S48.

- [x] **S46** — TST4: fuzz the untrusted parsers + sanitizer  ·  **P2 · S each**  ·  from TST4 (BE-V2 + IM-I23 + AR-T1)
  - **Edit:** `FuzzParseFeed` (never panics; invariants hold), `FuzzParseIdxPack`,
    `FuzzParseSeen`, a sanitizer target, and round-trip `FuzzIdxWriteParse`; seed the
    corpus from the existing corruption tests (`idx_read_test.go:149-165`,
    `seen_test.go:287`) and check it in; add `make fuzz-be` (short `-fuzztime` smoke) +
    a nightly scheduled CI job.
  - **Why:** zero fuzz targets guard a store that must never corrupt; `ParseFeed` chews
    hostile network bytes every 5 minutes in prod.
  - **Verify:** `make fuzz-be` smoke locally + `make verify-be`.
  - **Risk / deps:** none; independent of S45.

### backend — REL3, kill the SIGKILL wedge (db.go, store/)

- [x] **S47** — REL3(a): lease lock — owner, expiry, steal  ·  **P1 · M**  ·  from REL3 (AR-R3 + BE-A3)
  - **Edit:** `.locked` (`db.go:23`, `storeWriter` `db.go:421-447`) gains a JSON payload
    `{owner, expires}`: written on acquire, renewed each cycle, and **stealable** once
    `expires` has passed (steal logged loudly). Keep `--force`, the
    `context.WithoutCancel` release, and the `os.ErrExist` → 409 semantics for live
    contention. Same treatment for `.config.locked` (shared helper).
  - **Why:** SIGKILL leaves the marker behind and wedges the 5-min loop until a human
    passes `--force` — the known v4.6.0 residual, unchanged by the cutover.
  - **Verify:** new unit tests (stale-lease steal, live-lease refusal, renew path) +
    `make verify-be`.
  - **Risk / deps:** after S45 (harness in place — this is write-path work). The payload
    is additive: an old binary reading a lease file still sees "exists" (safe).

- [x] **S48** — REL3(b): conditional write (CAS) on the root flip  ·  **P1 · M**  ·  from REL3
  - **Edit:** add conditional-write support to `Backend` (`store/main.go:154-171`) —
    a `PutIf(ctx, key, r, precondition)` (or an `AtomicPut` precondition option):
    S3/R2 = `If-Match`/`If-None-Match` on PUT, local = `O_EXCL`/rename dance, SFTP =
    rename dance, HTTP = `ErrUnsupported` → callers fall back to today's behavior.
    `Commit` CASes db.gz against the `m` it loaded; a lost race re-reads and retries
    cleanly instead of last-write-wins.
  - **Why:** correctness today is only advisory; the ~60-byte manifest root pointer is
    the one object where a blind overwrite can silently drop a competing writer's
    generation. The lock becomes an optimization; races become clean retries.
  - **Verify:** backend-conformance test additions across all 4 backends + full
    `make verify` (commit path touched).
  - **Risk / deps:** after S47. The interface change ripples through 4 backends + test
    fakes — mechanical but wide; run the backend-conformance-checker lens.

### FEB1 — footnote round-trips, both sides (fmt.ts ⇢ mod/sanitize.go)

- [x] **S49** — FEB1(reader): in-page fragment anchors; tolerate `id`  ·  **P1 · M**  ·  from FEB1 (FE-B1)
  - **Edit:** `fmt.ts` anchor branch (~`:166-180`): a bare-`#` href stays a fragment —
    exempt it from `setPackRelative`, set `target="_self"` (overriding
    `<base target="_blank">`), and let it resolve in-page; keep a validated `id`
    attribute through the reader-side sanitize walk (mirror S50's pattern) instead of
    stripping it.
  - **Why:** every longform/academic/newsletter article with footnotes has broken
    round-trips: `#frag` gets pack-base-resolved and opens a dead new tab.
  - **Verify:** fmt unit tests (fragment href survives + navigates in-page; `id` kept) +
    full `make verify` (sanitizer parity is a contract boundary).
  - **Risk / deps:** land WITH or BEFORE S50 (reader-first). Sanitizer-parity review on
    the S49+S50 pair.

- [x] **S50** — FEB1(writer): allowlist a validated `id`  ·  **P1 · M**  ·  from FEB1
  - **Edit:** `backend/mod/sanitize.go`: `policy.AllowAttrs("id").Matching(<conservative
    token regexp>).Globally()` — reject exotic values; follow the file's existing
    Matching-regexp style (:36-45).
  - **Why:** the backend strips footnote targets at write time — the writer half of the
    round-trip. Only helps articles fetched after it ships (packs are immutable).
  - **Verify:** sanitize unit table + full `make verify`.
  - **Risk / deps:** with/after S49. Content `id`s can't collide with reader chrome —
    they live scoped inside `.srr-content`.

### frontend/src/js/app.ts — the reader render block

- [x] **S51** — FEB2: playing media survives prev/next  ·  **P1 · M**  ·  from FEB2 (FE-B2)
  - **Edit:** around `el.content.replaceChildren` (`app.ts:416-423`): before replacing,
    harvest `currentTime`/`playbackRate`/paused of any `<audio>/<video>` in the outgoing
    content, keyed by chronIdx in a session Map; after rendering a chron with saved
    state, restore it onto the matching element. Minimum viable: resume on returning to
    the article; the full mini-player is RDR16 (stays in the findings doc).
  - **Why:** backend `#enclosure` injects podcast `<audio controls>`, so the path is
    live: a swipe kills a playing podcast dead with no resume.
  - **Verify:** unit where practical + manual repro (play → next → prev → position
    restored); `make verify-fe`.
  - **Risk / deps:** same block as S52 — apply S51 first, S52 adjacent.

- [x] **S52** — RDR4: consume `g` — lang, dir, hyphens  ·  **P1 · S**  ·  from RDR4 (AR-D4 + IM-I04 + FE-F1 + FE-D2)
  - **Edit:** at the same render site: stamp `el.content.lang = article.g || ""` and
    `dir="auto"` on the content host; enable `hyphens: auto` on `.srr-content` prose in
    `styles.css` (only correct once lang is stamped — same change set).
  - **Why:** `g` ships in every pack line and no frontend code reads it (`<html
    lang="en">` hardcoded): wrong screen-reader voice for non-English bodies, wrong
    hyphenation, undeclared-RTL renders LTR.
  - **Verify:** contract-layer or unit assertion (a `g`-bearing fixture renders with
    `lang`) + `make verify-fe`.
  - **Risk / deps:** after S51 (same block). `g` is absent for pre-2026-07-19 articles →
    empty lang falls back to the page default, which is correct.

### frontend/src/js/fmt.ts — content mechanics

- [x] **S53** — FEB3: broken image keeps its alt text  ·  **P2 · S**  ·  from FEB3 (FE-B3)
  - **Edit:** `collapseBrokenMedia` (`fmt.ts:235-244`): for an IMG with non-empty `alt`,
    swap in a small caption placeholder (`.srr-broken-alt`, styled in styles.css)
    instead of the bare display:none collapse; alt-less media keep today's collapse
    (deliberate).
  - **Verify:** fmt unit test + `make verify-fe`.
  - **Risk / deps:** none.

- [x] **S54** — FEB4: force controls on non-autoplay video  ·  **P2 · S**  ·  from FEB4 (FE-B4)
  - **Edit:** fmt.ts VIDEO branch (`:194-199`): when not `autoplay`, set `controls` +
    `playsinline` — the exact treatment the AUDIO branch already applies (`:200-207`).
  - **Why:** a feed video lacking `controls` renders as a dead frame.
  - **Verify:** fmt unit test + `make verify-fe`.
  - **Risk / deps:** none.

- [x] **S55** — POL5: demote in-content `h1`s  ·  **P3 · S**  ·  from POL5 (FE-D6)
  - **Edit:** in `sanitizeFragment`'s element walk: rewrite content `h1` → `h2` so the
    masthead `<h1 class="srr-title">` stays the only h1 for AT outlines; visual scale is
    already handled by CSS.
  - **Verify:** fmt unit test + `make verify-fe`.
  - **Risk / deps:** same file as S49/S53/S54 — apply bottom-up within fmt.ts.

### frontend/src/styles.css — content polish batch (one PR with S51–S55)

- [x] **S56** — POL1–POL4: `dl` styles, img height clamp, dark dimming, light print
  ·  **P2–P3 · S**  ·  from POL1 (FE-D1) + POL2 (FE-D3) + POL3 (FE-D4) + POL4 (FE-D5)
  - **Edit:** (1) `dl/dt/dd` spacing/rhythm rules in the `.srr-content` block to match
    `ul/ol`; (2) `.srr-content img { max-height: 85vh }` — parity with the video clamp
    (`styles.css:66-72`); (3) `@media (prefers-color-scheme: dark) { .srr-content img {
    filter: brightness(.85) } }`; (4) force the light token set inside `@media print`
    (`styles.css:2159-2175` currently only hides chrome).
  - **Verify:** `make design-shots` eyeball + `make verify-fe`.
  - **Risk / deps:** none; pure CSS.

### frontend/src/js/nav.ts (+ app.ts) — read-state trust

- [x] **S57** — RDR1: undo snackbar on large frontier jumps  ·  **P1 · M**  ·  from RDR1 (FE-M1)
  - **Edit:** `recordSeen` (`nav.ts:854`): before a raise that flips more than a
    threshold of articles across the filter's members, snapshot the touched frontier
    keys (+ their `st` timestamps); expose `nav.undoLastFrontierMove()`; app.ts shows a
    transient "Marked N read — Undo" snackbar (reuse `.srr-popup`) whose tap restores
    the snapshot and recounts. Keep the frontier model itself — this adds
    reversibility, not per-article sets.
  - **Why:** tapping the newest headline on `[ALL]` silently consumes entire backlogs;
    deliberate model, but silent + irreversible is what erodes trust in unread numbers.
  - **Verify:** nav unit tests (snapshot/restore round-trip against the counting
    oracle) + `make verify-fe`. **Do not touch `tallyWith`'s logic** (Appendix C).
  - **Risk / deps:** restore must write through the same setters the seen-sync uses, so
    profile-blob sync (`st` per-key timestamps) sees the undo.

- [x] **S58** — RDR2: "Mark all read" rides the same undo  ·  **P1 · S**  ·  from RDR2 (FE-M2)
  - **Edit:** `markAllRead` (`nav.ts:936`, called from `app.ts:629,655`) snapshots via
    S57's machinery and triggers the same snackbar; no separate confirm dialog.
  - **Verify:** unit + `make verify-fe`.
  - **Risk / deps:** after S57.

### frontend pin path — saved-article durability (pin.ts, sw.ts, nav.ts)

- [x] **S59** — FMT2(a): save-time asset pinning  ·  **P1 · S–M**  ·  from FMT2 (AR-D2 + IM-I11)
  - **Edit:** on ★-save: collect the article's pack-relative `assets/…` URLs from its
    content and post them to the service worker's pinned bucket (extend the `pin.ts` /
    `srr-pinned-v1` message protocol with an asset-pin type, keyed by mount per the
    post-S38 multi-store model); on un-save, release them. Hook the saved-set
    transitions in nav.ts.
  - **Why:** a ★-saved article keeps its text forever (immutable packs) but silently
    loses images/media once the feed's `exp` window passes; the backend cannot exempt
    them (the saved set is device-local). With PWA0 fixed, the pinned bucket finally
    works in production — this makes the read-later queue actually durable. No contract
    change.
  - **Verify:** `make verify-fe` + `make test-browser` (SW behavior is browser-layer).
  - **Risk / deps:** S60 hooks its `persist()` call into this path — land S59 first.

- [x] **S60** — PWA2: request storage persistence on first pin  ·  **P1 · S**  ·  from PWA2 (FE-P2)
  - **Edit:** call `navigator.storage?.persist()` (fire-and-forget, log the result) the
    first time either pin path is used — filter pin (`pin.ts`) or S59's save-pin.
  - **Why:** pinned packs are eviction-exempt only inside the SW's own logic; the
    browser can still evict the whole origin under pressure. One call protects the
    entire offline-pin feature.
  - **Verify:** unit-mockable + manual check in the installed PWA; `make verify-fe`.
  - **Risk / deps:** after S59 (its call sites include the new path).

### PWA earn-out (app.ts, sw.ts, manifest.webmanifest)

- [x] **S61** — PWA1: update toast + navigation preload  ·  **P1 · S**  ·  from PWA1 (AR-U2 + FE-P1)
  - **Edit:** EXTEND the existing `controllerchange` listener (app.ts ~`:1144` — it
    re-posts mounts today; keep that first) to also show a lightweight "Reader updated —
    reload" toast (`.srr-popup`), suppressed on first install; enable
    `registration.navigationPreload` in sw.ts's activate (`skipWaiting`/`claim` stay).
  - **Why:** a new worker takes over mid-session with zero signal — fine until a
    pack-grammar change isn't; preload speeds cold-SW first paint.
  - **Verify:** `make test-browser` + `make verify-fe`.
  - **Risk / deps:** do NOT add a second `controllerchange` listener — extend the
    existing one.

- [x] **S62** — RDR12: unread badge + manifest shortcuts  ·  **P2 · S**  ·  from RDR12 (IM-I09 + FE-F9)
  - **Edit:** `navigator.setAppBadge(unreadTotal)` (feature-detected, cleared at zero)
    wherever unread tallies refresh (the 5-min refresh + seen changes), a `(N)`
    document-title suffix, and `shortcuts` entries for ★ Saved and Unread in
    `frontend/src/manifest.webmanifest` (hash URLs).
  - **Why:** the tally already exists (`nav.unreadCounts`); best effort-to-value on the
    feature list and the cheap 80% of Web Push (RDR17, stays in the findings doc).
  - **Verify:** `make verify-fe` + manual badge check in the installed PWA.
  - **Risk / deps:** none.

## Applied — 2026-07-25

All 18 steps (S45–S62) are applied. Gates run green after the batch: `make verify`,
`make test-browser`, `make test-race-be`, and a `make fuzz-be` smoke over all five new
targets.

Notes worth carrying (the plan's own text is the record of intent; these are what the
work actually turned up):

- **S45 found the wedge S47 fixes, immediately.** The crash harness's first full run
  failed on all 53 halt points with one error: a halted cycle leaves `.locked`/
  `.config.locked` behind and the next cycle cannot open the store. That IS REL3, and
  the harness stays as its regression net (it asserts the store is writable again after
  every halt, not merely readable).
- **S45's grace window is the production one.** `main()` floors `--keep-manifests` at
  the compile-time `keepManifests`, explicitly so `srr inspect`'s fixed-K window cannot
  false-alarm — so the harness warms the store past that window instead of shrinking K,
  and snapshots the warm state once rather than replaying it per halt.
- **S47 changed what "another writer" means in two tests.** `TestDBLocking` and
  `TestMCPFetchStoreBusy` faked cross-process contention with a second locked handle in
  the SAME process; the owner rule now (correctly) reclaims that. Both were rewritten to
  plant a foreign live lease, which is what a real peer writes.
- **S48 is a REAL CAS only on S3/R2** (ETag + `If-Match`) — which is where the
  production store lives. Local/SFTP are documented best-effort check-then-rename; plain
  HTTP declines with `errors.ErrUnsupported` rather than pretend, and `flipRoot` falls
  back to the unconditional write on that signal.
- **S49 needed a click interceptor, not just an href fix.** `location.hash` is the
  reader's router, so letting a footnote link navigate would fire a hashchange `route()`
  reads as a nonsense position. `fmt.handleFragmentClick` scrolls instead, and the URL
  never moves.
- **S51 needed a pending-restore guard.** `currentTime` is only settable once metadata
  lands, so a second render of the same article before then harvested the still-zero
  position over the real one.
- **S57's snackbar is a new non-modal element, not `.srr-popup`.** The popup is a modal
  that takes focus — right for an error you must acknowledge, wrong for a notice you may
  ignore, and a single slot both would fight over. S61's update toast reuses the same
  snackbar.
- **S57 does NOT restore the snapshotted `st` stamps.** An undo is itself the newest
  thing to happen to those keys; restoring old stamps would let another device's stale
  raise win the per-key LWW and silently re-consume the backlog.
- **S62's title count LEADS rather than trails** (`(7) SRR · …`): a tab title truncates
  from the right, so a trailing number is a notification nobody can see.

## Stale / unverified — needs re-check (NOT auto-applied)

None — all 19 findings re-verified ACTIONABLE against `c51bd9a` on 2026-07-25.

## Skipped

None. (FMT2's backend half **(b)** — the refcount sidecar — was NOT selected; it stays
in the findings doc as the remaining FMT2 entry.)

## Coverage detail

- Source: `docs/FINDINGS-2026-07-20.md`, **Do first** section only (user-directed).
  The findings doc remains the living backlog for everything else; this plan is NOT
  exhaustive of it.
- Re-verification evidence (2026-07-25, HEAD `c51bd9a`): `sanitize.go` has no `id`
  allowlist; no fuzz targets or crash harness exist (`func Fuzz`/`stopAfterN`
  grep-empty); `.locked` is a nil-payload marker and `Backend` has no conditional put;
  `fmt.ts` pack-base-resolves bare fragments, forces controls on audio but not video,
  and hides alt text on collapse; `app.ts:416-423` `replaceChildren`s with no
  media-state carry-over and no lang stamping (`<html lang="en">` hardcoded);
  `nav.ts` `recordSeen`/`markAllRead` have no snapshot/undo; `pin.ts` has no
  saved-asset or `persist()` path; `sw.ts` has `skipWaiting`+`claim`, no
  `navigationPreload`; `manifest.webmanifest` has no `shortcuts` and `setAppBadge` is
  unused; `styles.css` lacks `dl` rules, an img height clamp, dark image dimming, and a
  light-print override.
