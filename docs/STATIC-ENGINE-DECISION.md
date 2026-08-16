# Static store or server reads — the fork, recorded

**Status:** decided 2026-07-20. SRR stays a **static store**: the read path is a
dumb object origin serving immutable files, and no SRR process sits in it. The
alternative — SQLite plus a small read API behind the `srr serve` process that
already runs 24/7 — is **rejected**, explicitly.

## Why this needs writing down

The historical justification for the static design was partly "we don't want to
run a server". That fact no longer holds: since 2026-07-09 the deployment runs
`srr serve --interval=5m` on the `dmz` box permanently — the admin GUI and the
5-minute fetch loop in one long-lived process. The server is already there. A
read API on top of it is a genuinely available option, and a large fraction of
the backend exists to avoid needing one.

So the choice has to stand on its own merits or it is inertia. This document is
the merits.

## What SRR actually is

SRR has built a small database engine on object storage. That is the product,
not an accident — the engine exists so that the *read* path can be a static file
server. The mapping is close to literal:

| Database part | SRR |
|---|---|
| Heap | `data/` JSONL packs, one `ArticleData` line per article — `PutArticles` (`db_pack.go`) |
| Primary index | `idx/` binary packs: 2-byte `feed_id:u16` entries, a variable-length header of cumulative per-feed counts, a data-pack boundary footer — written by `db_pack.go`, read by `idx_read.go` and `frontend/src/js/idx.ts` |
| Covering index | `meta/` cards `{f,w,t}` at a 5,000 stride (`SyncMeta`, `db_meta.go`) — the home list renders without touching the heap |
| Sparse / summary indexes | `idx/h<N>.gz` (concatenated finalized idx headers, `SyncIdxSummary`) and `meta/s<N>.gz` (concatenated shard blooms) — boot reads a summary instead of the whole index |
| Full-text index | per-shard trigram Bloom filters (4096 bytes, 7 probes) prefixed inside each finalized meta shard |
| Superblock / commit root | `db.gz` — the single mutable object, published by `Commit` via `AtomicPut`, versioned by `dbFormatVersion` |
| Write-ahead log | `data/d<g>.gz` delta segments — one immutable segment per article-producing cycle |
| Checkpoint | `consolidateTail` (fired by `shouldConsolidate`: chain cap, byte cap, or a meta-stratum crossing) |
| Vacuum | `GCLatest` / `GCSummaries` / `GCMetaSummaries`, on the `gcs` low-water cursor |
| Logical delete / retention | `ExpireArticles` bumping `add_idx`, counted by `xp` |
| Epoch | `gen` (`srr gen --bump`) — the reader/SW cache-invalidation generation |
| Backup | `db/<tailGen>.gz` snapshots (`SnapshotDB`) |
| Replication spool | `inbox/<name>.gz` producer envelopes (`docs/INBOX-SPEC.md`) |
| Single-writer lock | the `.locked` marker |

Naming it out loud matters: every future simplification proposal is really a
proposal about this engine, and it should be argued as such.

## The rejected option

**(b) SQLite + a read API.** Articles, feeds and an FTS5 index in a SQLite file
on the box that already runs `srr serve --interval`. The reader stops fetching
packs and calls a handful of JSON endpoints (list window, article body, search,
feed metadata) instead.

It is a real simplification and it should be recorded as such rather than
strawmanned. It would delete: the binary idx format on both sides, the pack
split/finalize/boundary machinery, the meta shards and their Bloom filters, the
delta chain and consolidation, three GC sweeps, two summary series, the db.gz
snapshot series, the `gen` epoch, most of the service worker, the `gen-ts`
generator and the generated wire types, the `idx_read.go` ↔ `idx.ts` mirror
discipline, and both e2e layers that exist to prove writer and reader agree.
Measured crudely across the files that exist mainly to make static reads work
(`db_pack.go`, `db_meta.go`, `idx_read.go`, `cmd_gents.go`, `idx.ts`, `data.ts`,
`sw.ts`, `format.gen.ts`) that is on the order of 4,000 lines, in two languages,
with the hardest correctness invariants in the project.

## Why it is rejected anyway

1. **Static reads are the identity, not an implementation detail.** The project
   is a *Static* RSS Reader. The interesting claim it makes — a full reader over
   an arbitrarily large archive, served by a bucket — evaporates the moment a
   process is required to answer a read.

2. **Readers survive server death.** The reader is deployed to Cloudflare Pages
   and into the store root; the packs live in R2. If `dmz` disappears tonight,
   the fetch loop stops and the store stops growing — and every reader, on every
   device, keeps working against everything already published. Under (b) the
   reader goes dark the moment the process does, and the process is an
   unattended VM that release upgrades restart.

3. **Offline and edge caching are consequences, not features.** Write-once names
   mean the reader can fetch *every* pack with `cache: "force-cache"`; the
   service worker can be cache-first with a purge keyed on `gen` and `gcs`; the
   CDN can carry a year-long `max-age=31536000, immutable` on four whole
   prefixes. None of that was built as a feature — it falls out of immutability.
   Under (b) all three have to be re-earned inside an API layer, with
   invalidation logic that does not exist today.

4. **The hosting story is "a bucket".** No read-path capacity to plan, no
   process to babysit, no scaling story: R2 egress is free and priced per
   operation, so reader count is somebody else's problem. Going private is
   likewise "put auth in front of a bucket" (`docs/STORE-VISIBILITY.md`), not
   "add auth to an application".

5. **The engine's cost is sunk; the migration's is not.** The hard parts —
   chron addressing, the pack↔delta seam, GC grace windows, the format mirror —
   are built, tested and in production. Option (b) trades a paid-for complexity
   for an unpaid one: a data migration, a new API surface, a new auth story, and
   a new class of availability incident.

6. **`srr serve` running 24/7 does not make it a dependable read path.** It is
   an admin GUI plus a fetch loop, on a public VM, unattended, restarted by
   every release, on an sshd that already sheds connections under bruteforce
   noise. Availability that is fine for an operator console is not availability
   for the thing a user opens on a phone. Promoting a convenience process into
   the critical path is a downgrade dressed as a simplification.

## The price, paid deliberately

The static read path is not free, and pretending otherwise is how it gets
quietly abandoned. What it costs, concretely:

- **A wire contract in two languages.** The Go declarations are the single
  source of truth; `srr gen-ts` (`backend/cmd_gents.go`) emits
  `frontend/src/js/format.gen.ts`, and `make generate-check` inside
  `make verify-be` fails the build if it goes stale.
- **A byte-for-byte parser mirror.** `backend/idx_read.go` exists solely so the
  backend can read its own format the way `frontend/src/js/idx.ts` does. Two
  implementations of one binary layout must stay in lockstep, forever.
- **Two e2e layers.** `make test-contract` (real packs → real `idx.ts`/`data.ts`/
  `nav.ts`, jsdom) and `make test-browser` (real built SPA over real packs,
  headless Chrome). These are the only thing that proves writer and reader agree;
  they are not optional, and the browser layer is a required CI job.
- **Reader-first deploy discipline.** Any format change ships to readers before
  writers, because a stale tab is a supported state (this is why GC keeps grace
  windows and why the delta-tail rollout was staged that way).
- **Everything the reader must fetch is public by construction.** `db.gz`
  carries backend-only config for want of a second object — the leak surface
  documented in `docs/STORE-VISIBILITY.md`.

That is the bill. It is worth paying for points 1–6 above.

## What follows from this

- **The simplification budget goes to leaning in, never to server reads.** The
  next round of work (the manifest commit model and what it enables — plan steps
  S31–S35) makes the static engine *better*: an explicit commit manifest, fresh
  names on rebuild, generation-scoped compaction. It does not move reads onto a
  process.
- **A proposal that answers "just do it server-side" is refused by default.**
  Not forbidden — refused by default. The burden is on the proposal to beat this
  record on availability, offline behaviour, and hosting cost, not merely on
  lines of code.
- **The corollary, so the rule is not over-applied: the writer may use the
  server freely.** `srr serve`, the admin GUI, inbox producers, a future MCP
  endpoint — none of these are in tension with this decision. The rule constrains
  the **read path only**: nothing a reader needs may require an SRR process to be
  alive.

## What would reopen this

Honest triggers, so a future maintainer knows this is a decision and not a
dogma:

- **Read state that must sync across devices** (★-Saved, read/unread) growing
  past what a per-device store can honestly serve. That is a *write* problem, so
  the additive shape applies first: a sync service beside the static reads, not
  instead of them.
- **A cold-boot cost that stops being bounded** as the store grows — if the
  summary/manifest machinery ever fails to keep first paint bounded, the trade
  changes materially.
- **Search that needs real ranking.** Trigram Blooms plus client-side scoring is
  a deliberate ceiling; wanting BM25 over a million articles is a legitimate
  reason to re-open.
- **Multi-tenant hosting**, where per-user authorization on reads becomes a
  requirement rather than a bucket-level toggle.

Even then, prefer the additive form: static reads stay the floor that always
works, and a server adds capabilities on top. The reverse — a server that reads
are hostage to — is what this document rejects.

## Companion documents

- `docs/DELTA-TAIL-SPEC.md` — the WAL/checkpoint design in this table, in full.
- `docs/INBOX-SPEC.md` — splitting fetch egress from the single writer; the
  precedent that the *write* side may be distributed while reads stay static.
- `docs/STORE-VISIBILITY.md` — public-or-private, the sibling decision record
  and the format this one follows.
- root `CLAUDE.md` → Data Contract — the format this engine implements.
