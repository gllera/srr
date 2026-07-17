# SRR end-to-end tests

SRR is a **writer** (Go `srr` CLI) and a **reader** (this TS SPA) joined by a
file-format contract (`db.gz` + binary `idx/` packs + JSONL `data/` packs), not
an API. The unit tests exercise each side in isolation (the frontend ones mock
`./data` entirely). These e2e tests close the gap: they run the **real `srr`
binary** to write packs from canned feeds, then read them back with the **real
frontend code** — catching writer↔reader drift (idx layout, pack-split math,
`seq` latest-pack generations, dedup/watermark, JSONL keys) that neither
side's unit tests can see.

## Layers

| Layer | Dir | Runner | Speed | Runs in |
|---|---|---|---|---|
| **contract** | `contract/` | vitest + jsdom | fast (~1s) | `make verify`, `make test-contract` |
| **browser** | `browser/` | vitest + Puppeteer (headless Chrome) | slower (~30s, builds the bundle) | `make test-browser`, `make test-e2e` |
| **stress** | `stress/` | vitest + jsdom | heavy (~15s first run, generates a >50k store) | `make test-stress` (opt-in, NOT verify) |

- **contract** drives the real `idx.ts`/`data.ts`/`nav.ts` directly for
  exhaustive byte-level assertions (every chronIdx, pack splits, dedup, filter
  math), via a `fetch` shim that serves the on-disk pack bytes.
- **browser** builds the real production bundle and drives it in headless Chrome
  against real packs — proves the Parcel build, `app.ts` render, hash routing,
  and real-browser `fetch`/`DecompressionStream` work, not just the modules.
- **stress** drives the real data modules (`idx`/`data`/`nav`/`search`) against a
  **large** (>50,000-article, multi-idx-pack, multi-meta-shard, ≥150-feed)
  synthetic store and measures navigation / filtering / query cost **at scale** —
  request budget (asserted, deterministic) + wall time (logged as a PERF table).
  It reuses the contract `mount.ts` shim; the store comes from `stressStore()`
  (below).

## Run

```bash
make test-contract   # fast layer (also part of `make verify`)
make test-browser    # headless-browser layer
make test-e2e        # both
make test-stress     # large-store stress/perf layer (opt-in)
# or directly (after `make build-be`):
cd frontend && SRR_BIN=../dist/srr npm run test-contract
```

### Stress layer

`make test-stress` measures the reader at scale. The store comes from
`harness.ts` `stressStore()`, in precedence order:

1. `SRR_STRESS_STORE=<dir>` — use an existing store as-is (e.g. one you already
   generated to serve). Never wiped or regenerated.
2. a per-N cache dir under the OS temp dir (`srr-stress-store-<N>`), reused when
   it already holds ≥ N articles.
3. otherwise generated via the gated Go generator (`backend/genbig_test.go`'s
   `TestGenBigStore` — the **same production write path** a real fetch loop uses),
   sized by `SRR_STRESS_N` (default 60,000, enough for one finalized idx pack +
   11 meta shards).

```bash
make test-stress                          # generate/reuse a 60k store, then measure
SRR_STRESS_N=120000 make test-stress      # bigger: two finalized idx packs
SRR_STRESS_STORE=../bigstore make test-stress   # measure a store you already have
```

What it asserts (deterministic, machine-independent) vs. logs (timings):

- **boot** is O(1): db.gz + idx summary + latest packs only, **no** finalized idx
  pack fetched, and search/meta untouched until the first query.
- **navigation**: random-access `loadArticle` across the whole store is correct
  (idx↔data feed_id agreement) and published-monotonic; stepping **across the
  50,000-entry idx-pack boundary** stays contiguous.
- **filtering**: a feed present from the start touches the finalized idx pack,
  but a **late-added feed's walk skips it entirely** via header deltas (0
  finalized-idx fetches) — and every count matches the Go writer's own
  `srr inspect --filter`.
- **query**: an **absent term prunes every finalized shard** (0 shard fetches), a
  short (<3-rune) query scans the tail only, and a common term scans every shard
  with each hit addressing the real article it claims.

The generated store is a durable cache (not deleted on teardown). The PERF table
prints to the terminal (console interception is disabled for this layer).

`$SRR_BIN` points at the `srr` binary (the Makefile sets `../dist/srr`); if
unset/missing the harness builds it on demand from `backend/`. The browser layer
needs the Chromium under `~/.cache/puppeteer/` (installed with `puppeteer`).

## Shared pieces

- `harness.ts` — `srr()` (run the binary; async so the in-process feed server can
  answer the child's fetch — and hermetic: every invocation runs under
  `SRR_CONFIG_INLINE={}` so the host's `~/.config/srr/srr.yaml` can't leak knobs
  like `asset-process` into the store under test), `feedServer()` (canned RSS
  over HTTP; pass a `FeedRoute` `{body, type}` for non-XML routes, e.g. an image
  for `#selfhost`), `makeStore()`, `inspectValidate()`.
- `static-serve.ts` (browser layer) — the same-origin app+packs server, plus an
  in-memory `/sync/<name>` endpoint (GET = stored blob or 404, PUT = store) for
  the cross-device sync scenario.
- `fixtures.ts` — RSS builders; `nItems(count, prefix, pad?, startIdx?)` builds
  deterministic items — pass a distinct `startIdx` per feed so their published
  ranges are disjoint (keeping global chronIdx order total and assertable; a
  single call spans `pubUnix(startIdx)..pubUnix(startIdx+count-1)`, so default
  calls overlap), and `pad>0` to append **incompressible** content (packs roll on
  compressed size).
- `contract/mount.ts` — mounts the real reader against a store (fetch shim +
  `resetModules` + dynamic import; the shim must be installed before import
  because `data.ts` fetches `db.gz` at module load).

## Gotchas

- Serve pack `.gz` files **raw, with no `Content-Encoding`** — `data.ts`
  decompresses manually; a gzip header would double-decode.
- The browser server sends `Connection: close` and calls `closeAllConnections()`
  on teardown — otherwise `server.close()` stalls on Chrome's keep-alive sockets.
- A >50k-article multi-*idx*-pack case is too slow for `make verify`; that's what
  the **stress** layer (`make test-stress`, above) is for — it generates a real
  >50k store once and reuses it, so idx-pack continuity at scale is covered there,
  not inline in the contract layer.
