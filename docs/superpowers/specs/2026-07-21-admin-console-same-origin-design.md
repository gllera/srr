# Admin console — retire `backend/webui/`, build the admin UI in the frontend project, keep it same-origin

**Date:** 2026-07-21
**Status:** Design — awaiting review
**Supersedes:** [`2026-06-29-admin-ui-into-reader-design.md`](2026-06-29-admin-ui-into-reader-design.md)
**Plan step:** S39 of `FINDINGS-PLAN.md` (from ARC8/FE-R4); implementation is S40. Rides
[SEC3](../../FINDINGS-2026-07-20.md#sec3) (admin origin ships no security headers).

## Why this supersedes rather than edits

The 2026-06-29 spec was written for a deployment that no longer exists: `srr serve` on the
operator's own machine, bound to loopback, unauthenticated, driven from an HTTPS reader page
in the *same browser on the same box*. Every load-bearing decision in it (`SRR_SERVE_ORIGINS`
CORS allowlist, a localStorage-editable API base URL, Chrome Private Network Access preflight
headers, "Safari operators must run the reader locally") is an artifact of that assumption.
Under the current topology the assumption is gone, and so is the conclusion. Patching it in
place would leave a document whose skeleton argues for the opposite outcome, so it is
superseded whole; that file now carries a one-line pointer here and is otherwise frozen.

### Staleness ledger — what the old spec asserts that is no longer true

| Old spec says | Reality (2026-07-21) |
|---|---|
| "No auth. The mutating API stays open; its only gates are the loopback bind plus a CORS origin allowlist." | `srr serve` runs 24/7 on **dmz** (public Oracle Cloud VM) as the `srr-fetch` user unit — admin GUI **and** the 5-min fetch loop in one process — published at **`admin-srr.llera.eu`** behind **Cloudflare Access**, through the dmz tunnel with `originRequest.httpHostHeader = localhost:8088`. It is authenticated, public-facing, and it is the store's *only writer*. |
| "The Admin button must work from `https://dev.llera.eu/srr`" | The reader is at **`srr.32b.io`** (auth-gated reverse proxy via the 32b Pages project); packs come from `cdn.llera.eu`, whose R2 CORS allowlist must name `https://srr.32b.io`. `dev.llera.eu/srr` is a stale static mirror. |
| "reached from a new **Admin** entry in the reader's existing config surface (`config.ts`)" | `config.ts` **does not exist**. The config surface was retired: the filter picker became a fixed overlay (`picker.ts`) and the rest became an anchored settings context menu built by `dropdown.ts` (`settingsMenuItems()` in `app.ts`). The reader's `view` state machine is `"list" \| "reader"` — there is no third surface to extend. |
| "Add a fourth surface to the `view` state machine … `.srr-config-settings` … `ConfigHooks.openAdmin`" | None of those identifiers exist. |
| "all 15 `/api/*` handlers" | **17** routes in `registerAPI` (`cmd_serve.go:279-297`); `GET /api/export` additionally gained `?format=json` (the lossless whole-configuration document). |
| "the API remains loopback-bound, so nothing off-box can reach it regardless of CORS" | The tunnel connector reaches it and publishes it to the internet. The loopback **bind** is now a deployment detail of the connector hop, not a security boundary. |
| Chrome Private Network Access / `Access-Control-Allow-Private-Network` / Safari mixed-content caveats | Entirely moot: no browser talks to `http://localhost` any more. |
| "The residual risk is … an XSS on `dev.llera.eu`" | Still the right risk to reason about, but its weight changed: the reader now renders untrusted feed HTML in its main DOM against a *public, always-on, lock-holding writer*, not a local scratch process. See §2. |

Two things in the old spec **survive** and are re-adopted here: the goal (the Go backend should
be Go + a JSON API; all web UI belongs to the frontend project) and the bundle rule (a
reader-only user must download zero admin bytes).

## Goal

Retire the hand-written vanilla `backend/webui/{app.js,app.css,index.html}` (1328 + 1272 + 43
lines, `//go:embed`'d and minified at process startup) and rebuild the admin console in the
frontend project — TypeScript, Parcel, `tokens.css`, the reader's dialog/menu primitives, the
generated wire types in `format.gen.ts` — without weakening the trust boundary that the Access
deployment created.

## Non-goals

- **No in-reader admin surface.** The admin console does not become a view of the reader SPA
  and the reader's ⋯ settings menu gains no "Admin" entry (see §3 — a cross-origin link that
  only the operator can open, behind an Access login, is noise on every other device). It is
  reached by its own bookmark: `https://admin-srr.llera.eu/`.
- **No change to the reader↔pack (CDN) data path**, to `cdn.llera.eu`'s CORS allowlist, or to
  `srrf.tar.gz` / the store-root reader shell. The admin bundle is **not** part of the reader
  bundle, not part of the Pages deploy, and not part of `srr frontend update` — which
  automation must never run (operator-only, hard rule).
- **No new API endpoints and no wire changes.** The migration is UI-only; `/api/*` semantics
  are frozen (`serve_*_test.go` keeps them frozen).
- **No auth layer inside `srr serve`.** Access is the auth layer. `hostGuard` stays what it is:
  anti-DNS-rebinding + anti-CSRF, not authentication.

---

## 1 · Decision: the cross-origin topology

This is the central call the plan asks for. Both candidates are stated with their real
mechanics before the decision.

### Candidate A — reader at `srr.32b.io` drives the API at `admin-srr.llera.eu`

The admin UI ships inside the reader bundle as a lazy `#admin` route; its `fetch()`s go
cross-origin to `https://admin-srr.llera.eu/api/*`.

What it actually requires:

1. **Credentialed cross-site fetches.** Access authenticates by the `CF_Authorization` cookie
   set on `admin-srr.llera.eu`. From `srr.32b.io` that cookie is **third-party** (different
   registrable domain — `32b.io` vs `llera.eu`, so cross-*site*, not merely cross-origin).
   Every call needs `credentials: "include"`, and the cookie must survive third-party cookie
   policy: blocked outright by Safari ITP and Firefox Total Cookie Protection, and on
   Chrome's phase-out path. The reader already demonstrates the mechanic
   (`sync.ts:164,199` — `credentials: "include"` for the Access-gated sync endpoint), which is
   exactly why we know its failure mode: `index.html`'s own comment on
   `<link rel="manifest" crossorigin="use-credentials">` records that an uncredentialed fetch
   through Access gets **302'd cross-origin to the login page and surfaces as a CORS error**.
2. **CORS at two layers.** The Go side needs an origin allowlist echoing
   `Access-Control-Allow-Origin: https://srr.32b.io` + `Access-Control-Allow-Credentials: true`
   + `Vary: Origin`. But a **preflight `OPTIONS` carries no cookie**, so Access intercepts it
   before the origin ever sees it and answers with its login redirect — unless the Access
   application itself is configured to allow CORS preflight for that origin, with credentials.
   So the CORS contract lives half in Go and half in the Access app config, and both must agree.
   Every mutating call in this UI is non-simple (JSON body, PUT/DELETE), so every one of them
   preflights.
3. **Deleting the CSRF control.** `hostGuard` today rejects any non-loopback `Origin` unless
   the browser's own unforgeable `Sec-Fetch-Site: same-origin` vouches for it
   (`cmd_serve.go:199-205`). Candidate A must relax that to an origin allowlist — which is the
   only thing standing between the operator's live Access session and a cross-site POST from
   any page they have open. **Access does not stop CSRF**: it authenticates the browser, and a
   forged cross-site request rides the same authenticated browser. The only other mitigation
   would be `CF_Authorization`'s `SameSite` attribute, which is Cloudflare's to set, not ours.
4. **Trust coupling.** The allowlisted origin would be the reader — the one surface in the
   system that renders **untrusted third-party HTML in its main DOM**. A sanitizer bypass there
   would inherit the ability to delete feeds, bump `gen`, rewrite recipes and trigger fetches on
   the store's only writer. The 2026-06-29 spec accepted an analogous risk when the target was
   an unauthenticated scratch process on the operator's laptop; it is a different trade against
   a public production writer.

### Candidate B — the admin UI is same-origin with its API

The admin console is served from `admin-srr.llera.eu` itself, so its API calls are ordinary
root-absolute `/api/...` requests to its own origin.

What it gets, for free:

- **No CORS at all** — no Go CORS layer, no `SRR_SERVE_ORIGINS`, no Access CORS configuration,
  no preflights, no `Vary: Origin` cache-key hazard.
- **No cookie policy exposure** — the Access cookie is first-party to the page making the call;
  third-party cookie blocking is irrelevant. Works in every browser, including Safari.
- **`hostGuard` survives verbatim.** Browser mutations from the console carry
  `Sec-Fetch-Site: same-origin`, which is precisely the carve-out that already exists for the
  Host-rewriting tunnel deployment. The anti-CSRF control is *kept*, not traded away.
- **One Access application, one session** covering page and API together. A session expiry
  redirects the document, not an inscrutable failed `fetch`.
- **The existing Cloudflare cache-bypass rule** (order 5, `admin-srr.llera.eu`) keeps doing its
  job with no re-derivation.

### Decision

**Candidate B — same-origin.** The deciding arguments, in order:

1. It *keeps* a security control that Candidate A must delete (`hostGuard`'s Origin check), and
   Access provably does not backfill it.
2. It refuses to make the untrusted-HTML-rendering reader origin a privileged API client of the
   store's only writer.
3. Candidate A's cookie path is on a browser-vendor deprecation slope we do not control, and
   already fails today in Safari and Firefox.
4. It is strictly less machinery: zero CORS code, zero Access CORS config, zero preflight
   round-trips per mutation.

**The contract this fixes:** the admin bundle declares **no API base URL** — no
`localStorage`-editable base, no build-time constant. It calls root-absolute `/api/...` exactly
as `webui/app.js` does today, and it is *only* deployable somewhere `/api/*` resolves to
`srr serve` on the same origin. That is the invariant; §2 picks who serves the bytes.

---

## 2 · Decision: who serves the admin bundle

Same-origin means *something on `admin-srr.llera.eu` must serve static files*. Two mechanisms
satisfy the §1 contract identically from the browser's point of view.

### B1 (chosen) — `srr serve` serves the generated bundle from `//go:embed`

`backend/webui/` stops holding hand-written sources and becomes a generated artifact directory
(`backend/webui/dist/`, produced by the frontend build, embedded at compile time). The file
server in `newMux()` stays; `minifiedWebUI()` is **deleted** (Parcel already minifies — the
`tdewolff/minify` startup pass exists only because the sources were hand-written).

Why this one:

- **The deployment does not change at all.** dmz installs one static binary via `srr-update be`
  from a GitHub release. Admin console updates ship with the binary, atomically, exactly as
  today. No new Cloudflare component, no second deploy target, no drift between UI and API
  version (the console's version label already comes from `/api/overview`'s `version`, which is
  the same binary).
- **No tunnel or Access change.** `admin-srr.llera.eu` keeps its single ingress to
  `localhost:8088` with `httpHostHeader: localhost:8088` — which is also what makes the *page*
  request pass `hostGuard`'s unconditional Host check.
- The cost is one build-order coupling (below), which CI already pays for: `release.yml`
  builds the frontend anyway.

### B2 (recorded alternative, not chosen now) — edge path-split

`admin-srr.llera.eu/api/*` and `/mcp` route to the tunnel; everything else is served by a
Cloudflare Pages deployment of the admin bundle (a Worker route on the hostname, or Pages
Functions proxying `/api`). `srr serve` then becomes literally API-only.

Why not now: it introduces a new edge component on the path of the tool the operator uses
daily, and the Access × Workers enforcement ordering on a hostname that is simultaneously an
Access app and a Worker route is not something this document can verify from the repo. It also
splits "the admin UI version" from "the binary version" — a class of skew the current
single-artifact deployment doesn't have.

**Both are reachable from the same built bytes.** Because the bundle hardcodes no API base
(§1), switching B1→B2 later is a *deployment* change with no code change: build the same
`dist/`, publish it to Pages instead of embedding it, add the route. That reversibility is why
choosing B1 now costs nothing strategically.

### Amendment to plan step S40

S40 reads "serve becomes API-only … delete `backend/webui/` + its minify step". Under this
design:

- **the minify step is deleted** (as written),
- **the hand-written webui is deleted** (as written — that is the actual goal),
- **the static file server is retained**, serving generated bytes. Serve is
  "API + the console's own static bundle", not API-only.

This matters for a second plan step: **S43 mounts `/mcp` in `newMux()` and its note that the
exact `"/mcp"` pattern must beat the `"GET /"` wildcard remains correct** under this design
(under B2 it would become moot). S43 needs no revision either way.

### Frontend shape

- **New Parcel entry `frontend/src/admin.html`** — a third HTML entry beside `index.html` and
  `design.html` (the latter is the existing precedent for a second entry sharing modules).
- **New module tree `frontend/src/js/admin/`** — TypeScript port of `app.js`, split by tab
  (`feeds.ts`, `recipes.ts`, `syndicate.ts`, `tools.ts`, plus `api.ts`, `sse.ts`, `chips.ts`,
  `dialog.ts`). API payload types come from the generated `format.gen.ts`
  (`IFeedWire`/`IRecipeWire`/`IOutFeedWire`/`IDBWire`) plus a small hand-written
  `overviewView`/`feedListView` mirror (those are serve-side view types, not part of the
  writer↔reader contract, so they are not `gen-ts`-generated — keep them in one file so drift
  is one diff).
- **Styling**: `admin.css` imports `tokens.css` and reuses the reader's primitives (chips,
  dialogs, menus, the per-source color ramp — `srcColorIndex` in `fmt.ts:381` is already
  mirrored by hand in `app.js:100`; the port imports it instead). `app.css`'s admin-specific
  layout (health board, table, panels) is ported as component rules on top of the tokens.
  **This is the "unify the design system" payoff** and the only reason a port beats a
  transliteration.
- **Port discipline**: correctness parity with today's console is the bar. The port may start
  near-verbatim per tab and tighten incrementally, but three things are rewritten deliberately:
  the `el()` helper's `html:` escape hatch is **dropped** (SEC3 names it; the four inline SVG
  icons become real elements or a `<symbol>` sprite), `window.confirm` is replaced by the
  reader's dialog primitive, and the raw-`innerHTML`-free invariant becomes a lint rule.
- **Dev loop**: `parcel serve src/admin.html` on :1234 would be cross-origin to a local
  `srr serve` on :8088 — which the §1 contract forbids. Fix it in the dev server, not in the
  product: extend the existing `frontend/.proxyrc.js` (which already rewrites `/` →
  `/index.html`) to forward `/api` and `/mcp` to `http://localhost:8088`. Dev is then
  same-origin too, and **no CORS code is ever written, in any environment**. (Needs
  `http-proxy-middleware` as a devDependency, or ~15 lines of `node:http` forwarding.)

### Build wiring

```
make build-admin   # parcel build src/admin.html --dist-dir ../backend/webui/dist
make build-be      # depends on build-admin, then go build
```

- `backend/webui/dist/` is **generated** and gitignored except for a committed placeholder
  `index.html` (a ten-line "admin bundle not built — run `make build-admin`" page) so that a
  bare `go build ./...` / `go vet ./...` / `go test ./...` still compiles without Node. Use
  `//go:embed all:dist`.
- `release.yml`: the frontend build must precede the Go builds. The workflow already builds the
  frontend twice (store-root `srrf.tar.gz` with no cdn-url, and the Pages build with
  `SRR_CDN_URL`); the admin build is a third, independent invocation writing to a **separate
  dist dir** — see §5 for why separate invocation, not a shared multi-entry build.
- Binary size: the current embed is 96 KB of sources; the built bundle is expected in the same
  order (~100-200 KB) against a ~20 MB binary. Not a constraint; measure and record in the S40 PR.

---

## 3 · What of `srr serve` survives

| Surface | Fate |
|---|---|
| **All 17 `/api/*` routes** (`registerAPI`, `cmd_serve.go:279-297`) | **Unchanged**, semantics frozen. They are the contract the new UI is written against, and `serve_*_test.go` already pins them. |
| `hostGuard` (`cmd_serve.go:193-208`) | **Unchanged, deliberately.** Unconditional loopback `Host` check (DNS-rebinding; satisfied by the tunnel's `httpHostHeader`) + non-loopback `Origin` allowed only with `Sec-Fetch-Site: same-origin`. Same-origin admin keeps both halves meaningful; this is §1's main dividend. |
| `withDBCtx` per-request scopes | **Unchanged**: no lock for GET, `withDB(true)` for mutations, no persistent handle. |
| `writeErr` status mapping + `msgLockContention` 409 | **Unchanged.** The new UI must reproduce today's behavior: `api()` surfaces `.error` verbatim, and the SSE fetch path receives the same message as an in-band `event: error` (SSE has already sent 200). Worth an explicit UI affordance the current console lacks: 409 is indistinguishable from a validation 400 in the banner today; the port should label it ("the fetch loop holds the store lock — retry"). |
| `maxRequestBody` (8 MiB), `decodeJSON`, `pathID` | **Unchanged.** |
| `--interval` background fetch loop + the `--force` warning | **Unchanged.** Still one process: console + loop. |
| `/mcp` (S41–S44) | **Stays, and is part of the API surface this design preserves.** Mounted in `newMux()` with no method prefix, inside `hostGuard`; non-browser MCP clients send no `Origin`, and the tunnel rewrites `Host`. Under B1 the `"GET /"` file server still exists, so S43's "exact `/mcp` beats the wildcard" note holds unchanged. The remote client registration (`https://admin-srr.llera.eu/mcp` + `CF-Access-Client-Id`/`-Secret`) is unaffected by anything here. |
| `mux.Handle("GET /", …)` file server | **Retained**, now serving generated bytes (§2). |
| `minifiedWebUI()` + the `tdewolff/minify` html/css/js imports in `cmd_serve.go` | **Deleted.** Parcel minifies. (`#minify` in `mod/` keeps its own dependency — this only drops serve's use.) |
| `webUICacheHeaders()` (`cmd_serve.go:110-142`) | **Reworked, not deleted.** It exists because `fstest.MapFS` entries have zero ModTime, so a static `app.js` name had no validator and CDNs served the previous release's bytes. A Parcel bundle is **content-hashed** (`frontend.<hash>.js`), which fixes the cause structurally. New rule, mirroring `store.cacheControlForKey`: hashed asset names → `Cache-Control: public, max-age=31536000, immutable`; `index.html` (and any unhashed root file) → `no-cache` + the startup-computed content ETag it already emits. |
| The startup banner "SRR admin GUI at http://…" | Unchanged wording (it is still an admin GUI). |

---

## 4 · SEC3 — security headers ride along

SEC3 (`FINDINGS-2026-07-20.md`, `P2 · S · BE-X2`) states:

> `cmd_serve.go:90-95,146-161,174-180` — `hostGuard` (Host/Origin allowlist) only; no CSP,
> `X-Content-Type-Options: nosniff`, `X-Frame-Options`, or `Referrer-Policy` anywhere.
> Defense-in-depth, not an open hole (Access-gated, loopback-bound, previews sandboxed in
> `app.js:1036-1042`) — but the origin renders network-derived feed content/error strings
> and the `el()` helper already supports `html:` (`app.js:78`). **Fix:** header
> middleware — strict static CSP (`default-src 'self'` where feasible), nosniff, Referrer-Policy.

S40 implements exactly that fix, and this design makes the strict half *feasible*: a generated
bundle has no inline scripts and no inline styles to grandfather, and the port drops the `html:`
escape hatch SEC3 names.

**`secHeaders` middleware**, wrapping the mux **outside** `hostGuard` (so even a 403 response
carries them):

```
Content-Security-Policy: default-src 'self'; img-src * data: blob:; media-src * data: blob:;
                         style-src 'self'; script-src 'self'; object-src 'none';
                         frame-src 'self'; base-uri 'none'; form-action 'none';
                         frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
```

Notes that must survive review:

- **`img-src`/`media-src` cannot be `'self'`.** The preview dialog renders real article HTML
  in a `sandbox=""` `srcdoc` iframe, and a **`srcdoc` document inherits the embedder's CSP** —
  so a strict `img-src` blanks every preview. Widening media while keeping `script-src 'self'`
  is the right split: the sandbox (no `allow-scripts`) is what stops execution, CSP is the
  backstop. Verify preview rendering as part of S40's manual smoke.
- **`frame-src 'self'`** covers `srcdoc` (which is same-origin-ish for CSP matching); confirm
  against the built console rather than assuming — if a browser disagrees, `frame-src 'none'`
  plus `sandbox` is not an option, the previews are the feature.
- `frame-ancestors 'none'` + `X-Frame-Options: DENY` are belt-and-braces for the clickjacking
  half SEC3's body names; the header is legacy but free.
- The reader keeps its **own, different** CSP (`script-src 'self'; object-src 'none';
  base-uri 'none'`, duplicated in `frontend/_headers` for Pages and as a `<meta>` for the
  store-root shell). Two origins, two policies; do not unify them — the reader deliberately
  omits `connect-src` for the user-configured image proxy and sync endpoint.
- Header middleware is a *Go* change and therefore lands with S40 (or independently as its own
  SEC3 fix — it does not depend on the UI port; if the UI port slips, ship the headers anyway,
  minus the `style-src 'self'` tightening which the current hand-written UI may not satisfy).

---

## 5 · Bundle discipline

The rule is unchanged from 2026-06-29: **a reader-only user downloads zero admin bytes.** This
design satisfies it more strongly than a lazy chunk does — the admin is a *separate entry in a
separate build output* and is never published to Pages or the store root at all.

- **Separate `parcel build` invocation into its own `--dist-dir`.** Not a shared multi-entry
  build: Parcel may hoist a module used by two entries into a shared chunk, which would change
  the reader's chunk graph (and its content hashes) as a side effect of adding the admin entry.
  A separate invocation makes the reader's output bit-identical by construction.
- **Measurement (S40's verify).** The check is stronger than "size unchanged": the reader's
  emitted **content-hashed filenames must be identical** before and after
  (`dist/srrf/frontend.<hash>.js`, `styles.<hash>.css`, `sw.<hash>.js`). A changed hash *is* a
  changed byte. Record `ls -l dist/srrf` from before and after in the PR; a size table alone
  would miss a same-size reshuffle.
- Corollary: modules imported by **both** reader and admin (`fmt.ts`'s `srcColorIndex`,
  `format.gen.ts`, `tokens.css`) get compiled into each output separately. That is intended —
  duplication of a few KB across two independently deployed apps, in exchange for an
  unbreakable size invariant.
- The service worker is reader-only and stays that way: the admin entry registers no SW, so
  admin routes never enter the SW's cache-first pack scope.

---

## 6 · Migration inventory — `backend/webui/` → the ported console

Route column = the console's hash route (preserved verbatim, so existing bookmarks like
`#tools` keep working; `showTab` uses `replaceState`, deliberately creating no history entries).
"Backing endpoint" is the only contract the port may not change.

### Shell / infrastructure

| # | Feature (today) | Ported to | Backing endpoint |
|---|---|---|---|
| 1 | Masthead: signal mark + wordmark + `#ver` version label | `admin/shell.ts`; version from the snapshot | `GET /api/overview` (`version`) |
| 2 | 4-tab nav, `location.hash` router, `hashchange`, `replaceState` | `admin/router.ts` — same 4 names | client-only |
| 3 | Single-read snapshot model (`loadSnapshot`/`refresh`), one store read per render | `admin/store.ts` | `GET /api/overview` |
| 4 | Focus refresh: re-pull when >30 s stale and not fetching; never redraws Tools | same | `GET /api/overview` |
| 5 | Global banner toast (2.5 s auto-hide on success, sticky on error, click-to-dismiss) | reader popup/toast primitive re-skinned | client-only |
| 6 | `api()` JSON helper — non-JSON bodies surfaced verbatim (hostGuard 403 / Access HTML) | `admin/api.ts` — **keep the verbatim fallback**, it is how topology errors get diagnosed | all |
| 7 | `streamSSE()` — POST + manual `ReadableStream`/`TextDecoder` frame parser, `AbortSignal` | `admin/sse.ts` | `POST /api/fetch` |
| 8 | `el()` helper incl. the `html:` `innerHTML` escape hatch | **dropped** (SEC3); icons become elements/sprite | — |
| 9 | `body.fetching` "on the air" state (pulses the mark; gates focus-refresh and the strip button) | same | client-only |
| 10 | Shared primitives: `confirmDelete` (native `window.confirm`), `saveModal`, `dialogRow`, `makeDialog`, `stepsEditor`, `checkList`, `appendRecipeOptions`, `emptyState`, `pipeTokens`, `relTime`, `srcColorIndex`, `overrideChip`, `liveArts` | `admin/ui/*.ts`; confirms move to the reader dialog primitive; `srcColorIndex` imported from `fmt.ts` instead of re-implemented | client-only |

### Feeds tab (`#feeds`)

| # | Feature | Ported to | Backing endpoint |
|---|---|---|---|
| 11 | Health board: total + per-grade toggles; client-side grade (`ok`/`warn`/`err`/`stale`/`idle`, `STALE_AFTER` 30 d) | `admin/feeds/board.ts` | derived from snapshot |
| 12 | Store-pulse alert strip (amber 6 h / red 24 h) with inline **Fetch now** (not cancellable) | same | `POST /api/fetch` (SSE) |
| 13 | Toolbar: title/url search, tag select (`UNTAGGED = "\x00"` sentinel), **+ Add feed** | same | client-only |
| 14 | Feed table: per-source color rail, status dot + hover/focus error tip, inline `.rowerr`, tag/recipe/override chips, `last new`, live article count | `admin/feeds/table.ts` | snapshot |
| 15 | Sorting: title / last_new / articles; numeric columns first-click descending; `aria-sort` | same | client-only |
| 16 | Row action **Fetch this feed** | same | `POST /api/fetch?id=N` (SSE) |
| 17 | Row action **Preview** (sandboxed `srcdoc` iframes; passes the feed's `pipe`/`ingest`) | `admin/preview.ts` | `GET /api/preview?url&recipe&pipe*&ingest` |
| 18 | Row action **Edit** → feed modal | §19 | — |
| 19 | Feed modal (add = URL-first / edit = title-first): title, URL, tag chips, recipe chips, **Advanced** `<details>` (ingest, pipe via `stepsEditor`, expire days, dedup days, dedup-title, hide-titles) with auto-open + per-value summary chips; full-replace save; clamps `expire [0,36500]`, `dedup [-1,36500]` | `admin/feeds/modal.ts` | `POST /api/feeds` · `PUT /api/feeds/{id}` |
| 20 | URL probe in the modal (paste/Enter/blur/recipe-change; memoized, stale-guarded, advisory) | same | `GET /api/resolve?url&recipe&ingest` |
| 21 | Feed delete (confirm → banner → refresh) | same | `DELETE /api/feeds/{id}` |
| 22 | `applyFeedEvent` optimistic SSE folding into the cached snapshot (vitals + counts), reconciled by the post-stream refresh | same | SSE frames |

### Recipes tab (`#recipes`)

| # | Feature | Ported to | Backing endpoint |
|---|---|---|---|
| 23 | Recipe table (name / ingest / pipe tokens / edit) + **+ New recipe** | `admin/recipes/table.ts` | snapshot (`recipes`) |
| 24 | Recipe modal: name (locked in edit), ingest, pipe via `stepsEditor`; delete hidden for `default` | `admin/recipes/modal.ts` | `PUT` · `DELETE /api/recipes/{name}` |
| 25 | "Preview a recipe against a URL" panel; `previewState` persists across tab switches | `admin/preview.ts` (shared with §17) | `GET /api/preview?url&recipe` |

### Syndicate tab (`#syndicate`)

| # | Feature | Ported to | Backing endpoint |
|---|---|---|---|
| 26 | Output table: name (links to `cdn_url + /out/<name>.<ext>` when `cdn_url` set), format + `external` chip, tags, feed refs (`#id` fallback for deleted feeds), limit | `admin/syndicate/table.ts` | snapshot (`out`, `cdn_url`) |
| 27 | Empty state naming the `SRR_CDN_URL` requirement | same | — |
| 28 | Output modal: name (locked in edit), format, title, **External** checkbox (hides selectors), tag/feed checklists, limit | `admin/syndicate/modal.ts` | `PUT /api/syndicate/{name}` |
| 29 | Output delete | same | `DELETE /api/syndicate/{name}` |

### Tools tab (`#tools`) — never redrawn in place (streamed logs)

| # | Feature | Ported to | Backing endpoint |
|---|---|---|---|
| 30 | Fetch panel: streamed log, **Fetch now**, **Cancel** via `AbortController` (aborts the server cycle through the request context) | `admin/tools/fetch.ts` | `POST /api/fetch` (SSE) |
| 31 | OPML import: file picker → dry run (raw XML body, `Content-Type: application/xml`) | `admin/tools/opml.ts` | `POST /api/import?dry_run=1` |
| 32 | Import review sheet: per-row include/title/tag/recipe, `subscribed` + `unresolved` badges, select-all with `indeterminate`, per-row validation, atomic commit | same | `POST /api/feeds/apply` |
| 33 | OPML export (`window.location = "/api/export"`) — **and** the newer lossless config export | same, plus a second button for `?format=json` (present in the API, absent from today's UI) | `GET /api/export[?format=json]` |
| 34 | Dedup pool: store-default horizon, clamped `[0,36500]`, echoes the effective value | `admin/tools/dedup.ts` | `PUT /api/dedup` |
| 35 | Generation: readout + **Bump generation** behind a confirm | `admin/tools/gen.ts` | `POST /api/gen/bump` |
| 36 | Inspect: **Validate store** + **From hash** into a `<pre>` log | `admin/tools/inspect.ts` | `GET /api/inspect?mode=validate\|from-hash&hash=` |

**36 features across 4 tabs, 8 dialogs/panels, and 17 endpoints.** Two gaps worth closing
during the port (both additive, neither a wire change): the `?format=json` export (§33) and an
explicit 409 lock-contention affordance (§3).

Client-side-only behavior that must be carried over verbatim (it exists nowhere on the server):
grade computation, `STALE_AFTER`, the pulse thresholds, `liveArts = total_art − expired`,
relative times, sort/filter state, the optimistic SSE fold, `srcColorIndex`, chip semantics,
the Advanced auto-open rule, all input clamps, probe memoization, `outFileURL` construction,
feed-id→title resolution, and the import "already subscribed" set. The console persists
**nothing** — no `localStorage`, no cookies; `location.hash` is its only durable state. Keep it
that way (the reader's `localStorage` usage is per-origin and irrelevant here).

---

## 7 · Deployment / rollout

**Code changes (S40):** frontend admin entry + module tree; `make build-admin` + `build-be`
dependency; `release.yml` build ordering; `backend/webui/` becomes a generated dist with a
committed placeholder; delete `minifiedWebUI()`; rework `webUICacheHeaders` for hashed names;
add `secHeaders`; extend `.proxyrc.js` for the dev proxy.

**Operator steps — explicitly NOT part of the code change:**

| Step | Needed? |
|---|---|
| Cloudflare **Access** application for `admin-srr.llera.eu` | **No change.** One app already covers page + API; same-origin keeps it that way. No Access CORS configuration is required (that was Candidate A's tax). |
| **Tunnel** ingress for `admin-srr.llera.eu` (dmz tunnel, `originRequest.httpHostHeader = localhost:8088`) | **No change.** The Host rewrite remains load-bearing for `hostGuard` on both the page and the API. |
| **Cache rule** (order 5, bypass cache for `admin-srr.llera.eu`) | **Keep as-is initially.** It was added because a static `/app.js` name went stale after every release; content hashing removes the cause, so the rule can later be narrowed to the HTML document + `/api/*` and let hashed assets cache. Narrowing is optional and reversible — do it only after a release confirms the hashes rotate. |
| **R2 CORS** allowlist on `cdn.llera.eu` (`https://srr.32b.io`) | **No change.** Nothing here touches the reader↔pack path. |
| **Deploy** | `srr-update be` on dmz, as today. The console ships inside the binary. |
| `srr frontend update` | **Never from automation.** Unchanged, and unrelated: the admin bundle is not part of `srrf.tar.gz` or the store root. |
| Rollback | Reinstall the previous release binary (`srr-update be --tag …`). UI and API roll back together — a property B2 would give up. |

**Sequencing:** ship `secHeaders` first if convenient (it is independent), then the port. The
port is a single cutover — the moment the new bundle is embedded, the old one is gone; there is
no dual-serving period, and no store or wire migration to stage.

---

## 8 · Testing

**Backend** (`cmd_serve_test.go`):

- `secHeaders`: every response — API 200, API 4xx, the served `index.html`, and a `hostGuard`
  403 — carries CSP/nosniff/Referrer-Policy/X-Frame-Options.
- Cache headers: a hashed asset name gets `immutable`; `index.html` gets `no-cache` + ETag and
  answers 304 on a matching `If-None-Match` (the existing test, retargeted).
- `hostGuard` regressions: non-loopback `Host` → 403; non-loopback `Origin` **without**
  `Sec-Fetch-Site: same-origin` → 403 (this must not regress — it is the control §1 preserved).
- No CORS headers are emitted anywhere (a negative test, so nobody re-adds the old design).
- `GET /` serves the embedded bundle (placeholder or real).

**Frontend** (`src/js/admin/*.test.ts`, vitest/jsdom, existing patterns):

- `api.ts`: error extraction from JSON `{error}`, from a non-JSON body, and the 409 path.
- `sse.ts`: frame parsing across chunk boundaries; abort behavior.
- Feed modal: full-replace body composition (the omitted-field traps that
  `TestServeFeedSaveOmittedExpireDaysZeroes` / `...RoundTripsIngestPipe` /
  `...RoundTripsDedup` pin server-side), clamps, Advanced auto-open + summary chips.
- Grade/pulse/sort/filter pure functions (table-driven — they are the client-only logic).
- `applyFeedEvent` folding.
- Import review sheet: subscribed/unresolved initial state, select-all indeterminate, payload.

**Gate:** `make verify` plus a manual admin smoke against a local `srr serve` on a **test
store** (`-o packs` — never the default prod config), covering every dialog and the two SSE
paths. Plus the §5 measurement: the reader's hashed filenames unchanged.

---

## 9 · Open risks

- **Build coupling.** `make build-be` gains a Node dependency for a full build. Mitigated by
  the committed placeholder (bare `go build`/`go test` keep working), but a contributor who
  runs `go build` and then `srr serve` gets the placeholder page — the placeholder text must
  say so unmistakably.
- **Port fidelity.** ~1300 lines of vanilla JS carrying a lot of accumulated judgement (probe
  memoization, the optimistic fold, the Advanced auto-open rule, the import sheet's
  keep-unresolved-rows decision). The fiddly spots, unchanged from the 2026-06-29 assessment:
  the SSE fetch stream, OPML import/export (raw XML body; `window.location` download), and the
  preview `srcdoc` sandbox. The inventory in §6 is the checklist.
- **Preview under CSP.** `srcdoc` CSP inheritance is the one behavior this document asserts
  from spec knowledge rather than measurement (§4). Verify before shipping the strict policy.
- **B2 stays available but unproven.** If the binary-embed coupling ever becomes intolerable,
  the edge path-split is a deployment-only migration — but the Access × Workers ordering must
  be verified on a scratch hostname first, not on `admin-srr.llera.eu`.
- **The console is the only writer's control panel.** Any bug that makes it unreachable (bad
  CSP, bad cache header, a broken embed) takes the operator's whole admin surface with it,
  while the fetch loop keeps running headless. The CLI on gateway/bastion is the fallback —
  worth stating in the S40 PR description so the rollback path is obvious under pressure.
