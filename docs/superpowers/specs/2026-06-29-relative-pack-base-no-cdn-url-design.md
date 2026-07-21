# Relative pack base when no `cdn-url` is defined

**Date:** 2026-06-29
**Status:** Approved (pending spec review)

## Problem

The frontend bundle bakes an **absolute** pack base (`SRR_CDN_URL`) at build time.
`resolve-cdn-url.js` resolves it as `$SRR_CDN_URL` env → config `cdn-url:` →
fallback `http://localhost:3000`, and `base.ts` turns it into
`PACK_BASE = new URL(SRR_CDN_URL, window.location.href)` — the URL every pack
fetch (`data.ts`) and the content-URL bounds check (`fmt.ts`) resolve against.

Because the base is absolute, a reader bundle is pinned to one origin even when
it is meant to be **co-located with its store** — the self-hosted frontend shell
(`srr frontend update`) installs the SPA into the store root next to `db.gz`,
yet still fetches packs from the baked absolute origin. There is no way to say
"the store is right here, next to `index.html`".

## Goal

When **no `cdn-url` is defined** (no `SRR_CDN_URL` env and no config `cdn-url:`),
the built reader resolves packs **relative to its own `index.html` directory**.
The self-hosted shell then renders *and* fetches packs from whatever store root
it is dropped into — origin-portable, no rebuild per host.

Non-goals: backend `SRR_CDN_URL` consumers (`SyncOutFeeds`, asset self-hosting)
are unchanged; the dev pack server (`make dev-fe`) stays cross-origin
`localhost:3000`; the GitHub **Pages** hosted reader keeps its absolute
`cdn-url` (reader and CDN are different origins there).

## Approach

Bake `"."` as the no-cdn-url fallback. `base.ts` is unchanged:
`new URL(".", window.location.href)` already yields the directory containing
`index.html` (ending in `/`), which is exactly what `PACK_BASE` must be.
Relativity falls straight out of the single expression already there — no
runtime branch, no second concept.

Rejected alternatives:
- **Sentinel `""` + branch in `base.ts`** (`SRR_CDN_URL ? … : new URL(".", …)`):
  adds a concept and a branch for no gain over `"."`.
- **Drop the global / derive base another way**: over-scoped refactor.

## Changes

### 1. Frontend build resolution — `frontend/parcel/resolve-cdn-url.js`
Replace the `|| "http://localhost:3000"` fallback with `|| "."`. Update the
leading comment: the fallback is no longer "the dev pack server's default" (dev
sets `SRR_CDN_URL` explicitly via the `serve` script in `package.json`), it now
means **relative / same-origin** — the store sits next to `index.html`.

`transformer-define.js` and `base.ts` are untouched: the transformer substitutes
the `"."` literal; `PACK_BASE = new URL(".", window.location.href)` becomes the
`index.html` directory.

**Data flow (no-cdn-url build):**
`resolve() → "."` → transformer inlines `SRR_CDN_URL → "."` →
`PACK_BASE = new URL(".", location.href)` = e.g. `https://any-host/store/` →
`data.ts` fetches `new URL("db.gz", PACK_BASE)` = `https://any-host/store/db.gz`;
`fmt.ts` bounds-checks asset URLs against that same directory prefix. Identical
mechanics to today — only the origin is now wherever the page is served.

### 2. Released self-hosted bundle — `.github/workflows/release.yml` (`release` job)
Drop `SRR_CONFIG_INLINE` from the **`release`** job so its `make build-fe`
(which produces `srrf.tar.gz`, the asset `srr frontend update` downloads) falls
through to the relative fallback — the published shell becomes origin-portable.
Update the step comment that currently says it "bakes the configured absolute
cdn-url". `make release` (backend cross-compile) does not use `SRR_CONFIG_INLINE`,
so the job-level env can be removed cleanly.

The **`pages`** job is left untouched: GitHub Pages hosts the reader at one
origin while packs live on a separate CDN origin, so it must keep the absolute
`cdn-url` from `SRR_CONFIG_INLINE`.

### 3. Docs
- Root `CLAUDE.md`: the self-hosted-shell paragraph says the published bundle
  "keeps its build-time absolute `SRR_CDN_URL` for pack fetches" — change to:
  built with **no** cdn-url, so its pack fetches are **relative** and it renders
  from any store root.
- `frontend/CLAUDE.md`: the resolution chain "→ fallback `http://localhost:3000`"
  becomes "→ fallback `"."` (relative to `index.html`; the dev server sets
  `SRR_CDN_URL` explicitly)".

## Testing

Rely on existing coverage (no new test):
- `boot-smoke` (in `verify-fe`) asserts the bare `SRR_CDN_URL` token was replaced
  by *a* literal — `"."` passes it.
- Contract/unit tests define their own `SRR_CDN_URL` via vitest, so they are
  unaffected by the build-resolution fallback.
- `fmt.bounds.test.ts` already exercises a sub-path directory-style `PACK_BASE`,
  the same shape a relative-resolved base takes.
- The SW is already origin-agnostic (`sw.ts`: "no SRR_CDN_URL, so it works under
  any cdn-url prefix") and `manifest.webmanifest` `start_url`/`scope` are `"."`.

`make verify` must stay green.

## Risk / edge notes
- The only build path that previously hit the `localhost:3000` fallback was
  `parcel build` with no env and no config `cdn-url` (production). `parcel serve`
  always sets `SRR_CDN_URL`, so dev is unaffected.
- A build *with* a config `cdn-url:` (prod deploys via `srr-deploy`, the Pages
  job) is unchanged — the absolute value still wins over the fallback.
