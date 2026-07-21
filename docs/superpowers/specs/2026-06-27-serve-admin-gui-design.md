# `srr serve` — local web admin GUI for feed/recipe/syndicate management

**Date:** 2026-06-27
**Status:** Approved (design) — implementation plan to follow
**Scope:** `backend/` only. New `cmd_serve.go` (the `ServeCmd` kong subcommand: server, routing, embed, Host guard, graceful shutdown), `serve_feeds.go`, `serve_recipes.go`, `serve_tools.go` (fetch/preview/inspect/opml/gen handlers), and an embedded `webui/` asset bundle (`index.html`, `app.js`, `app.css`) served via `//go:embed`. Small extract-to-shared-function refactors of existing `cmd_feeds.go` / `cmd_recipe.go` / `cmd_syndicate.go` / `cmd_fetch.go` so the CLI command and the API handler call one function. New `cmd_serve_test.go` (+ per-area test files). One line in `main.go`'s `CLI` struct. No frontend (reader SPA) changes. No data-contract / pack-format changes.

## Problem

Managing an SRR store today is entirely CLI-driven: `srr feed add/upd/rm/ls/show/edit/apply/import/export`, `srr recipe set/ls/show/rm`, `srr syndicate set/ls/rm`, `srr art fetch`, `srr gen`, `srr preview`, `srr inspect`. Each is a separate invocation with its own flags; bulk feed grooming (retitle, retag, repoint URLs, swap recipes), spotting unhealthy feeds, and trying a recipe against a URL all mean stitching commands together by hand. There is no single view of "all my feeds, their tags, their health" and no point-and-click way to edit them.

The backend already proves the pattern needed to fix this: `srr preview` (`cmd_preview.go`) spins up a localhost `net/http` server and renders an HTML page from the binary. The same shape — a local, on-demand HTTP server that serves an embedded UI and a small JSON API over the existing in-process DB operations — turns the whole management surface into a web GUI without touching the data contract or adding runtime dependencies.

## Goals

- A new `srr serve` subcommand: a localhost, on-demand HTTP server that serves an embedded single-page admin UI plus a JSON API, managing whichever store the standard `-o/--store`/config resolution selects (dev local dir, prod R2, SFTP — no special-casing).
- Cover the full management surface the operator asked for: **feeds CRUD + tags**, **trigger fetch**, **recipes** (with inline preview), **syndicate**, **OPML import/export**, **gen show/bump**, and **inspect** (validate + from-hash).
- Reuse existing in-process logic — handlers call the same functions the CLI commands do, so GUI and CLI can never diverge. No shelling out to `srr`.
- Zero new runtime dependencies and zero build step: the UI is hand-written HTML/CSS/vanilla-JS embedded via `//go:embed`, shipped inside `srrb`.
- Strict per-action locking (see Locking Contract): the server holds no persistent store lock and keeps no open DB handle between requests.
- Safe by default: binds `127.0.0.1`, never `0.0.0.0`; a Host/Origin allowlist guard blocks cross-origin/DNS-rebinding access to the mutating API.

## Non-goals

- **No authentication.** This is a local admin tool reached over loopback (directly on the box, or via an SSH/openvscode tunnel), consistent with `srr preview`. The Host guard is anti-CSRF hardening, not auth.
- **No persistent/hosted service.** Not behind the Cloudflare tunnel, no systemd unit, no public route. It is started on demand and stopped when done.
- **No data-contract or pack-format change.** Read/write paths are exactly the existing ones.
- **No reader-SPA changes.** The admin UI is independent of `frontend/`; it does not reuse the Parcel/TS toolchain or the reader's Puppeteer harness.
- **No new auto-`--force`.** Lock contention is surfaced, never bulldozed.

## Architecture

`ServeCmd` is a kong subcommand registered in `main.go`'s `CLI` struct next to `Preview`:

```go
Serve ServeCmd `cmd:"" help:"Serve a local web admin GUI for managing feeds, recipes, syndication."`
```

Flags:

| Flag | Default | Env | Purpose |
|---|---|---|---|
| `-a`/`--addr` | `localhost:8088` | `SRR_SERVE_ADDR` | Listen address. (`preview` owns `8080`.) |

`--store` and all config resolution are inherited from `Globals`, identical to every other command — so *which* store the GUI manages is the existing `-o/--store`/`SRR_STORE`/config-file mechanism, nothing new.

`Run()`:
1. Builds an `http.ServeMux`.
2. Registers the embedded UI at `/` (serves `index.html`/`app.js`/`app.css` from the `//go:embed`ed `webui` FS).
3. Registers the JSON API handlers under `/api/…`.
4. Wraps the whole mux in the **Host-guard middleware** (rejects requests whose `Host`/`Origin` isn't loopback — see Security).
5. `http.ListenAndServe` on `--addr`, with `signal.NotifyContext` graceful shutdown (mirroring `cmd_fetch.go`'s shutdown pattern) so Ctrl-C drains cleanly.

```
browser ──HTTP──> srr serve (127.0.0.1:8088)
                    │  [Host-guard middleware]
                    ├── GET /                 → embedded index.html / app.js / app.css
                    └── /api/*                → JSON handler
                                                  → withDB(locked?)   (open → read → [write] → close)
                                                     → store (local fs / R2-S3 / SFTP)
```

There is no shared/global DB handle on `ServeCmd`. Every handler opens and closes its own `withDB`/`withDBCtx` scope per request (see Locking Contract).

### File layout (keep units small)

- `cmd_serve.go` — `ServeCmd` struct, `Run()`, mux assembly, Host-guard middleware, graceful shutdown, embedded-FS wiring, shared JSON request/response helpers (`writeJSON`, `writeErr`, status mapping).
- `serve_feeds.go` — feed + tag handlers.
- `serve_recipes.go` — recipe handlers.
- `serve_tools.go` — fetch (SSE), preview, inspect, OPML import/export, gen, syndicate handlers. (Split further if it grows past ~300 lines.)
- `webui/index.html`, `webui/app.js`, `webui/app.css` — the embedded UI.
- `cmd_serve_test.go` (+ `serve_feeds_test.go`, `serve_recipes_test.go` as needed) — `httptest` handler tests.

### Reuse via extracted functions

Where a CLI `Run()` currently inlines logic, extract a plain function both the command and the handler call. Concretely:

- **Feeds** — most logic is already factored (`db.AddFeed/RemoveFeed/FeedByID/Feeds`, `normalizeFeed`, `feedView`, `setFeedURL`, `ingest.Resolve` via the `resolveFeedURL` seam, `applyFeeds`). Handlers call these directly. Extract any add/upsert glue still living in `AddCmd.Run`/`ApplyCmd.Run` into a shared `upsertFeed`/`applyFeeds` helper. The **list** endpoint needs a new read-only `feedListView` = `feedView` (id/title/url/error/tag/recipe) **plus** `fail_streak`/`last_ok`/`last_new`/`total_art`; writes (`POST`/`PUT`) accept only the writable `feedView` subset (title/url/tag/recipe), the health fields being server-owned.
- **Recipes** — extract the set/validate/rm body out of `RecipeSetCmd.Run`/`RecipeRmCmd.Run` into `setRecipe(core, name, ingest, pipe)` / `removeRecipe(core, name)` (carrying `validatePipe`, the `default`/`#default` rules, and the "still referenced by a feed" rm guard) so both CLI and API share them.
- **Syndicate** — extract the upsert/rm body of `SyndicateSetCmd.Run`/`SyndicateRmCmd.Run` into `setOutFeed`/`removeOutFeed`.
- **Fetch** — refactor `FetchCmd.fetch` so the core fetch driver takes a feed filter (all, or one feed id) and reports per-feed progress + a final summary through a callback, callable from both the CLI and the SSE handler. The driver keeps owning the lock for the fetch's duration (it is a long read-modify-write).
- **Preview** — extract the ingest+`processItem` rendering loop from `PreviewCmd.Run` into a function returning `[]*Item` (or an error), so the API handler renders the same articles the CLI page does.
- **Inspect** — the report builders in `cmd_inspect_report.go`/`cmd_inspect_check.go` already produce structured data; the handler invokes them and serialises to JSON.

## Endpoints

All under `/api`. Read endpoints use `withDB(locked=false)`; mutations use `withDB(locked=true)` (see Locking Contract). Request/response bodies are JSON unless noted.

| Method | Path | Backed by | Lock |
|---|---|---|---|
| `GET` | `/api/feeds` | `db.Feeds()` → **extended** read view (`feedView` fields + read-only `ferr`, `fail_streak`, `last_ok`, `last_new`, `total_art`) | none |
| `POST` | `/api/feeds` | `upsertFeed` (create; subscribe-time `ingest.Resolve` discovery for `#feed` feeds) | write |
| `GET` | `/api/feeds/{id}` | `db.FeedByID` → `feedView` | none |
| `PUT` | `/api/feeds/{id}` | `upsertFeed` (full-replace update; `setFeedURL` preserves fetch state on unchanged URL) | write |
| `DELETE` | `/api/feeds/{id}` | `db.RemoveFeed` | write |
| `POST` | `/api/feeds/apply` | `applyFeeds` (single object or array; whole-input atomic) | write |
| `GET` | `/api/tags` | `groupFeedsByTag` mirror → `[{tag, count}]` | none |
| `GET` | `/api/recipes` | `core.Recipes` → `IRecipeWire`-shaped map | none |
| `PUT` | `/api/recipes/{name}` | `setRecipe` (validate; `#default` rules) | write |
| `DELETE` | `/api/recipes/{name}` | `removeRecipe` (refuses `default` + referenced names) | write |
| `GET` | `/api/syndicate` | `core.Out` → `IOutFeedWire[]` | none |
| `PUT` | `/api/syndicate/{name}` | `setOutFeed` (validate format/selectors/limit/feed-ids) | write |
| `DELETE` | `/api/syndicate/{name}` | `removeOutFeed` (+ best-effort `out/<name>.<ext>` delete) | write |
| `POST` | `/api/fetch` | fetch driver; `?feed=<id>` optional; **`text/event-stream`** progress (per-feed events + final summary) | fetch-held |
| `GET` | `/api/preview?url=&recipe=&pipe=&ingest=` | preview render loop → `[]Item` JSON | none |
| `GET` | `/api/inspect?mode=validate\|from-hash&hash=&…` | inspect report builders → JSON | none |
| `POST` | `/api/import` | OPML body (uploaded/pasted) → `cmd_import` walk; `?dry_run=1` previews | write (none for dry-run) |
| `GET` | `/api/export` | `cmd_export` → OPML download (`Content-Disposition`) | none |
| `GET` | `/api/gen` | `core.Gen` | none |
| `POST` | `/api/gen/bump` | `db.BumpGen` | write |

`GET /api/feeds`, `/api/recipes`, `/api/syndicate`, `/api/gen` are also fetched on page load to populate the UI.

## UI

A single embedded page. Top tab bar: **Feeds** (default) · **Recipes** · **Syndicate** · **Tools**. No framework; plain DOM + `fetch()`.

- **Feeds** — a table: `id · title · url · tag · recipe · health · article count · last-OK`. Top bar: tag filter (from `/api/tags`), text search (client-side over title/url), "Add feed" button, Import OPML, Export OPML. The **health** cell is a colored dot derived client-side from `feedView` fields (`ferr` and `fail_streak` move together — `ferr` is non-empty exactly when the last fetch failed, and `fail_streak` resets to 0 on any success): **green** = healthy (`ferr` empty), **amber** = failing but transient (`ferr` non-empty and `fail_streak < 3`), **red** = chronic failure (`ferr` non-empty and `fail_streak >= 3`), **gray** = never fetched (`last_ok == 0` and `ferr` empty). The `>= 3` cutoff is a tunable UI default. Tooltip shows the error text and last-OK time. Clicking a row opens an **edit modal** (title, url, tag, recipe-`<select>` populated from `/api/recipes`); "Add feed" opens the same modal empty. Save → `POST`/`PUT /api/feeds`; delete → confirm → `DELETE`. Validator errors (unresolvable URL on add/url-change, dangling recipe) are shown inline in the modal from the API's 400 body.
- **Recipes** — list of recipes; an editor with an `ingest` field and a repeatable **pipe-step** list (add/remove/reorder rows). Save → `PUT /api/recipes/{name}`; delete → `DELETE` (the API enforces the `default`/referenced guards, surfaced as errors). Inline **Preview**: a URL field + recipe selector → `GET /api/preview` → renders the processed articles (reusing the preview page's restrained article styling).
- **Syndicate** — list of out feeds; a form (name, format `rss`/`json`, title, tags, feed-ids, limit) → `PUT`/`DELETE /api/syndicate/{name}`.
- **Tools** — **Fetch**: "Fetch all" / "Fetch feed…" (id picker) → opens an SSE connection to `POST /api/fetch`, streaming a live log (per-feed line + final fetched/failed summary). **Gen**: shows `gen`, "Bump generation" button → `POST /api/gen/bump` (with a confirm, since it forces a SW cache purge for readers). **Inspect**: "Validate store" → `GET /api/inspect?mode=validate` report; a from-hash field → `GET /api/inspect?mode=from-hash&hash=…`.

Visual style: lean and functional, carried over from `cmd_preview.go`'s template — system sans font, `:root { color-scheme: light dark; }` for automatic dark mode, the SRR orange accent `#f26522` (the same favicon SVG), generous whitespace, no external assets. Everything is one `app.css`.

## Locking Contract

**The server holds no persistent lock and keeps no open DB handle between requests.**

- **Read-only actions** (`GET /api/feeds`, `/api/feeds/{id}`, `/api/tags`, `/api/recipes`, `/api/syndicate`, `/api/preview`, `/api/inspect`, `/api/export`, `/api/gen`, and `POST /api/import?dry_run=1`) → `withDB(locked=false)`: open store → read → close. **Never touches `.locked`.** These succeed even while the cron fetch loop holds the lock.
- **Mutating actions** (`POST/PUT/DELETE /api/feeds`, `/api/feeds/apply`, `/api/recipes/{name}`, `/api/syndicate/{name}`, `POST /api/gen/bump`, `POST /api/import`) → `withDB(locked=true)`: acquire `.locked` → read core → apply change → `Commit` → **release `.locked`**, entirely within that one request (milliseconds). The lock is released before the response is sent. There is no acquire-on-startup, no hold-across-requests, no release-on-shutdown.
- **One inherent exception — triggered fetch** (`POST /api/fetch`): the fetch driver holds the lock for the fetch's full duration, exactly as `srr art fetch` and the cron loop do, because a fetch *is* a long read-modify-write. This is the operation owning the lock, not the server idling on it.
- **Lock contention** with the cron `srrb-prod-fetch` loop: when a mutating action (or a triggered fetch) cannot acquire `.locked` because another process holds it, the handler returns **409 Conflict** with a clear message (`"store is locked by another srr process — the fetch loop may be running; try again"`). The GUI surfaces it as a dismissible banner. We never auto-`--force`.

So: lock → read → (write) → unlock, scoped to each action, acquired only when that action writes.

## Security

- **Bind loopback by default.** `--addr` defaults to `localhost:8088`; never `0.0.0.0`. (The flag permits other addresses for the operator who knowingly tunnels, same latitude as `preview`, but the default and docs are loopback-only.)
- **Host/Origin allowlist guard.** Because the API mutates, a malicious web page in the operator's browser could otherwise POST to `http://localhost:8088/api/...` (CSRF / DNS-rebinding). The middleware rejects (403) any request whose `Host` header is not a loopback host (`localhost`/`127.0.0.1`/`[::1]`, optionally `:port`), and any cross-origin request carrying a non-loopback `Origin`. Cheap, no real auth, blocks the browser-pivot attack.
- **No secrets in the UI or API.** Store credentials live in config/env (`store.Configs()`), are used server-side only, and are never sent to the browser. `srr config`-style secret values are out of scope for the GUI.

## Error handling

- Handlers return `{"error": "<message>"}` with a mapped HTTP status: **400** validation (bad recipe name, dangling recipe, unresolvable feed URL, bad syndicate selector), **404** unknown feed id / recipe / out name, **409** lock contention, **500** unexpected store/IO error. Messages come straight from the existing validators, so CLI and GUI report identically.
- The UI shows errors as an inline modal message (forms) or a top banner (global actions), never a silent failure.
- SSE fetch errors stream a terminal `event: error` with the message and close the stream.

## Testing

- `cmd_serve_test.go` (+ per-area files) drive the handlers with `httptest.Server`/`httptest.NewRequest` against a temp **local** store built with the existing `setupTestDB` helper:
  - Feeds: list (shape + health fields), add (offline via the `resolveFeedURL` seam — no real network), get, full-replace update (URL-unchanged preserves fetch state; URL-change resets it), delete, apply (object + array; atomicity on a bad element), tags.
  - Recipes: list, set (valid + `#default`-in-`default` rejection), delete (refuses `default` and referenced names).
  - Syndicate: list, set (format/selector/feed-id validation), delete.
  - Gen: show + bump (counter increments; resets `hdrs`/`mp`/`mt` via `BumpGen`).
  - OPML: import (dry-run preview + real) + export round-trip.
  - **Locking: 409 on contention** — pre-acquire `.locked`, assert a mutating handler returns 409 and a read handler still 200s.
  - **Security: Host guard** — a request with a non-loopback `Host`/`Origin` gets 403; a loopback one passes.
  - Error mapping: unknown id → 404, bad recipe → 400.
- The embedded static assets get a smoke test: `GET /` returns 200 `text/html` and the `//go:embed` FS contains `app.js`/`app.css`. Inspect/preview/fetch handlers are unit-tested at the JSON-contract level; the assembled UI is verified manually in a browser (`srr serve` against a dev store) — the admin UI is deliberately not coupled to the reader's Puppeteer e2e harness.
- `make verify-be` (vet + gofmt + build + test + `generate-check`) must stay green. No `format.gen.ts` change is expected (no data-contract atoms added).

## Decisions made (flag if you disagree)

- Default port **`8088`** (`preview` owns `8080`, `imagor` `8000`).
- Fetch progress over **SSE**, not a blocking request.
- A **Host/Origin allowlist** guard rather than full auth.
- **One spec, phased plan** (below) — the breadth is in panel/endpoint count, not architectural variety, so it stays a single coherent app.

## Build order (phased implementation plan)

Each phase is independently shippable and testable:

1. **Skeleton + Feeds.** `ServeCmd`, mux, `//go:embed` wiring, Host guard, graceful shutdown; `GET/POST/PUT/DELETE /api/feeds`, `/api/feeds/apply`, `/api/tags`; the Feeds tab (table, search, tag filter, add/edit modal, delete). Tests: feeds + tags + lock-409 + Host-guard. *Delivers the core ask.*
2. **Recipes + Preview.** Recipe CRUD endpoints + extracted helpers; `GET /api/preview`; the Recipes tab with the inline preview. Tests: recipe CRUD.
3. **Tools: fetch + the rest.** Refactor the fetch driver for filter+progress; `POST /api/fetch` (SSE); `/api/syndicate`, `/api/import`, `/api/export`, `/api/gen`, `/api/inspect`; the Syndicate + Tools tabs. Tests: syndicate, gen, OPML round-trip, fetch driver filter.
