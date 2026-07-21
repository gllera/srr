# Move the admin webui into the reader; `srr serve` becomes API-only

- **Date:** 2026-06-29
- **Status:** Design — awaiting review
- **Branch context:** `feat/cdn-auth`

## Motivation

Today the SRR admin GUI is hand-written vanilla `app.js`/`app.css`/`index.html` living in
`backend/webui/`, `//go:embed`'d into the `srrb` binary and served by `srr serve` over
loopback alongside the JSON API. The goal is **separation of concerns**: the Go backend
should be *just Go + a JSON API*; all web UI should live in the frontend project. Deploy and
DX specifics are secondary to that cleanliness goal.

## Decisions (locked)

1. **`srr serve` serves only the API.** The embedded webui and the root file server are removed.
2. **The admin UI becomes a view inside the reader SPA**, reached from a new **"Admin"** entry in
   the reader's existing **config surface** (`config.ts`, the "settings + nav hub").
3. **In-reader lazy route.** The admin module is code-split (dynamic `import()`) so it is not in
   the initial reader download, but it ships in the deployed reader build.
4. **Deployed reader too.** The Admin button must work from `https://dev.llera.eu/srr`, calling the
   operator's local `srr serve` at `http://localhost:8088`.
5. **No auth.** The mutating API stays open; its only gates are the loopback bind plus a CORS
   origin allowlist. (Revisit under `feat/cdn-auth` if remote/network exposure is ever wanted.)

## Non-goals

- No bearer token / shared-secret auth (explicitly deferred).
- No network exposure of the API: it stays **bound to loopback**. "Deployed reader too" means an
  HTTPS *page* calling `http://localhost` on the **same machine as the browser**, not the API
  listening off-box.
- No rewrite of the reader's design system onto the admin UI. The ported admin styles stay
  self-contained for now; harmonizing with `tokens.css` is a later, optional step.
- No change to the reader↔pack (CDN) data path.

## Architecture

### Backend — `srr serve` → API-only

**Remove:**
- `backend/webui/` (the three tracked files: `app.js`, `app.css`, `index.html`).
- `//go:embed webui`, `webuiFS`, `minifiedWebUI()`, and the `mux.Handle("GET /", …)` file server
  in `cmd_serve.go`. The startup banner copy changes from "SRR admin GUI at …" to an API-server
  message (the GUI now lives in the reader).

**Replace the origin half of `hostGuard` with a CORS layer:**
- **Keep** the loopback **Host** check (`loopbackHost`) — anti-DNS-rebinding; the API remains
  loopback-bound, so nothing off-box can reach it regardless of CORS.
- **Drop** the blanket "reject any cross-origin Origin" rule.
- Add a configurable **origin allowlist** via `SRR_SERVE_ORIGINS` (comma-separated). Default
  includes `http://localhost:1234` (parcel dev). The operator adds `https://dev.llera.eu`.
- For an allowlisted `Origin`, the response carries:
  - `Access-Control-Allow-Origin: <echoed origin>` (never `*`)
  - `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type`
  - `Vary: Origin`
- **Preflight:** answer `OPTIONS` for the mutating routes (PUT/DELETE, and POST with a JSON body)
  with the headers above plus, when the preflight carries
  `Access-Control-Request-Private-Network: true`, the response header
  `Access-Control-Allow-Private-Network: true` (Chrome Private Network Access).
- A non-allowlisted Origin gets no CORS headers → the browser blocks the call (server need not
  hard-reject, but may; behavior is covered by tests).

**Unchanged:** all 15 `/api/*` handlers and their semantics, the `--interval` background fetch
loop, the 409-on-lock contract, JSON error mapping.

### Frontend — admin as an in-reader lazy route

**New module** `frontend/src/js/admin/` (port of `backend/webui/app.js`):
- Ported to TypeScript, reusing the generated wire types in `format.gen.ts` for API payloads.
  The port can start near-verbatim and be tightened incrementally; correctness parity with the
  current admin GUI is the bar, not idiomatic rewrite.
- Its CSS (port of `app.css`) is bundled with the module so the lazy chunk is self-contained.

**Configurable API base URL:**
- The admin view targets a base URL (default `http://localhost:8088`), **persisted in
  localStorage** and **editable in the admin view**. Required because the admin is no longer
  same-origin with the API. All admin `fetch()` calls become absolute against this base
  (replacing today's relative `/api/...` and `window.location = "/api/export"`).

**Router + surface integration (`app.ts`):**
- Add a fourth surface to the `view` state machine: `"list" | "reader" | "config" | "admin"`.
- Add a hash route (e.g. `#admin`) handled in `route()`; `showAdmin()` performs the dynamic
  `import()` of the admin module on first open, mounts it into a host element, and toggles the
  body view class. Closing returns to the config/list surface like the other surfaces.

**Config surface entry (`config.ts`):**
- Add an **"Admin"** action button in the settings box (`.srr-config-settings`, alongside
  backup / image-proxy), wired through a new `ConfigHooks.openAdmin` hook that `app.ts` binds to
  `showAdmin()`.

**Markup/skeleton:** add an `.srr-admin` host surface to `index.html` and the corresponding body
view class to `styles.css`/`tokens.css`, following the existing `.srr-config` pattern.

## Security model

| | Today | After |
|---|---|---|
| API network reachability | loopback bind | loopback bind (unchanged) |
| Who may script the API | same-origin only (cross-origin rejected) | allowlisted web origins (e.g. `https://dev.llera.eu`, localhost dev) |
| Auth | none (same-origin + loopback) | none (CORS allowlist + loopback) |

**The deliberate relaxation:** we let a remote web origin (`dev.llera.eu`) drive the local
mutating API (delete feeds, trigger fetch, import OPML). Off-box attackers still cannot reach the
loopback API. The residual risk is content served from an allowlisted origin — i.e. an XSS on
`dev.llera.eu` would inherit the ability to call the local admin API. Accepted for a
single-operator, self-owned static site. The origin allowlist is the control; keep it tight.

## Browser compatibility caveats (accepted)

- **Safari** does not treat `http://localhost` as a secure context the way Chrome/Firefox do and
  will likely block the HTTPS-page → `http://localhost` request as mixed content. **Deployed-reader
  admin is effectively Chrome/Firefox only.** Safari operators must run the reader locally.
- **Chrome Private Network Access** is tightening toward a user permission prompt for
  public→loopback requests. The `Access-Control-Allow-Private-Network` handling covers today's
  behavior; future Chrome may add a prompt or stricter rules. This path is the most exposed to
  browser change.
- The admin only works when the **browser and `srr serve` are on the same machine** (localhost is
  the browser's own host). Opening dev.llera.eu on a phone won't find a local API — expected.

## Testing

**Backend** (`cmd_serve_test.go`, `serve_*_test.go`):
- Allowlisted origin → correct CORS headers on a real API call.
- OPTIONS preflight for a mutating route → methods/headers + `Access-Control-Allow-Private-Network`
  echoed when requested.
- Non-allowlisted origin → no CORS headers.
- Loopback Host guard still rejects non-loopback Host.
- Removal regressions: `GET /` no longer serves the UI (404 / API-only behavior).

**Frontend:**
- Admin module unit tests mirroring existing patterns (e.g. `nav.test.ts` style): API base URL
  resolution/persistence, request construction against the base, render of feeds/recipes/
  syndicate/tools tabs, error/lock (409) handling.
- Router test: Settings → Admin opens the admin surface; lazy import is invoked; close returns.

**Full gate:** `make verify` (lint + format + test + build both projects + e2e contract) must pass.

## Migration / rollout

- The change is self-contained to `srr serve` + the reader frontend; the pack/CDN data contract is
  untouched, so deployed readers and stores need no migration.
- `srr serve` operators must set `SRR_SERVE_ORIGINS` to include the reader origin they use
  (`https://dev.llera.eu` and/or `http://localhost:1234`) and point the admin view's API base URL
  at their local `srr serve`.

## Open risks

- Future Chrome PNA permission-prompt changes could degrade or break the deployed-reader path; the
  local-reader path is the durable fallback.
- Porting ~620 lines of vanilla `app.js` to TS is the bulk of the work; SSE (`/api/fetch`),
  OPML import/export (binary/text bodies, `window.location` download), and the preview `srcdoc`
  sandbox are the fiddly spots to preserve faithfully.
