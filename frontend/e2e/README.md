# SRR end-to-end tests

SRR is a **writer** (Go `srrb` CLI) and a **reader** (this TS SPA) joined by a
file-format contract (`db.gz` + binary `idx/` packs + JSONL `data/` packs), not
an API. The unit tests exercise each side in isolation (the frontend ones mock
`./data` entirely). These e2e tests close the gap: they run the **real `srrb`
binary** to write packs from canned feeds, then read them back with the **real
frontend code** — catching writer↔reader drift (idx layout, pack-split math,
`data_tog` toggle, dedup/watermark, JSONL keys) that neither side's unit tests
can see.

## Layers

| Layer | Dir | Runner | Speed | Runs in |
|---|---|---|---|---|
| **contract** | `contract/` | vitest + jsdom | fast (~1s) | `make verify`, `make test-contract` |
| **browser** | `browser/` | vitest + Puppeteer (headless Chrome) | slower (~30s, builds the bundle) | `make test-browser`, `make test-e2e` |

- **contract** drives the real `idx.ts`/`data.ts`/`nav.ts` directly for
  exhaustive byte-level assertions (every chronIdx, pack splits, dedup, filter
  math), via a `fetch` shim that serves the on-disk pack bytes.
- **browser** builds the real production bundle and drives it in headless Chrome
  against real packs — proves the Parcel build, `app.ts` render, hash routing,
  and real-browser `fetch`/`DecompressionStream` work, not just the modules.

## Run

```bash
make test-contract   # fast layer (also part of `make verify`)
make test-browser    # headless-browser layer
make test-e2e        # both
# or directly (after `make build-be`):
cd frontend && SRR_BIN=../dist/srrb npm run test-contract
```

`$SRR_BIN` points at the `srrb` binary (the Makefile sets `../dist/srrb`); if
unset/missing the harness builds it on demand from `backend/`. The browser layer
needs the Chromium under `~/.cache/puppeteer/` (installed with `puppeteer`).

## Shared pieces

- `harness.ts` — `srr()` (run the binary; async so the in-process feed server can
  answer the child's fetch), `feedServer()` (canned RSS over HTTP), `makeStore()`,
  `inspectValidate()`.
- `fixtures.ts` — RSS builders; `nItems(count, prefix, pad?, startIdx?)` builds
  deterministic items — pass a distinct `startIdx` per channel so their published
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
- A >50k-article multi-*idx*-pack case is too slow for the default run; add it as
  a `describe.skip` stub if you need to exercise idx-pack continuity.
