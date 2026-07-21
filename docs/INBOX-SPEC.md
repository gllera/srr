# Inbox / spool: splitting fetch egress from the single writer

**Status:** implemented 2026-07-20. Companion to `docs/DELTA-TAIL-SPEC.md` — read
this before touching `inbox/`, `DBCore.Inbox`, or the drain step in `runFetch`.

## The problem

SRR has exactly one writer: whoever holds the `.locked` marker runs the fetch
cycle. That is the right model for the *store* — one process appends packs, one
db.gz names the current generation — but it also pins **network egress** to
whichever box holds the lock.

That coupling has a concrete cost in this deployment. The fetch loop moved to
the public `dmz` VM on 2026-07-09, and 16 X/Twitter-via-nitter feeds (~23% of
the subscription list) have been dead ever since: nitter.net resets HTTP/2 from
datacenter IPs and the mirrors WAF-403 them. The feeds worked fine from the
residential IP the loop used to run on. Nothing about the *store* needs to move
— only the HTTP request.

The inbox splits the two: **any box may fetch; exactly one box still writes.**

## Roles

### Producer — `srr art fetch --spool[=name]`

Runs on any box that can reach the feeds. It:

1. Opens the DB **read-only, no lock** (the `preview` / `syndicate push`
   precedent). It never touches db.gz, packs, or the seen sidecar.
2. **Requires an explicit include selector** (`--tag` / `--feed`). A partition
   must always be deliberate: a producer that silently spooled *every* feed
   would duplicate the consolidator's own work.
3. Runs the normal fetch fan-out — the same pipeline, the same asset uploads.
   Assets are safe lock-free from any box: keys are content hashes, writes are
   upload-if-absent, so two boxes uploading the same bytes converge.
4. Serializes the cycle to ONE write-once object at the fixed key
   **`inbox/<name>.gz`** (`name` defaults to the hostname).

**Single-slot backpressure.** If the slot still exists, the previous spool has
not been drained: the producer **skips the cycle entirely**. This is what makes
the read-only snapshot sound — the producer's dedup state (`wm`/`bg`, its own
last spool) is never more than one un-drained cycle behind, so it cannot
re-fetch against state the consolidator has already superseded.

### Consolidator — the lock-holding `runFetch`

At its normal cycle, under the lock it already holds, it probes each configured
producer slot (`--inbox-producers`), `Get`s the ones present, and **drains**
them into the cycle's own batch:

- Skip the whole envelope if `cycle_id <= core.Inbox[name]` — the drained
  watermark, a writer-only `DBCore.Inbox map[string]int64` published atomically
  with the batch by the existing `Commit`. Same crash argument as `seq`/`sf`.
- For each feed record, match by **id AND equal URL**. A mismatch means the
  operator repointed or recreated that feed since the producer's snapshot, so
  the record is **discarded** (with a warning) rather than applied to a feed it
  no longer describes.
- Append its items to the cycle's batch — the existing published-sort
  interleaves them with locally-fetched articles — and apply the spooled
  per-feed state (`wm`, `bg`, validators, vitals) to the authoritative feed,
  plus its dedup-pool stamps to the seen pool.
- After a successful `Commit`, `Rm` the drained slots (warn-only).

## Wire format

`inbox/<name>.gz` is gzipped JSON:

```json
{
  "producer": "bastion",
  "cycle_id": 1753027200,
  "feeds": [
    {
      "id": 42,
      "url": "https://nitter.example/user/rss",
      "state": { "wm": 1753027100, "bg": [12345], "etag": "\"abc\"",
                 "last_modified": "…", "ferr": "", "last_ok": 1753027200,
                 "fail_streak": 0, "last_new": 1753027100 },
      "stamps": [12345, 67890],
      "items": [ { "t": "…", "l": "…", "c": "…", "p": 1753027100, "g": "en" } ]
    }
  ]
}
```

`cycle_id` is unix-seconds and strictly increasing per producer.

### Why items, not pre-encoded pack lines

The obvious design spools ready-made `data/` JSONL lines. It is wrong here:
`ArticleData.FetchedAt` would then carry the **producer's** cycle timestamp, and
a consolidator batch mixing producer-stamped and locally-stamped articles would
no longer be chron-monotone in `fetched_at`.

That monotonicity is load-bearing. `ExpireArticles` relies on each feed's
expired set being a contiguous chron prefix, and `srr art ls --since/--until`
binary-searches the entry slice on exactly that ordering. Breaking it would
silently corrupt both.

So the envelope carries the *item* fields (title/link/content/published/lang)
and the consolidator stamps its own `fetched_at`, exactly as it does for the
articles it fetched itself. The published timestamp — the one a reader sees —
is the producer's and is preserved verbatim.

## Crash safety

Articles and the drained watermark become durable in **one** `Commit`:

- **Crash before Commit** — the watermark is unmoved and the slot still exists,
  so the next cycle re-drains the same envelope cleanly.
- **Crash after Commit, before Rm** — the watermark has advanced, so the next
  cycle's `cycle_id <= Inbox[name]` check skips the stale envelope, and the Rm
  is retried (and eventually succeeds) then.

There is no multi-writer tail and no new locking. This is the same property
delta segments already proved: one cycle's batch published as a single
write-once object.

## Store handling

`inbox/` is backend-only and **transient** — deliberately NOT added to
`store.PackSeries`. It is never immutable and never reader-fetched.
`cacheControlForKey` / `contentTypeForKey` stamp `inbox/` keys `no-cache,
must-revalidate` + `application/gzip`, the same treatment the seen.gz sidecar
gets.

## Known v1 gaps

- **Per-feed `dd`/`dt` pool axes.** The consolidator applies the GUID hashes the
  producer collected, so the standard dedup pool is covered. A feed configured
  with `dt` (folded-title dedup) has its title hashes collected by the producer
  under the producer's own view of that config; if the operator changes `dt`
  between the spool and the drain, one cycle of title-axis dedup is missed.
  The re-promotion window is the accepted gap.
- **Partition disjointness is config discipline.** Nothing enforces that the
  consolidator excludes the spooled tag. Overlap does not corrupt anything — the
  duplicate is absorbed by `wm`/`bg` — but it wastes both boxes' fetches.

## Ops wiring (outside this repo)

A producer box runs `srr art fetch --spool --tag x` on a timer; the
consolidator runs with `--inbox-producers <name>` and `--exclude-tag x`. Both
live in the private `gllera/srr-config` repo.
