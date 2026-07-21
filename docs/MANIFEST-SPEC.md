# Generation Manifests — Specification

**Status:** DESIGN (2026-07-21). Not implemented. This document is the sign-off
gate for plan steps S32–S35; nothing below is in the tree yet.
**Scope:** the store's commit model. Root object `db.gz`, a new immutable
`manifest/` series, a backend-only config sidecar, explicit pack naming, GC by
unreachability, and the reader/service-worker indirection that follows.
Touches `backend/db.go`, `db_pack.go`, `db_meta.go`, `db_out.go`, `seen.go`,
`inbox.go`, `cmd_fetch.go`, `cmd_gen.go`, `idx_read.go`, `store/main.go`,
`cmd_gents.go`, `frontend/src/js/data.ts`, `frontend/src/sw.ts`.
**Companion reading:** `docs/DELTA-TAIL-SPEC.md` (the register this document
matches, and the model it generalizes), `docs/INBOX-SPEC.md`,
`docs/STORE-VISIBILITY.md`, `docs/STATIC-ENGINE-DECISION.md`, root `CLAUDE.md`
→ Data Contract.

---

## 1. Problem

Every feature added since 2026-06 has paid the same tax twice.

**Tax 1 — a db.gz field plus a bespoke ordering proof.** `SyncIdxSummary`,
`SyncMeta`, `SyncSeen`, `SyncOutFeeds`, `emitDelta`, `consolidateTail`,
`drainInbox` and `SnapshotDB` each carry their own paragraph arguing why writing
object X before publishing pointer Y through `Commit` is crash-safe. They are
eight instances of one argument, each independently reviewed, each independently
breakable. `DBCore` now carries ~14 pointer/coverage integers (`seq`, `sf`,
`next_pid`, `pack_off`, `gen`, `hdrs`, `mp`, `mt`, `nd`, `na`, `dby`, `gcs`,
`hb`, plus `inbox`) whose only job is to let a reader *derive* the names of
objects the writer already knows.

**Tax 2 — db.gz is one object doing four jobs.** It is (a) the reader's whole
boot state, (b) the operator's processing configuration, (c) writer-private
bookkeeping, and (d) the sole mutable commit root. Consequences: a `recipe set`
rewrites the object every reader re-downloads and 409s against a running fetch
cycle; the object can never be edge-cached, so the ~10.6 KB body is re-fetched
by every open tab every five minutes; and the configuration leak documented in
`docs/STORE-VISIBILITY.md` exists purely because config rides the one object
readers must fetch.

**Tax 3 — names are derived from counts, so a rebuild reuses them.** Finalized
pack names come out of `total_art` arithmetic. An in-place rebuild therefore
writes new bytes under old names, which is why `gen`/`srr gen --bump` exist,
why the service worker has a purge-on-gen-change path, why `BumpGen` logs a
"purge the CDN now" WARN it cannot enforce, and why `asset heal` logs another.
It is also why physically dropping expired articles is currently forbidden: a
renumbering rebuild strands every `add_idx`/`xp` and every device-local
chronIdx.

## 2. Design in one paragraph

Every `Commit` writes one **immutable manifest** — `manifest/<m>.gz`, `m` a
store-wide monotone counter of its own — that names, explicitly, every live
object of every series plus all reader-visible state. The root `db.gz` keeps
its name and its `no-cache` treatment but shrinks to a ~60-byte pointer
`{v:2, m:<m>, t:<fetched_at>}`. Operator configuration (recipes, pipes,
syndication slots, dedup/retention knobs) moves out to a **backend-only mutable
sidecar** `config.gz` that no reader ever fetches and that a running fetch cycle
never writes. Because manifests list names, names no longer come from counts:
each series draws opaque monotone stems from a never-reused counter, so a
rebuild or a compaction writes *new* names beside the old ones and flips the
root, which retires `gen`, `gen --bump`, both purge WARNs and the SW's
purge-on-gen-change. GC becomes one rule — delete what the last K manifests do
not name. And the eight per-feature ordering proofs collapse into one sentence
(§6.1): a cycle writes only new immutable objects, then one immutable manifest
naming them, then flips the root; a crash anywhere before the flip leaves
unreferenced garbage, never corruption.

```
                 db.gz  {v:2, m:1743, t:…}          mutable, no-cache, ~60 B
                   │
                   ▼
        manifest/1743.gz   immutable, edge-cacheable
        ├─ counters      total_art, na, mt, pack_off, …
        ├─ feeds{}       reader-facing fields only
        ├─ head/hb       newest-glance projection
        ├─ names         idx[…] data[…] meta[…] deltas[…] seen hsum ssum
        └─ writer state  dby, gcm, inbox{}
                   │
                   ▼ (named, never derived)
   idx/812.gz  data/3004.gz  meta/1190.gz  data/3007.gz  seen/441.gz  …
                                    all immutable, write-once, never reused

        config.gz        mutable, no-cache, BACKEND-ONLY (never reader-fetched)
        └─ recipes, out[], dd, per-feed {recipe, ingest, pipe, dd, dt}
```

## 3. Goals / non-goals

Goals:

- **G1** — One crash argument for the whole store, stated once, reused by every
  feature that ever adds an object.
- **G2** — The reader's hot poll costs ~60 bytes when nothing changed, and one
  immutable, edge-cacheable object when something did. Never more bytes than
  today on any path.
- **G3** — Operator configuration leaves the reader-hot object: config edits
  stop rewriting it, stop contending with a running fetch cycle, and stop being
  published to the world (`STORE-VISIBILITY.md`'s "future leak-shrinker").
- **G4** — Name reuse becomes structurally impossible, which makes rebuilds and
  physical compaction routine instead of forbidden, and makes cache-first
  serving unconditionally safe.
- **G5** — Preserve every invariant the project is built on: write-once names,
  a single mutable commit root, "no reader learns a name before the root
  publishes it", immutable finalized packs, **chronIdx as a permanent address**
  (§9), the SW's structural offline consistency.
- **G6** — Leave the ARC6 door open: nothing may assume that `idx/` and `meta/`
  are separate series, or that a series' stride is a particular number (§4.6).

Non-goals:

- Changing the idx/data/meta *formats*. Not one byte of a pack changes here.
  (§9 adds a tombstone *value*, not a format.)
- Replacing the advisory `.locked` with leases/CAS. That is REL3, an open
  finding; §6.2 specifies the flip both with and without it, and S32–S34 are
  implementable with today's lock.
- A store `List` operation. That is STO1; §7 specifies GC without it and notes
  what STO1 would simplify.
- Multi-store mounting (S36–S38) and the admin-into-reader work (S39–S40).

## 4. Object model

### 4.1 The root — `db.gz`

Keeps its key (readers, `<link rel=preload>`, the Cloudflare cache-bypass rule,
and every ops runbook point at it), its `no-cache, must-revalidate`
Cache-Control, and its `application/gzip` Content-Type and gzip framing (so the
reader's `DecompressionStream` path is untouched — gzipping 30 bytes is silly
and deliberate).

```json
{"v":2,"m":1743,"t":1753027200}
```

| Key | Type | Meaning |
|---|---|---|
| `v` | int | Format version. **2** after S34. An older reader sees `v > DB_FORMAT_VERSION` and takes the existing clean version-reject popup (`data.ts parseDb`). |
| `m` | int | The current manifest number. Names `manifest/<m>.gz`. Monotone, +1 per publishing Commit, never reused. |
| `t` | int | `fetched_at` of the last cycle. **Here, not only in the manifest**, so a cycle that changed nothing else (a fully backoff-thinned poll, a zero-feed maintenance cycle) rewrites 60 bytes and leaves `m` — and therefore every reader's cached manifest — untouched. The reader's "Updated X ago" line reads it with zero extra fetch. |

Nothing else. In particular **not** `total_art`, `seq`, or `gen`: any of them in
the root would be a second source of truth for something the manifest owns.

### 4.2 The manifest — `manifest/<m>.gz`

Immutable, write-once, `cacheImmutable`, `application/gzip`, gzip JSON. Its own
series row in `store.PackSeries` (§4.6). Published by every Commit that changes
anything a reader can see or that the writer must be able to recover.

Contents, grouped (full worked example in §12):

- **Counters** — `fetched_at`, `total_art`, `na`, `mt`, `pack_off`.
- **Feeds** — `feeds{}` keyed by id, reader-facing fields only (§5.2).
- **Projection** — `head[]`, `hb` (unchanged semantics; see §8.2 for why they
  stay here).
- **Names** — one entry per series plus the singletons (§4.5).
- **Writer state** — `dby`, `gcm`, `inbox{}` (§4.4).

A manifest is a complete, self-contained description of one store state. It is
therefore also the snapshot that `db/<g>.gz` exists to be today, which is why
that series is retired (§10.1).

### 4.3 The config sidecar — `config.gz`

Mutable, `no-cache, must-revalidate`, `application/gzip`, at the store root
next to `db.gz`. **Backend-only**: the frontend and the service worker never
fetch it, exactly like `seen.gz` today. Deliberately *not* in `PackSeries`.

```json
{"v":2,"recipes":{…},"out":[…],"dd":30,"feeds":{"42":{"recipe":"x","pipe":[…],"dd":7,"dt":true}}}
```

`config.gz` is not referenced by any manifest and is never read by a reader, so
it participates in no ordering argument with the manifest chain. Its entries are
keyed by feed id; an entry for a feed the manifest does not have is **inert and
ignored** (and swept at the next config write). That is what makes the two-object
mutations of §6.4 safe without a distributed commit.

**Absence is legal**: a store with no `config.gz` behaves exactly as one whose
config is all defaults (the `default` recipe seeded by `NewDB`, `dd` = 30, no
`out` entries). This is what makes the S32 dual-write and any rollback trivial.

### 4.4 Writer state rides the manifest — decided

`sf`, `dby`, `gcs`, `inbox` were the open question. The decision is that
writer-private state rides the **manifest**, not a third mutable object, and it
is not a matter of taste for two of them:

- `inbox` (the per-producer drained watermark) **must** be published by the same
  atomic act as the batch it describes. That is the entire crash argument of
  `docs/INBOX-SPEC.md` ("crash before → re-drain, crash after → skip"). A
  separate mutable object reintroduces the two-phase problem the inbox spec
  spent its design budget eliminating.
- `sf` (the seen ping/pong flag) has the same requirement — the batch and the
  pointer to its matching dedup state must become durable together. Under this
  design it does not move: it is **retired** (§10.2), because manifest-named
  `seen/<n>.gz` slots express the same guarantee with no flag at all.
- `dby` (delta-byte accumulator) and `gcs`→`gcm` (the GC low-water) are ~20
  bytes of per-generation fact. They ride along for uniformity: one object
  describes one store state, completely.

Cost: a manifest is public, so `inbox` leaks producer names and cycle ids, and
`gcm`/`dby` leak trivia. That is strictly less than the config leak this design
closes, and an operator who cares deploys private per `STORE-VISIBILITY.md`.

### 4.5 Names are listed, never derived — decided

Manifests list live objects **explicitly, by name, per series**. There is **no
computed-name fallback** — decided against, per the plan's recommendation:

- Two ways to learn a name means two truths that can disagree, and every
  disagreement is a 404 storm on live readers.
- The whole ARC3 win — a rebuild writing fresh names beside the old ones —
  exists only if nothing anywhere reconstructs the old name from a count.
- The existing `v`/`DB_FORMAT_VERSION` handshake already gives a clean break
  with a user-legible failure. Use it.

**Stems become opaque.** Every immutable object a generation writes draws its
stem from a per-series monotone counter that is never reused. `idx/812.gz` means
"idx-series object #812", nothing more; the manifest's ordered list says which
chron region it holds. A rebuild of the idx pack covering chrons [0, 50000)
writes `idx/1900.gz` and lists it at position 0; `idx/812.gz` stays reachable
through the grace window for every tab still holding an older manifest, then GC
takes it (§7). Kind letters (`L`, `d`, `h`, `s`) become unnecessary and are
dropped at cutover; the digit-run grammar (`<series>/<digits>.gz`) is unchanged,
so `packKeyRe`, `cacheControlForKey`, `contentTypeForKey` and the SW's
`parsePackName` keep working verbatim.

**Encoding.** A series' list is *positional*: entry `i` holds the region the
series' stride assigns to position `i`. Written naively that is one integer per
object (~3,000 data packs at 1M articles). Because stems are assigned in write
order, a pristine store's list is one contiguous run, so each list is
**run-length encoded** as `[[firstStem, count], …]` with an explicit base index:

```json
"data": {"b":1, "r":[[1,3004]]}          // positions 1..3004 → stems 1..3004
"idx":  {"b":0, "r":[[0,19],[1900,1]]}   // position 19 rebuilt, stem 1900
```

`b` is the positional index of the first run's first entry (0 for idx/meta, **1
for data** — the writer has always skipped `data/0`, and v2 does not renumber
existing idx footers, so that quirk is preserved rather than migrated). The
reader expands runs into an index→stem array at parse; 3,000 entries is
nothing. A pristine 1M-article store's three lists total ~120 bytes (§12); the
pathological fully-fragmented data list is ~8 KB gzipped, and a full rebuild
re-contiguates it.

**Singletons** get plain stems: `seen` (the dedup sidecar slot), `hsum` (the idx
header summary, with the finalized count it covers), `ssum` (the meta bloom
summary, likewise), and `deltas` (an ordered stem list of the live delta
segments, which is the data series' `d`-kind today).

Consequences, all of them deletions:

- `seq`, `nd`, `tailGen`, `next_pid`, `hdrs`, `mp`, `gen` all lose their reason
  to exist. The tail idx pack is simply the last entry of the idx list; the
  delta chain is the `deltas` list; the header summary is `hsum` or absent.
- The idx footer's stored `packId` keeps its exact meaning and bytes — it is
  the **positional index** into the data list, which is what it always was.
- `numFinalizedIdx`/`numFinalizedMeta` survive only as *chron → position*
  arithmetic (`floor(chron/50000)`, `floor(chron/5000)`). They stop being name
  generators. That distinction is the ARC6 door (§4.6).

### 4.6 Grammar changes — and the ARC6 constraint

`store.PackSeries` after cutover:

```go
{"idx",      ""},
{"data",     ""},
{"meta",     ""},
{"manifest", ""},
{"seen",     ""},
```

(`db` is deleted, §10.1; the kind letters are deleted, §4.5.) This flows through
`packKeyRe`, `cacheControlForKey`, `contentTypeForKey`, the generated
`PACK_SERIES_KINDS`, and the SW's route regex, exactly as the delta-tail change
did.

**ARC6 constraint, honored explicitly.** ARC6 is the possible future merge of
`idx/` and `meta/` into one derived series. This design is written so that merge
is a manifest-shape change and nothing else: the manifest carries *series → name
list*, and nowhere does the reader assume there are exactly three of them, that
`idx` and `meta` are distinct, or that a series' stride is 50,000 / 5,000 rather
than a number the format constants declare. A merged series would appear as one
more row in `PackSeries`, one more name list in the manifest, and one stride
constant in `format.gen.ts`. **Any reviewer of S32–S35 should reject a patch
that hard-codes the three-series shape into the manifest parser.**

## 5. The content split

### 5.1 `DBCore` field-by-field

Destinations are decided by one axis: **does the reader consume it?** — not by
"is it operator-authored". `exp` (retention days) is operator config and is
nonetheless reader-consumed (`picker.ts` renders a "Retention" row), so it stays
public in the manifest. Splitting on authorship instead would have broken the
reader for no gain.

| Today (`db.gz`) | Destination | Note |
|---|---|---|
| `v` | **root** | becomes 2 |
| `seq` | **retired** | subsumed by `m` + explicit names |
| `sf` | **retired** | seen slots are manifest-named (§10.2) |
| `fetched_at` | **root** (`t`) + manifest copy | root copy is what makes an idle cycle cost 60 bytes |
| `total_art` | manifest | |
| `next_pid` | **retired** | reader used it only to decide finalized-vs-tail naming |
| `pack_off` | manifest (writer state) | reader never read it |
| `gen` | **retired** | §10.4 |
| `hdrs` | **retired** | replaced by the `hsum` name + its covered count |
| `mp` | **retired** | replaced by the meta list length + `ssum` |
| `mt` | manifest | tail shard entry count; still load-bearing |
| `nd` | **retired** | replaced by `len(deltas)` |
| `na` | manifest | the pack↔delta seam `tc = total_art − na` survives verbatim |
| `dby` | manifest (writer state) | |
| `gcs` | manifest as `gcm` | now a manifest-number low-water (§7) |
| `inbox` | manifest (writer state) | atomicity, §4.4 |
| `recipes` | **config sidecar** | |
| `dd` | **config sidecar** | store-wide dedup default |
| `out` | **config sidecar** | the `out/*` files stay mutable and unchanged |
| `feeds` | **split**, §5.2 | |
| `head`, `hb` | manifest | §8.2 |

### 5.2 `Feed` field-by-field

| Field | Destination | Why |
|---|---|---|
| `title`, `url`, `tag`, `nt` | manifest | rendered by the picker/reader (`url` is a live link in the feed info card) |
| `total_art`, `add_idx`, `xp` | manifest | counting/filter math |
| `cb`, `ab`, `exp` | manifest | rendered as Stored content / Stored assets / Retention |
| `wm`, `ferr`, `last_ok`, `fail_streak`, `last_new` | manifest | the health grade + "Latest published" card |
| `recipe`, `ingest`, `pipe` | **config sidecar** | never reader-read |
| `dd`, `dt` | **config sidecar** | never reader-read |
| `etag`, `last_modified`, `bg` | unchanged (`seen` slot) | already `json:"-"` |

Net effect on `STORE-VISIBILITY.md`: after S34 a public store still exposes the
subscription list, per-feed health and the newest titles, but **no longer**
exposes recipes, per-feed ingest/pipe commands, dedup tuning, or the syndication
slot list. That is the "strictly smaller change than going private" the
visibility doc named as the natural first step; this design takes it as a side
effect and that document should be updated at S34, not before.

## 6. Commit protocol

### 6.1 The universal crash argument — stated once

> **Every mutation writes only new immutable objects, then one immutable
> manifest naming them, then flips the root. A crash at any point before the
> root flip leaves unreferenced objects in the store and changes nothing a
> reader can observe. A crash after the flip has already succeeded. There is no
> third case.**

Two properties make it airtight, and both already hold today:

1. **No reader can learn a name before the root names it.** Names are drawn
   from counters the manifest publishes, and no reader derives names (§4.5).
   The "never speculatively prefetch the next generation" rule that guards
   `L<seq+1>` and `d<seq+1>` today generalizes to "never fetch a name no
   manifest listed".
2. **The root flip is a single-object atomic write** (`AtomicPut`, the same
   operation `Commit` uses today).

Everything else is a corollary:

- `SyncIdxSummary` writes `hsum` then it appears in the manifest. No proof.
- `SyncMeta` writes shards/tail/`ssum` then they appear. No proof.
- `SyncSeen` writes `seen/<n>.gz` then it appears — and the ordering inversion
  it currently documents (write *before* Commit, unlike `hdrs`/`mp`) stops being
  a thing anyone has to remember.
- `emitDelta` / `consolidateTail` write segments/packs then they appear.
- `drainInbox` folds envelopes and the watermark rides the same flip; the
  post-flip `Rm` of drained slots is unchanged.
- `SnapshotDB` is deleted: the manifest *is* the snapshot.

Warn-only steps stay warn-only and keep working: a failed `SyncMeta` simply
publishes a manifest whose meta list is short of the store, and the reader's
existing coverage gate (`metaReady`, now expressed as "the meta list plus `mt`
plus `na` covers `total_art`") falls back to `data/` exactly as today.

### 6.2 The root flip without CAS — and with it (REL3)

**Today's mechanism, and what S32–S34 are built on.** The writer holds the
advisory `.locked` marker (exclusive-create `Put`, `--force` override) for the
whole mutation, exactly as now, and the flip is `AtomicPut("db.gz", …)` on a
~60-byte body. This is byte-for-byte today's `Commit` semantics on a smaller
object; it introduces no new failure mode and needs no backend capability.

**One free hardening, available now.** The manifest is published with
**exclusive-create** semantics (`Put(ctx, key, r, /*ignoreExisting=*/false)`),
not `AtomicPut`. Every backend implements exclusive create (that is how
`.locked` works: `O_EXCL` on local, `If-None-Match: *` on S3/HTTP). A second
writer that raced past a stale/forced lock therefore fails loudly at
`manifest/<m+1>.gz` — the name it must publish is already taken — **before** it
can flip the root. This turns the manifest counter into a poor-man's
compare-and-swap on the commit itself and is strictly better than the advisory
lock alone. Retry policy: a failure here is fatal for the cycle (never
overwrite; the peer's generation is real).

Note the deliberate exception: the *retry-after-crash* path. A crash between
publishing `manifest/<m+1>.gz` and flipping the root leaves that name taken, so
the next cycle's exclusive create fails on a name nothing references. The writer
resolves this by reading the root first: if `root.m < m_ondisk_attempt`, the
orphan is provably unreferenced garbage and may be overwritten (log INFO).
Because the orphan's own listed objects are also unreferenced, no reader can be
harmed. This is the one place the design needs a stated rule rather than a
corollary, and S32's test plan must cover it.

**With REL3 (lease + CAS).** The flip becomes a conditional PUT of the root
against the ETag captured when the writer opened the store. A losing writer gets
a 412 and aborts having published nothing but garbage. The advisory `.locked`
then degrades from "the correctness mechanism" to "the politeness mechanism",
and `storeWriter`'s 30-second in-process queue and the GUI's 409 contract are
unchanged. **REL3 is strongly recommended before S34 but is not a prerequisite**:
the exclusive-create manifest above already converts the dangerous case (two
writers, both convinced they hold the store) from silent interleaving into a
loud abort.

### 6.3 The config sidecar's commit and lock story — decided

Decision: **`config.gz` is written under its own dedicated advisory marker
`.config.locked`, independent of the store-writer `.locked`.**

Rationale:

- The plan's stated goal is that config edits stop 409ing a running fetch cycle.
  Sharing `.locked` cannot deliver that while FET5 (the lock held across the
  network fan-out) is open, and it would deliver it only partially even after.
- A fetch cycle **reads** `config.gz` at open and never writes it, so
  writer↔editor exclusion is not needed for correctness. A config edit landing
  mid-cycle means the cycle ran with the previous config — indistinguishable
  from the edit landing a second later, which is already the semantics today.
- The marker serializes **editor↔editor only** (a GUI save on `dmz` against a
  `srr recipe set` on `gateway`), which is a read-modify-write of one small
  object. Same mechanism, same `--force` escape, no new backend capability.
- When REL3 lands, `config.gz` is the *first* object to move to CAS: a
  single-object read-modify-write is precisely what `If-Match` expresses, and it
  needs no lease at all. `.config.locked` is then deleted.

**Deadlock discipline.** A mutation that touches manifest state *and* config
(feed add / remove / edit — `title` is manifest, `pipe` is config) acquires
`.locked` **then** `.config.locked`, never the reverse. A pure-config mutation
(`recipe`, `syndicate`, `dedup`, the feed-level `-i`/`-p`/`--dedup-*` flags when
they are the only change) takes only `.config.locked`. Fixed order, two locks,
no cycle.

### 6.4 Ordering for two-object mutations

`config.gz` is never referenced by a manifest, so the two writes are ordered by
which transient state is inert:

- **Feed create / edit:** write `config.gz` first, then manifest + root flip.
  The window holds config for a feed that does not exist yet — inert by §4.3.
- **Feed remove:** flip the root first (the feed is gone), then drop its
  `config.gz` entry. The window holds config for a feed that no longer
  exists — inert by §4.3, and swept by the next config write.

Both windows survive a crash as inert garbage, which is the same standard §6.1
sets for everything else.

### 6.5 Invariants (writer-enforced, reader-assumed, `inspect`-checked)

- **M1 — Root/manifest agreement.** `manifest/<root.m>.gz` exists and parses.
  A reader that 404s it takes the existing guarded reload (`assertPackOk`).
- **M2 — Manifest density.** Manifests exist for every `m` in
  `(gcm, root.m]`. `m` advances by exactly 1 per publishing Commit.
- **M3 — Name uniqueness.** No stem is ever reused within a series. Formally:
  a series' counter is monotone and persisted in the manifest; every manifest's
  listed stems for a series are ≤ that counter.
- **M4 — Reachability.** Every object named by any of the last K manifests
  exists. (The converse — nothing else exists — is GC's job, not an invariant:
  garbage is legal, §6.1.)
- **M5 — Positional density.** Each series' expanded name list is dense from
  its base: position `i` names the object holding that series' `i`-th stride
  region, with no holes. This is what lets `floor(chron/stride)` index the list.
- **M6 — Seam.** `tc = total_art − na`; the delta list's parsed line count
  equals `na`; the last idx list entry holds exactly `tc − (len(idx)−1)·50000`
  entries. (DELTA-TAIL I3 + I4, re-anchored.)
- **M7 — No stratum inside the delta region.** DELTA-TAIL I2, retained
  verbatim as a *writer* invariant: it is what keeps M5 true for the meta list
  while a delta chain is live.
- **M8 — Chron permanence.** No manifest generation may renumber chrons. A
  rebuild or compaction may re-encode any object under a new name, but the
  article at chron `c` in manifest `m` is the article at chron `c` in every
  later manifest (possibly as a tombstone, §9). This is the invariant §9 buys
  and S35 must be gated on.

## 7. GC — one rule

**Delete what the last K manifests do not name.**

`K` is the grace window: how many generations stale an open tab's root may be
before it must self-heal. It replaces `latestKeep`, `gcSweepWindow`, the
`tailGen − keep − 1 − 2·maxDeltas` cutoff, and the separate summary windows —
four formulas, one number. Recommended default **K = 32** (`--keep-manifests`),
which is ≥ today's effective 27-generation tail window at `--max-deltas 12` and
is a plain count instead of a derivation.

Without `Backend.List` (STO1 open), the sweep is a **low-water drain** on the
manifest counter, the direct heir of `gcs`:

```
for g in (gcm, m−K], bounded by gcMaxSweep per run:
    read manifest g
    for each name in names(g) \ union(names(m−K+1 … m)):  Rm
    Rm manifest/<g>.gz
    gcm = g            (advanced only over generations fully cleared)
```

The low-water is normative for the same reason it is today: the sweep is
warn-only and post-flip, so a missed or failed run must not permanently strand
anything, and the next advancing run resumes exactly where the last stopped.
`union(names(m−K+1 … m))` is K manifest reads per sweep — at K=32 and a
5-minute loop that is 32 small immutable GETs per cycle, which the writer should
memoize across the run (it already has manifest `m` in hand; the other K−1 are
force-cacheable by the store backend's own HTTP layer). With STO1 the whole
thing collapses to "list the store, subtract the union" and `gcm` disappears.

`GCLatest`, `GCSummaries`, `GCMetaSummaries` and the `db/` snapshot sweep all
merge into this one function.

## 8. Reader and service worker

### 8.1 Boot and poll

`data.ts`:

1. `loadDb()` fetches `db.gz` `no-cache` (unchanged).
2. `parseDb` branches: `v === 2` → fetch `manifest/<m>.gz` with
   `cache: "force-cache"` (immutable) and merge into the same in-memory `IDB`
   shape the rest of the module already consumes; `v ≤ 1` → today's path
   verbatim (this is S33's dual-path, and it is what lets the reader ship
   *before* the writer flips).
3. Everything downstream — `applyDb`, `fetchIdxPack`, `fetchDeltas`,
   `loadMeta`, `search.ts` — changes only where it *builds* a pack name: it
   indexes the manifest's expanded name arrays instead of formatting
   `idx/${p}.gz` / `idx/L${tailGen()}.gz` / `data/d${g}.gz`. The seam math
   (`tailCovered`, `packIdx`, `metaPackId`) is untouched.

`refresh()`'s change detection becomes `raw.m !== db.m` — one integer instead of
the four-field comparison (`fetched_at`/`total_art`/`seq`/`gen`), with `t` used
only for the freshness display. The rollback-on-failure snapshot in `refresh()`
must extend to the manifest-sourced fields; Appendix-D discipline unchanged.

**Bandwidth, honestly.** Three cases per 5-minute poll:

| Cycle | Today | Under v2 |
|---|---|---|
| Nothing changed (backoff thinned every feed) | full db.gz body (~10.6 KB — `fetched_at` moved, so no 304) | ~60 B root |
| Feeds polled, no new articles (vitals moved) | ~10.6 KB | ~60 B + manifest (< today's db.gz: config is gone) |
| New articles | ~10.6 KB + deltas | ~60 B + manifest + deltas |

The design does **not** claim a large per-poll byte win on cycles that touch
vitals — most cycles do. It claims: never worse on any path; free when nothing
changed; the hot object becomes immutable and therefore edge-cacheable (an R2
class-B op and origin-bandwidth win that scales with reader count, and one
fewer origin round-trip of latency); and config off the hot path entirely. If
measurement later shows vitals churn dominating, splitting `feeds[].{ferr,
last_ok, fail_streak, last_new}` into a separately-named object is a
manifest-shape change this design already permits — noted as future work, not
specified here.

### 8.2 `head`/`hb` stay in the manifest — decided

They are fetched exactly when they are useful. The manifest is fetched precisely
when the store changed, which is precisely when the newest window changed; a
poll that finds `m` unchanged has a cached manifest and therefore a cached
`head` at zero marginal bytes. Moving them to the root would inflate the
60-byte poll to ~4 KB on every single poll, including the ones that change
nothing — the exact opposite of the trade this design is making. Keep them where
the plan recommends.

### 8.3 Service worker

The SW's job simplifies in three ways:

- **Routing:** one new inert series (`manifest`) via the regenerated
  `PACK_SERIES_KINDS`; manifests are cache-first like any other write-once name.
- **Pruning:** `checkManifest`'s gen-purge, `gcs`-mirroring `L`/`d` prune, and
  `h`/`s` `LATEST_KEEP` windows are all replaced by: *on adopting manifest `m`,
  evict any cached pack object named by neither `m` nor the previously-cached
  manifest.* One generation of overlap covers a tab mid-swap. This is exact
  rather than approximate, and — unlike today's `gcs` mirror — needs no
  knowledge of the writer's runtime `--max-deltas`.
- **Cache-first becomes unconditional:** `cacheFirst`'s `revalidate` flag exists
  solely because a rebuild could reuse a name. It cannot any more. Drop it, and
  with it the `no-cache` refetch on every pack miss.

`enforceCacheBounds` keeps its shape; "lowest-numbered evicted first" becomes
"lowest *position in the manifest's list* evicted first", which is exactly chron
order and no longer an approximation. The `srr-pinned-v1` bucket's gen-purge
becomes "unpin what the new manifest no longer names", and the existing
`pins-purged` message to open pages is reused.

`packNamesForFilter` (the offline pin enumerator) gets simpler: it already
enumerates names, and now it reads them from a list instead of reconstructing
them from `next_pid`/`tailGen`/`nd`.

## 9. Compaction, rebuilds, and device-state stability

**This is the question the plan flagged as hard and as the gate on S35. It is
answered here, and the answer is not either of the two options the plan
listed.**

### 9.1 What is actually chronIdx-keyed (audited, not assumed)

| Where | Shape | chronIdx role |
|---|---|---|
| `localStorage["srr-seen"]` (`keys.ts SEEN_KEY`) | `Record<"feed:<id>", chronIdx>` | **value** — the per-feed read frontier; `nav.ts recordSeen`/`markAllRead`/`markUnreadFrom` |
| `localStorage["srr-seen-ts"]` (`SEEN_TS_KEY`) | `Record<"feed:<id>", unixSec>` | keys mirror the above; values are timestamps, not chrons |
| `localStorage["srr-saved"]` (`SAVED_KEY`) | `chronIdx[]` in **save order** | **element identity** — `nav.readSavedSet`, the ★ Saved queue |
| `localStorage["srr-hash"]` + the URL `#pos!tokens` | chronIdx | the restored/shared reading position |
| The sync profile blob (`profile.ts` v2, replicated to the user's endpoint and to every other device) | carries `srr-seen` + `srr-saved` verbatim | **the multiplier**: any renumbering must be applied consistently across devices, or a merge silently mixes two coordinate spaces |
| `localStorage["srr-pins"]` (`PINS_KEY`) | filter key → pack **names** | not chron-keyed, but name-keyed — see §9.5 |

The sync blob is what makes the renumbering options expensive: it is not one
device's state to migrate, it is a fleet's, and `profile.ts`'s merge rules
(per-key LWW on `st`, LWW on `ts`) have no concept of a coordinate space. An
un-migrated device merging old-space chrons into a migrated device's new-space
values is **silent corruption** — frontiers land in the wrong place, saved
articles point at different articles. No error, no popup, wrong content.

### 9.2 Decision — chron addresses are permanent; compaction empties payloads in place

**Physical compaction rewrites packs but never renumbers chrons.** An expired
article keeps its idx entry, its data-pack line and its meta card *slot*; what
is deleted is its **payload** — the content, title, link, and its `assets/`
objects (already deleted today).

Concretely, a compaction generation:

1. Rewrites each affected `data/` pack under a **new stem**, with expired lines
   replaced by tombstone lines that preserve `f`, `a`, `p` and drop `t`/`l`/`c`/`g`.
2. Rewrites each affected `meta/` shard under a new stem, with expired cards
   reduced to `{"f":…,"w":…}` (title dropped) and its bloom rebuilt over the
   surviving titles.
3. Leaves `idx/` untouched entirely — the entries are already just feed ids and
   boundaries, 2 bytes each.
4. Publishes one manifest listing the new stems at the same positions, and
   flips the root. GC (§7) reclaims the old packs after K generations.

Nothing else changes. `total_art`, every feed's `total_art`/`add_idx`/`xp`, the
idx headers' all-time cumulative counts, `next_pid`-equivalent positions, the
`fetched_at` monotonicity `ExpireArticles` and `art ls --since` binary-search on,
the 5k/50k strides, `metaReady`'s arithmetic — all of it is **already correct**
and stays correct. There is no migration, no mapping object, no profile version
bump, no cross-device ordering problem, and no window in which two devices hold
different coordinate spaces.

### 9.3 What it costs

The retained floor per expired article:

| Series | Retained | ~bytes/article |
|---|---|---|
| `idx/` | the 2-byte entry (unchanged) | 2 |
| `data/` | `{"f":42,"a":1753027200,"p":1753020000}` | ~40 raw; a run of these gzips to a few bytes |
| `meta/` | `{"f":42,"w":1753020000}` | ~25 raw, likewise run-compressible |

Against a typical article's ~2 KB of content (~0.6 KB gzipped), the floor is
**under 1% of what compaction reclaims** — and the reclaimed part includes the
`assets/` objects, which dominate a media-heavy store outright. A finalized meta
shard also keeps its fixed 4,096-byte bloom header even when fully tombstoned;
a bloom over zero surviving titles is all-zero and compresses to nothing inside
the shard, and inside `ssum` a run of zero blooms likewise.

The one honest UX regression: a ★-Saved article or a shared deep link pointing
at a compacted chron now resolves to a tombstone. The reader must render it as
an explicit **"This article is no longer stored"** state — source and date still
correct, content gone — rather than a crash or, worse, silence. That is
strictly better than the alternatives: renumbering either drops the saved entry
or, if a device misses the migration, points it at a *different* article.
Contract: `loadArticle` returns the tombstone record (its `c` absent), and
`app.ts` renders the expired state; the list's saved-mode row shows source · age
with an "(expired)" title. Add it to the reader alongside the `[DELETED]` feed
tombstone it is a sibling of.

### 9.4 Why not a chron→chron mapping object

It works, and it was the plan's first suggestion, but it costs more than it
saves:

- **The object.** An exact rank map over the pre-compaction chron space is
  either a kept-bitmap (1 bit/old chron — 125 KB raw at 1M articles) or a
  kept-run list (unbounded when per-feed expiration interleaves, which it does
  by construction). Either way it is a new published object class with its own
  lifecycle and its own GC.
- **The profile version.** `profile.ts` needs a `v:3` with a compaction-epoch
  field, and `mergeSeen`/the saved LWW rules need an epoch guard, or a
  pre-migration device silently corrupts a post-migration one (§9.1). Every
  device must be able to fetch and compose the *chain* of maps from its own
  epoch forward — including a device that was offline across two compactions.
- **The failure mode.** Silent, content-level, and unrecoverable — the exact
  class this project spends its design budget avoiding everywhere else.
- **The invariant.** `docs/DELTA-TAIL-SPEC.md` G3 lists "chronIdx as a permanent
  address" among the structural invariants the delta design was required to
  preserve. Compaction is not a good enough reason to be the first feature to
  break it.

### 9.5 Why not a stable per-article identity

Re-keying device state on `(feed_id, guid)` or `(feed_id, published)` removes
the coordinate problem but replaces an O(1) array index with a lookup that the
store has no index for. The seen frontier is *positional by nature* ("everything
before this is read"); expressing it as a per-feed `fetched_at` watermark is
actually sound (chron order is `fetched_at`-monotone — that is the property
`INBOX-SPEC.md` protects), but ★ Saved needs *exact article resolution*, and
resolving `(feed, guid)` → chron requires scanning idx+data. That is a reader
redesign, a wire-format addition (a stable per-article id in `ArticleData`),
and a profile migration — for a problem §9.2 dissolves.

### 9.6 The escape hatch, deliberately unbuilt

If a future operation genuinely must renumber (merging two stores under S36–S38
is the plausible one), the door is: publish a rank map with the renumbering
manifest, add the compaction epoch to the profile blob, and require every device
to migrate through the chain before its next push. **S35 does not permit it**,
and M8 forbids it until a successor spec argues it. `srr inspect --validate`
gains a chron-permanence check across the last K manifests so a violation is
loud.

**Pins** (`srr-pins`) are name-keyed, not chron-keyed, and a compaction changes
names. That is already handled by §8.3's rule ("unpin what the new manifest no
longer names") and by the existing "a pin is a snapshot" contract; the SW's
`pins-purged` message tells the page to clean its registry.

## 10. Redundancies retired at cutover (S34)

### 10.1 The `db/` snapshot series

`SnapshotDB` exists because `Commit` overwrites the one fixed key, so the store
keeps no history of the ~10 pointer fields whose loss costs hours of hand
reconstruction. Manifests *are* that history, one per generation instead of one
per consolidation, and reachable through K generations rather than a separate
sweep window. **Restore becomes: write `{"v":2,"m":<older>}` to `db.gz`** — a
20-byte edit that repoints the store at a known-good generation whose objects
are still present (which is exactly what K guarantees). This is strictly better
than `cp db/12.gz db.gz`: the old snapshot could name generation objects the GC
had already swept, while a manifest inside the K window is reachable by
construction. Delete `SnapshotDB`, `dbSnapshotKey`, the `db` `PackSeries` row,
and the snapshot arm of `GCLatest`. The "there is deliberately no `srr restore`
verb" note stands, and the runbook line becomes a one-liner.

One cleanup detail: the legacy `L`/`d`/`h`/`s` objects reclaim themselves,
because the S32 manifests still inside the K window list them by name and §7's
unreachability sweep therefore reaches them. `db/<g>.gz` snapshots never appear
in any manifest, so S34 must sweep them once by name (the same bounded
`dbSnapshotKey(g)` loop `GCLatest` runs today, kept for exactly one release and
then deleted with the rest).

### 10.2 The `seen.gz` `sf` ping/pong

The two-slot ping/pong plus the `sf` flag exist to make "the article batch and
the dedup state that produced it become durable together" atomic against a
single fixed mutable key. With manifests, the seen sidecar is written as an
immutable `seen/<n>.gz` and named by the manifest — the same atomicity from the
same one root flip, with no flag, no slot arithmetic, and no ping/pong. The
guarded-load ladder (active slot → sibling → legacy bare `seen.gz` → empty
pool) collapses to "read the name the manifest gives; a corrupt object falls
back to the previous manifest's name, which is still within K". `isSeenObject`
in `store/main.go` is deleted (a `seen` `PackSeries` row replaces it), and
`seen` stops being a mutable object class. Write volume is unchanged — the
sidecar is already rewritten every dirty cycle.

### 10.3 The `h<N>` / `s<N>` summary naming

`idx/h<hdrs>.gz` and `meta/s<mp>.gz` encode their coverage in their names so a
reader can tell whether the summary matches the store (`hdrs === numFinalized`).
Under manifests, coverage is a field next to the name and the name is a stem
like any other. The reader's "summary lags → fall back to eager idx loading"
path stays (it is a real degradation mode after a warn-only failure), but it is
now a comparison of two numbers in one object instead of a name-vs-count
handshake. `summaryKey`, `metaSummaryKey`, `GCSummaries`, `GCMetaSummaries`,
their `LATEST_KEEP` windows, and the SW's `h`/`s` cutoff arithmetic all go.

### 10.4 `gen`, `gen --bump`, the purge WARNs, and the SW gen-purge

All four exist for exactly one reason: an in-place rebuild reuses finalized
names with new bytes. Under §4.5 it cannot. Delete `DBCore.Gen`, `BumpGen`,
`srr gen` and `POST /api/gen/bump`, the "purge cdn.llera.eu now" WARN in
`BumpGen`, the equivalent WARN in `asset heal` (which gets a fresh-name path
under S35 — an asset repair writes a new content-hash key and rewrites the
referencing articles in a compaction generation, instead of overwriting an
immutable key in place), the SW's `GEN_KEY` bucket and gen-purge branch, and
`data.ts refresh()`'s `gen` comparison. The whole "purge discipline" paragraph
in `CLAUDE.md` → CDN Layout is deleted rather than edited.

Also deleted with them: the rebuild-discipline rules that begin "a rebuild must
preserve the full article sequence, expired entries included…". Under M8 a
rebuild cannot renumber, so the hazard those rules manage does not arise.

### 10.5 The four `Sync*` ordering proofs

`SyncIdxSummary`, `SyncMeta`, `SyncSeen` and `SyncOutFeeds` each carry a
comment block arguing their publish order. All four collapse into a pointer to
§6.1. (`SyncOutFeeds` keeps its *own* comment about `out/` being mutable and
rewritten in place — that is unrelated to the commit model and stays true.)

### 10.6 The GC window formulas

`latestKeep`, `gcSweepWindow`, `2·maxDeltas`, `LATEST_KEEP` on the TS side, and
the `gcs` mirror in `checkManifest` — replaced by `K` (§7) and by "evict what
the manifest does not name" (§8.3). `MAX_DELTAS` stops being a generated
contract atom (the reader no longer needs the writer's runtime value for
anything).

## 11. Migration and rollout

Reader-first, the delta-tail discipline (`DELTA-TAIL-SPEC.md` §13), with one
extra beat because this break is coordinated on the *root* rather than on a
field.

1. **S32 — writer dual-write.** `Commit` additionally publishes
   `manifest/<m>.gz` and (on config mutations) `config.gz`, while continuing to
   write today's full db.gz with `v:1` and every legacy field. Manifests carry
   the legacy names verbatim (`idx/L<tailGen>.gz`, `data/d<g>.gz`, …) —
   explicit naming starts here, opaque stems do not. Every deployed reader is
   unaffected; every intermediate release is readable by every deployed reader.
   `srr inspect --validate` learns to cross-check manifest ↔ legacy fields and
   must pass on a migrated copy of the prod store.
2. **S33 — reader dual-path.** `parseDb` handles both root shapes; the SW picks
   up the manifest series. Ship it, deploy it **everywhere** — Cloudflare Pages
   *and* the store-root shell (`srr frontend update`, which per the operator's
   standing rule is run by the operator, never by an agent). Confirm via the
   admin GUI version label and `srr.32b.io`.
3. **S34 — writer cutover.** Root shrinks to `{v:2, m, t}`; `dbFormatVersion`
   → 2; opaque stems begin; §10's deletions land in the same release (the
   complexity win only exists when the old paths are deleted, not shadowed).
   Old readers get the clean version-reject popup. **One-way door for the prod
   store** — the last legacy `db/` snapshot is the rollback artifact, and it is
   taken immediately before the flip.
4. **S35 — compaction.** Only after M8 and §9 are implemented and
   `inspect --validate`'s chron-permanence check is green.

Rollback: at S32/S33 there is nothing to roll back (dual-write is additive). At
S34, rolling back means writing a legacy db.gz from the current manifest — which
is mechanically possible (every field is present) but requires a binary that
still knows how, so **the S34 release must keep a hidden `srr downgrade-root`
for one release cycle**. That is the honest price of a one-way door.

## 12. Worked example — 1M articles

Store: 1,000,000 articles, 200 feeds, `--pack-size 200` (KB compressed), so
~3,000 data packs, 20 idx packs, 200 meta shards, a live 7-segment delta chain.

`db.gz` (30 bytes raw, ~50 gzipped + headers):

```json
{"v":2,"m":1743,"t":1753027200}
```

`manifest/1743.gz`:

```json
{
  "v": 2,
  "m": 1743,
  "fetched_at": 1753027200,
  "total_art": 1000000,
  "na": 143,
  "mt": 4857,
  "pack_off": 138422,
  "names": {
    "idx":  {"b":0, "r":[[0,20]]},
    "data": {"b":1, "r":[[1,3004]]},
    "meta": {"b":0, "r":[[0,201]]},
    "deltas": [3005,3006,3007,3008,3009,3010,3011],
    "seen": 441,
    "hsum": {"stem":88, "covers":20},
    "ssum": {"stem":91, "covers":200}
  },
  "feeds": {
    "42": {"title":"Example Blog","url":"https://example.org/feed.xml","tag":"news/tech",
           "total_art":18422,"add_idx":11003,"xp":11003,"cb":41203998,"ab":90210334,
           "exp":365,"wm":1753019000,"last_ok":1753027200,"last_new":1753019400,
           "fail_streak":0}
  },
  "hb": 999960,
  "head": [{"f":42,"w":1753019400,"t":"…"}],
  "dby": 91422,
  "gcm": 1707,
  "inbox": {"bastion": 1753026900}
}
```

Size budget:

| Part | Raw | Note |
|---|---|---|
| 200 feeds × ~200 B | ~40 KB | titles + URLs dominate; they compress well |
| `head` 40 cards × ~90 B | ~3.6 KB | `headMax` = 40 |
| name lists | ~120 B | one run per series on a pristine store |
| scalars + writer state | ~250 B | |
| **total** | **~44 KB raw ≈ 12–14 KB gzipped** | |

Compare: today's db.gz on the same store carries all of that **plus** recipes,
`out[]`, `dd`, and every feed's `recipe`/`ingest`/`pipe`/`dd`/`dt` — strictly
larger — and is `no-cache`, so every open tab re-downloads it every five
minutes. The manifest is immutable: the CDN serves it once per generation to the
origin and from the edge thereafter, and an unchanged `m` costs a reader
nothing at all.

Degenerate cases worth stating: a fully-fragmented data list (a compaction that
rewrote alternating packs — not something the writer produces, since it rewrites
contiguous regions) would be ~3,000 stems ≈ 21 KB raw / ~8 KB gzipped, and one
full rebuild re-contiguates it to a single run.

## 13. Verification against the existing specs

Required review pass. Each invariant either maps onto the manifest model or is
explicitly retired.

**`docs/DELTA-TAIL-SPEC.md`:**

| Item | Disposition |
|---|---|
| **I1** — chain contiguity, `data/d<g>` for every `g` in `(tailGen, seq]` | **Retired as an arithmetic invariant, preserved as content.** The manifest's `deltas` list *is* the chain, in order, by name. Contiguity was only ever a way to derive the names; the cross-check `Σ parsed lines == na` survives verbatim on both sides (M6). |
| **I2** — no finalization stratum inside the delta region | **Maps, retained verbatim** (M7). Its stated purpose — keeping `numFinalized*(total_art)` valid — becomes "keeping the meta/idx name lists positionally dense" (M5), which is what `floor(chron/stride)` indexing needs. Strictly still load-bearing. |
| **I3** — tail pack coverage (`idx/L<tailGen>` holds `tc − nf·50000` entries) | **Maps** into M6, re-anchored on "the last idx list entry". `next_pid`/`pack_off` describing consolidated state only: `next_pid` retired, `pack_off` retained as writer state. |
| **I4** — accounting equivalence (`tc = total_art − na`, `Σ lines == na`) | **Maps unchanged** (M6). The reader's boot cross-checks in `fetchDeltas` are unchanged. |
| §6.3 crash consistency (delta / consolidation orphans) | **Subsumed** by §6.1. The specific "a crash after step 2 leaves an orphan `d<seq+1>` the retry overwrites" argument is replaced by "the orphan is unreferenced garbage the GC reclaims" — *stronger*, because opaque stems mean the retry writes a different name rather than overwriting. |
| §6.4 feed removal drains the chain (id-reuse header corruption) | **Unchanged.** It is a property of the consolidation replay's as-of-chron count vector, not of naming. `RemoveFeed` → `DrainDeltas` stays exactly as implemented. |
| §8 GC + the `gcs` low-water + the SW `gcs` mirror | **Retired**, replaced by §7's one rule and §8.3's "evict what the manifest does not name". The low-water *mechanism* survives as `gcm` over manifest numbers (and disappears entirely with STO1). |
| §12.1 consolidation equivalence (byte-identical vs `--max-deltas 0`) | **Survives and must stay green.** Consolidation still replays through the same materialization loop; only the output *names* change, so the test compares bytes per positional index instead of per name. The feed-membership carve-out is unaffected. |
| §14's own note — "Proposal #1 composes cleanly; the snapshot manifest would list the live delta names explicitly instead of the reader deriving them from `nd`/`seq`, and `tc` validation moves into the manifest" | **This document is that proposal**, and it lands exactly as the delta spec predicted. |

**`docs/INBOX-SPEC.md`:**

| Item | Disposition |
|---|---|
| Drain atomicity — "articles and the drained watermark become durable in one `Commit`" | **Maps with one substitution**: `Commit` → the root flip. `inbox` rides the manifest (§4.4, non-negotiable). Crash before the flip → watermark unmoved, slot present, re-drain clean. Crash after → `cycle_id <= inbox[name]` skips the stale envelope and the `Rm` is retried. Word for word intact. |
| Single-slot backpressure; `inbox/` mutable, transient, not in `PackSeries` | **Unchanged.** Producers write `inbox/<name>.gz` with the DB open read-only and no lock; nothing about that touches the manifest chain. `cacheControlForKey`'s `inbox/` arm stays. |
| "The envelope carries item fields, not pre-encoded pack lines" (chron-monotone `fetched_at`) | **Unchanged**, and it becomes *more* load-bearing: §9.2's tombstones retain `a`, so `ExpireArticles`' contiguous-prefix model and `art ls --since`'s binary search keep working across compacted regions. |
| Known gap — per-feed `dd`/`dt` under a mid-cycle config change | **Slightly widened, stated:** `dd`/`dt` now live in `config.gz`, which a producer reads at open and an editor may rewrite lock-free (§6.3). The window is the same one cycle it is today; the accepted gap is unchanged in size, only in mechanism. |

**`docs/STORE-VISIBILITY.md`:** its closing section ("If the stance ever
tightens") prescribes precisely §5's split. Update that document at S34 to
record that the leak-shrinker was taken; the public/private decision itself is
unaffected.

**`docs/STATIC-ENGINE-DECISION.md`:** this design leans further into the static
store, as that record requires — it moves *more* structure into the object
layout and *less* into derived arithmetic, and adds no server-side read path.

## 14. Interactions and future work

- **REL3 (lease + CAS)** — §6.2. Strongly recommended before S34; not a
  prerequisite. The exclusive-create manifest is the interim guard.
- **STO1 (`Backend.List`)** — collapses §7 to "list, subtract the union" and
  deletes `gcm`. Purely additive; land it whenever.
- **FET5 (lock held across the network fan-out)** — orthogonal, but it is what
  currently makes config edits 409, and §6.3's separate config lock removes that
  motivation for config specifically. Still worth doing for feed mutations.
- **ARC6 (idx+meta merge)** — deliberately left open, §4.6.
- **Multi-store mounting (S36–S38)** — a mounted store is a root URL; the
  manifest makes "what does this store contain" one fetch instead of a
  derivation, which helps. Cross-store chron collisions are the renumbering
  case §9.6 defers.
- **Not included, deliberately:** delta-encoded manifests (a returning tab
  refetching a whole manifest for a vitals change is the residual cost —
  measure before designing); a separate vitals object (§8.1); manifest
  signing; any server-side read path.

## 15. Costs and risks (honest ledger)

- **One-way door.** S34 flips the prod store's root shape. Mitigations: the
  reader ships and deploys first, the version gate makes stale-reader failure
  clean and legible, a final legacy snapshot is taken, and a hidden
  `downgrade-root` ships for one cycle. The risk is real and is the reason S31
  needs sign-off.
- **Two mutable objects instead of one** (`db.gz` + `config.gz`), plus a second
  advisory marker. That is a genuine increase in moving parts, bought against
  ~14 retired fields, four retired GC windows, eight retired ordering proofs,
  and a whole retired concept (`gen`).
- **K manifest reads per GC sweep** until STO1 lands (§7). Memoizable, small,
  warn-only, and bounded by `gcMaxSweep`.
- **Manifest churn on vitals-only cycles** (§8.1). Never worse than today, but
  the design's headline byte win is smaller than "config leaves the hot object"
  suggests. Stated rather than hidden.
- **Compaction tombstones are visible to users** (§9.3): a saved article can
  become "no longer stored". That is a deliberate, legible loss chosen over a
  silent, illegible one.
- **What this does NOT fix:** the per-cycle seen-sidecar rewrite (unchanged in
  volume, only in naming), feed-side fetch traffic, the lock held across the
  fan-out (FET5), and the fact that a public store still publishes its
  subscription list.
