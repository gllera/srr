# `srr frontend update` — design

**Date:** 2026-06-29
**Status:** approved (pending spec review)

## Problem

The SRR store (e.g. `~/public` on gateway, served at `dev.llera.eu`) holds the
data contract — `db.gz` + `idx/`/`data/`/`meta/`. The reader SPA is **not** in
the store: it is deployed separately to GitHub Pages by `release.yml`'s `pages`
job. There is no way to host the reader from the same origin as the packs, and
no backend mechanism to push a frontend build into a store.

We want a backend command that pulls the latest prebuilt SPA from GitHub and
uploads it into the store root, so one static origin serves both the reader and
the packs — and that cleans up the previous version's files on upgrade (the SPA
uses content-hashed filenames, so old hashes orphan on every build).

## Goals

- A backend command that downloads the latest frontend bundle from a GitHub
  Release and uploads every file into the store root (next to `db.gz`).
- Track uploaded files in a `sitemap.txt` manifest at the store root, used on the
  next upgrade to delete files the new version no longer ships.
- **No dangling files on failure.** A crash or error at any point must never leave
  an untracked file in the store: the manifest is always a superset of what is
  present, so the next run reconciles the store back to exactly the current
  version's files. (See the no-dangling invariant under Command behavior.)

## Non-goals

- No version-skip / "already up to date" short-circuit. `update` is a manual,
  rare operation over small files; it always downloads → uploads → cleans
  (overwrite is harmless). The deployed version is logged.
- Does not touch the fetch loop, `db.gz`, or the pack series.
- Does not change how the frontend resolves its pack base URL: the published
  bundle keeps its build-time absolute `SRR_CDN_URL` (decision below).

## Decisions (settled with the user)

1. **Source = a GitHub Release asset.** Add a flat `srrf.tar.gz` to the release.
   The backend downloads the latest release's tarball over plain HTTPS (no auth
   needed for a public repo). Matches how binaries are already published and how
   `cron.yml` consumes releases; gives an exact file list for `sitemap.txt`.
2. **Pack base = keep configured absolute URL.** The bundle keeps whatever
   absolute `SRR_CDN_URL` it was built with (the release build uses the project's
   configured `cdn-url`). Asset references in `index.html` are already **relative**
   (`publicUrl: "."`), so the bundle renders from any store root; only the pack
   base is absolute, pointing back at the production CDN/store.
3. **Command = `srr frontend update`** (group `frontend`, alias `fe`), leaving
   room for future subcommands.

## CI change — publish the SPA as a release asset (`release.yml`)

The `release` job (runs on `v*.*.*` tag push, after `verify`) gains a frontend
build + package step:

- Build the frontend: `make build-fe` with `SRR_CONFIG_INLINE` (the existing
  secret already used by the `pages` job) so the bundle bakes the configured
  absolute `cdn-url`. (The job's `setup-toolchain` must enable Node — today it
  sets `node: "false"`.)
- Package flat: `tar czf srrf.tar.gz -C dist/srrf .` — tar entries are
  `index.html`, `frontend.<hash>.css`, `frontend.<hash>.js`, `sw.<hash>.js`,
  `manifest.webmanifest`, icons — **no leading directory**, so each entry name is
  the store key.
- Attach: add `srrf.tar.gz` to the `softprops/action-gh-release` `files:` list
  next to `dist/srr-*`.

Every tagged release then carries the SPA as `srrf.tar.gz`.

## Command behavior (`backend/cmd_frontend.go`)

New `FrontendGroup` registered in `main.go`'s `CLI` struct (`Frontend
FrontendGroup` with `cmd:"" aliases:"fe"`), containing `Update UpdateCmd`.

Flags on `UpdateCmd`:

| Flag | Default | Env | Meaning |
|---|---|---|---|
| `--repo` | `gllera/srr` | `SRR_FE_REPO` | Source GitHub repo (`owner/name`). |
| `--tag` | _(empty → latest)_ | — | Pin a specific release tag. |

Steps:

1. **Open store.** `store.Open(ctx, globals.Store)` directly — no `db.gz` lock
   (frontend files are orthogonal to packs/db.gz; taking the lock would needlessly
   block the fetch loop). `defer backend.Close()`.
2. **Resolve release.** GitHub API `GET https://api.github.com/repos/<repo>/releases/latest`
   (or `/releases/tags/<tag>`). Parse `tag_name` and find the asset named
   `srrf.tar.gz` → `browser_download_url`. Unauthenticated request (the repo is
   public; the unauthenticated rate limit is ample for a manual, rare command).
   The API base URL is a package var (`githubAPIBase`) so tests can point it at
   `httptest`. Missing release/asset → hard error.
3. **Download + extract (read-only).** GET the `browser_download_url` fully into
   memory, then `compress/gzip` + `archive/tar` → `newFiles` (`map[key][]byte`).
   Collect **regular-file** entries only. Reject any unsafe entry name — absolute,
   containing `..`, or containing `/` (the bundle is flat) — as a hard error
   (defense against a malformed/hostile tarball). The sanitized entry name is the
   store key. The whole tarball is materialized before any store write, so a
   truncated/corrupt download fails here with the store **untouched**.
4. **Read old manifest.** `backend.Get(ctx, "sitemap.txt", true)` (ignore-missing)
   → `oldKeys` set. `newKeys` = the keys of `newFiles`.
5. **Write the PENDING manifest** = `sorted(oldKeys ∪ newKeys)` via `AtomicPut`
   (ContentType `text/plain`), **before any upload or delete**. This records every
   file that is about to exist, so even a half-finished upload is already tracked.
6. **Upload.** For each file, `backend.AtomicPut(ctx, key, bytes, store.ObjectMeta{ContentType: mimeForKey(key)})`.
   Upload all non-`index.html` files first and `index.html` **last**, so a reader
   loading mid-update never sees a new `index.html` referencing a not-yet-uploaded
   asset. `AtomicPut` is required (not `Put`): S3's writer defaults Content-Type to
   `application/octet-stream` when no `ObjectMeta` is supplied, which would make
   the browser download `index.html`/`.css`/`.js` instead of rendering them.
   (`local`/`sftp` ignore `ObjectMeta` — the static server sets types by
   extension — so prod nginx is unaffected either way.) **On any upload error:
   abort with that error** — do not delete orphans, do not rewrite the manifest.
   The old version's files are still present and still tracked by the pending
   manifest, so the old reader keeps working and the next run finishes the job.
7. **Cleanup orphans.** `backend.Rm` every key in `oldKeys − newKeys` (Rm is
   silent on missing). Collect any key whose `Rm` *errored* into `failedDeletes`
   and log each at WARN — a failed delete is non-fatal (best-effort, like the GC
   sweeps).
8. **Commit final manifest** = `sorted(newKeys ∪ failedDeletes)` via `AtomicPut`.
   In the happy path `failedDeletes` is empty, so the manifest collapses to exactly
   the live file set; an orphan that resisted deletion stays tracked for the next
   run to retry, never dropped.

**No-dangling invariant.** At every point a writer could be interrupted,
`sitemap.txt` is a **superset of the frontend files actually present** in the
store root:

- The pending manifest (step 5) is written *before* any file is uploaded, so each
  file created in step 6 is already listed.
- The final manifest (step 8) lists `newKeys` plus any orphan still present
  because its delete failed — never fewer files than exist.

Therefore no frontend file is ever untracked. Any crash — mid-download (store
untouched), mid-upload, or mid-cleanup — is fully reconciled by the next run:
it reads the (superset) manifest as `oldKeys`, and `oldKeys − newKeys` then
covers every leftover file from the interrupted run, including partially-uploaded
files of an abandoned version and orphans of any prior version. `AtomicPut`'s
temp-then-rename (local/SFTP) / single-object overwrite (S3) guarantees the
manifest itself is never observed half-written. This is the same "publish the
consistency root last, and only widen coverage before mutating" discipline the
store already uses for `db.gz`/summaries.

`mimeForKey(key)` = `mime.TypeByExtension(path.Ext(key))` with deterministic
overrides for the web-critical types so the result never depends on the host's
mime database: `.html`→`text/html; charset=utf-8`, `.css`→`text/css; charset=utf-8`,
`.js`→`text/javascript; charset=utf-8`, `.svg`→`image/svg+xml`,
`.webmanifest`→`application/manifest+json`, `.txt`→`text/plain; charset=utf-8`.
Unknown extensions fall back to `application/octet-stream`.

## Content-Type & Cache-Control (`store/main.go`)

- **Mandatory** (S3 correctness): per-file Content-Type via `AtomicPut` +
  `ObjectMeta`, handled in step 4.
- **Optional polish** — extend `cacheControlForKey` for store-root frontend
  files (only affects S3; local/SFTP ignore it). Cases:
  - `index.html`, `manifest.webmanifest`, `sitemap.txt` → `cacheRevalidate`
    (mutable entry point / manifests, rewritten on each upgrade).
  - Root-level content-hashed assets matching `^[^/]+\.[0-9a-f]{8,}\.[a-z0-9]+$`
    → `cacheImmutable` (hash changes per build, so safe to cache forever).
  These cases sit after the existing `db.gz`/`out/`/`assets/`/pack cases and
  before the default; they only match root-level keys (no `/`), so they can't
  collide with pack keys. Recommended (low-risk, completes the feature for S3
  hosters).

## Tests (`backend/cmd_frontend_test.go`)

Drive an `httptest` server returning release JSON + a synthetic `srrf.tar.gz`,
against a `local` store in a temp dir (`githubAPIBase` pointed at the test
server). Assert:

- Files land at the store root with correct bytes.
- `sitemap.txt` lists exactly the uploaded keys (sorted) after a clean run.
- A pre-seeded old `sitemap.txt` whose entries include now-removed files: the
  orphans get deleted, shared files survive, new files appear.
- **No-dangling across a crash.** Pre-seed the store to mimic an interrupted run
  (a pending manifest = old∪V2-partial, plus some V2 files present), then run an
  update to V3 and assert the store ends with **exactly** V3 + `sitemap.txt`
  (every V2 partial and old-version file gone).
- **Upload failure aborts cleanly.** Inject a store whose `AtomicPut` fails on a
  chosen new key: assert the command errors, the old files + the pending
  superset manifest remain (old reader still intact), and no orphan was deleted.
- **Failed delete stays tracked.** Inject a store whose `Rm` fails for one
  orphan: assert the command still succeeds, the orphan remains, and the final
  `sitemap.txt` still lists it (so the next run retries).
- Unsafe tar entries (`../x`, `/abs`, `a/b`) are rejected with an error.
- `--tag` resolves `/releases/tags/<tag>`.
- Unit cases for `mimeForKey` and the new `cacheControlForKey` branches.

## Files touched

- `backend/cmd_frontend.go` (new) — `FrontendGroup`, `UpdateCmd`, GitHub resolve
  + download/extract, upload, sitemap diff/cleanup, `mimeForKey`, `githubAPIBase`.
- `backend/cmd_frontend_test.go` (new) — tests above.
- `backend/main.go` — register `Frontend FrontendGroup` in `CLI`.
- `backend/store/main.go` — extend `cacheControlForKey` (optional polish).
- `.github/workflows/release.yml` — build + attach `srrf.tar.gz`.
- `backend/README.md` / `backend/CLAUDE.md` / root `README.md` — document the
  command and the new release asset.
