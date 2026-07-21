# Cloudflare Access gating for SRR packs (in-app "Sign in to read")

**Date:** 2026-06-28
**Status:** Draft (design) — awaiting review, then implementation plan
**Scope:** `frontend/` only (new `frontend/src/js/auth.ts`; edits to `data.ts`, `app.ts`, `sw.ts`, `sw-grammar.ts`; CSS for the sign-in screen/banner; unit tests) **plus** out-of-repo infra config (one Cloudflare Access application, an nginx server block + a static bounce file, and the prod `cdn-url` value). **No backend (`srrb`) code change. No data-contract / pack-format change.**

## Problem

SRR is a fully static reader: the SPA fetches `db.gz` and the gzip pack series (`idx/`, `data/`, `meta/`, plus self-hosted `assets/`) directly via `fetch()` from `PACK_BASE` (`frontend/src/js/base.ts`), with **no credentials and no auth headers** anywhere, and a service worker caches packs aggressively. We want the **content** (everything behind `cdn-url`) to require a login, while keeping the reader's offline / cache-first behaviour intact and adding no per-user content or encryption.

The deployment target is a new dedicated host **`srr.llera.eu`** (replacing the `dev.llera.eu/srr/` path layout), behind the existing Cloudflare tunnel:

- Reader (public shell) at `srr.llera.eu/`
- Packs (gated content) at `srr.llera.eu/packs/`
- `cdn-url: /packs/` — same-origin with the shell (no CORS)

## Goals

- Require a Cloudflare Access login to read any content behind `cdn-url` (`/packs/*`, which includes `idx/`, `data/`, `meta/`, the `L<seq>`/`h<N>`/`s<N>` summaries, `db.gz`, and `assets/`).
- Keep the **reader shell public** (`/`): an unauthenticated visitor gets the app, which renders an in-app **"Sign in to read"** screen.
- Support **any number of users** via Cloudflare Access policies / IdP (no shared password, no in-app credential handling).
- Preserve offline / PWA behaviour: once authenticated and cached, the reader works offline; a stale-session reader online sees a clean "sign in again" path, not a broken UI.
- No backend change, no pack-format change, no new runtime dependency (the reader stays zero-runtime-deps; auth is plain DOM/CSS/`fetch`).
- Degrade to a no-op anywhere nothing gates (dev server, e2e), with **zero dev/prod branching** in code — the whole feature is response-driven.

## Non-goals

- **No per-user / multi-tenant content.** Every authenticated user sees the same store.
- **No client-side / end-to-end encryption.** Packs stay plaintext on the origin; we trust the host/CDN. (Threat model: gate access, not confidentiality-against-the-host.)
- **No gating of the public GitHub Pages demo** (`release.yml`). Access only covers the self-hosted `srr.llera.eu` origin; a Worker-fronted demo would be a separate effort.
- **No backend auth.** `srr serve` stays a loopback admin tool; the fetch loop writes to the local FS store and is unaffected by Access.

## Trust model & why it works

- A single Cloudflare Access application gates the `/packs` path on `srr.llera.eu`. Cloudflare enforces it at its edge, *before* the request reaches the tunnel/origin.
- Once a user authenticates to **any** Access app on `srr.llera.eu`, Cloudflare sets the host-wide `CF_Authorization` cookie. Because packs are **same-origin** with the shell, every later `fetch("/packs/…")` sends that cookie under the default `same-origin` credentials mode — **no fetch-code change is needed for the cookie to ride along.**
- **Load-bearing constraint (document & preserve):** this only works because packs are same-origin with the SPA. If packs ever move to a separate CDN origin, auth would additionally require `credentials:"include"` on every pack fetch + CORS-with-credentials on the pack origin + `SameSite=None` on the cookie. The design records this so a future origin split doesn't silently un-gate the packs.

## The core technical problem

Cloudflare Access authenticates via a **top-level browser navigation** (302 → IdP login → redirect back). But packs are loaded by `fetch()`, not navigation. When the session is missing/expired:

- A `fetch("/packs/db.gz")` is 302'd cross-origin to the `*.cloudflareaccess.com` login page. A CORS `fetch()` **cannot follow/read** that — with `redirect:"follow"` it rejects (TypeError, indistinguishable from offline); with `redirect:"manual"` it resolves to an **`opaqueredirect`** response (`type === "opaqueredirect"`, `status 0`) — a clean, unambiguous "auth needed" signal distinct from offline (which *throws*).

So the design hinges on two things:

1. **Detection** — fetch the auth-sensitive resources with `redirect:"manual"` and classify the result three ways: `ok` (200) / `auth` (opaqueredirect or a synthetic 401 from the SW) / `offline` (threw).
2. **Escalation** — to actually log in we must perform a **top-level navigation to a gated URL** so Cloudflare can run its redirect dance. The in-app "Sign in" button does this; a tiny gated **bounce endpoint** brings the user back to the reader afterward.

## Components

### 1. Infra (out-of-repo, one-time)

- **Cloudflare Access application** — self-hosted type, host `srr.llera.eu`, path `/packs`. Policy: allow your users (email OTP / Google / GitHub / IdP group — design is IdP-agnostic). Session duration is an ops choice.
- **nginx server block** for `srr.llera.eu` with `root /home/gllera/public/srr` (so `/` serves the shell and `/packs/` serves the store), bound to the LAN IP per the cross-host tunnel convention, behind the existing `cloudflared` connector.
- **Bounce endpoint** `/packs/_auth.html` — a tiny static HTML file (deploy-managed; lives under the gated prefix so it's covered by the same Access app, and is **not** a pack name so `srrb` GC ignores it). It reads `?r=`, validates the target is **same-origin and not itself under `/packs/`** (open-redirect + bounce-loop guard), and `location.replace()`s to it. Pseudocode:

  ```html
  <!doctype html><meta charset=utf-8><title>Signing in…</title>
  <script>
    var raw = new URLSearchParams(location.search).get('r') || '/';
    var u = null;
    try { u = new URL(raw, location.origin); } catch (e) {}
    // same-origin only (rejects "//evil.com" and absolute cross-origin), and
    // never bounce back into the gated /packs/ prefix (avoids a login loop)
    var ok = u && u.origin === location.origin && !u.pathname.startsWith('/packs/');
    location.replace(ok ? u.pathname + u.search + u.hash : '/');
  </script>
  ```

- **`cdn-url: /packs/`** in the prod config (`~/.config/srr/srr.prod.yaml`), replacing `/srr/packs/`. (Build-time injected into the bundle; the frontend code is path-agnostic.)
- **dev**: nothing — no Access, no bounce file. Dev/e2e degrade to the always-authed path automatically.

### 2. `frontend/src/js/auth.ts` (new module)

Small, dependency-free, single purpose. Public surface:

- `AUTH_BOUNCE = new URL("_auth.html", PACK_BASE)` — derived from `cdn-url`, so prod/dev parity is automatic.
- `class AuthRequiredError extends Error` — thrown by the fetch layer when a resource needs auth.
- `classify(resOrErr): "ok" | "auth" | "offline"` — `auth` iff `res.type === "opaqueredirect"` **or** `res.status === 401`; `offline` iff a network error was thrown; else `ok`.
- `beginLogin(returnTo = location.pathname + location.hash)` — `location.assign(AUTH_BOUNCE + "?r=" + encodeURIComponent(returnTo))` (top-level nav).
- `renderSignIn(returnTo)` — full-screen "Sign in to read" card (app name + one sentence + a **Sign in** button wired to `beginLogin`). Plain DOM + CSS.
- `renderSessionExpired()` — a non-destructive banner ("Session expired — sign in again" + button) for mid-session expiry, so cached content stays readable.

### 3. `frontend/src/js/data.ts` (fetch hardening)

The first network touch — the module-load `db.gz` fetch at `data.ts:22` — becomes the **auth probe**:

- `db.gz` fetch (`:22`), `fetchPackBytes` (`:163`), and the direct data-pack fetch (`:256`): add `redirect:"manual"`; classify; on `auth` throw `AuthRequiredError` **before** `DecompressionStream("gzip")` ever sees login HTML; only decompress when `res.ok`. (`fetchPackBytes` is the chokepoint for idx/meta; the data-pack fetch at `:256` is hardened directly.)
- `assertPackOk` (`:164`) gains auth-awareness alongside its existing 404 self-heal reload.
- Both the page-side `redirect:"manual"` path (first load / dev / SW-bypassed) and the SW's synthetic-401 path resolve through the same `classify`, so callers handle one contract.

### 4. `frontend/src/js/app.ts` (boot + mid-session)

- Boot: `await` the db.gz result; if `AuthRequiredError` → `renderSignIn(...)` instead of booting the reader. Integrate near the existing fragment-sanitising boot logic (`app.ts:882`, which already strips Access JWT fragments — same neighbourhood).
- Mid-session: a cold pack fetch throwing `AuthRequiredError` after boot → `renderSessionExpired()` banner. Do **not** tear down the reader; cached content remains readable, and the banner offers re-login.

### 5. `frontend/src/sw.ts` + `frontend/src/js/sw-grammar.ts` (SW hardening — critical)

The SW is scoped to `/` and routes **all** navigations through `networkFirst(req, SHELL)` (`sw.ts:430`). The shell (`/`) is public so that's fine, but a navigation to the **gated** `/packs/_auth.html` would be trapped client-side and never reach Cloudflare. Required changes:

- **`sw-grammar.ts`**: add `export const RE_AUTH = /\/packs\/_auth\.html$/`.
- **`sw.ts` fetch handler**: at the top (after the origin/scope guards, **before** the `req.mode === "navigate"` branch at `:430`), add:
  ```ts
  if (RE_AUTH.test(url.pathname)) return // auth bounce → native nav so CF Access can run its login redirect
  ```
- **`cacheFirst` (`:209`)** — the single chokepoint for cache-first resources (packs via `packCacheFirst`, assets via `assetCacheFirst`, hashed shell): after the network fetch, if `res.type === "opaqueredirect"` return a synthetic `new Response(null, { status: 401 })` and **do not** `cache.put` it. (`res.ok` is already false for opaqueredirect, so the existing `if (res.ok)` guard prevents caching; the explicit 401 gives the page a clean signal instead of an unreadable opaqueredirect body. This also covers gated `assets/` under `/packs/assets/`.)
- **`dbNetworkFirst` (`:394`)**: fetch with `redirect:"manual"`; on `opaqueredirect` return a synthetic `401` **without** caching or running `checkManifest`; keep the existing `catch` → serve cached db.gz (offline). Net effect: **online + expired → 401 → sign-in** (never serve stale as if authed); **offline → cached snapshot** (reader keeps working).
- This prevents the worst failure mode — a login-page HTML being cached under a pack/db key and then served forever as "the content."

### 6. CSS

Minimal styles for the sign-in card and the session-expired banner, matching the reader's existing plain-CSS house style. No new assets/fonts.

## Flows

**First visit, unauthenticated**
1. Browser loads `srr.llera.eu/` → public shell (200).
2. SPA boots, fetches `/packs/db.gz` (`redirect:"manual"`) → `opaqueredirect` → `AuthRequiredError`.
3. `renderSignIn()` shows "Sign in to read".
4. User clicks **Sign in** → top-level nav to `/packs/_auth.html?r=%2F…`.
5. Cloudflare intercepts the navigation → IdP login → sets `CF_Authorization` → returns to `_auth.html`.
6. Bounce JS validates `?r=` and `location.replace`s back to the reader (position preserved).
7. SPA reloads; `db.gz` now carries the cookie → reader boots.

**Returning, valid session** — db.gz 200 → reader boots; pack fetches carry the cookie transparently.

**Session expires mid-session (online)** — a cold pack/db fetch → 401/opaqueredirect → `renderSessionExpired()` banner; click → `beginLogin()` → back to where they were.

**Offline** — fetches throw → SW serves cached db.gz + packs (or pinned bucket); reader works from the last consistent snapshot. Re-auth happens when back online.

## Testing

- **Unit (`make test-fe`)**:
  - `auth.ts`: `classify` truth table (200 / opaqueredirect / 401 / thrown), `beginLogin` URL construction, `?r=` open-redirect + bounce-loop guard.
  - `data.ts`: auth detection on db.gz / pack / data-pack fetches (mock opaqueredirect + synthetic 401); assert `DecompressionStream` is never reached on auth.
  - `sw.ts` (via `sw-grammar` + the SW's testable seams): **cache-poisoning guard** — an opaqueredirect/HTML response is *not* stored under a pack/db/asset key, and `RE_AUTH` bypasses the navigate branch. (Highest-value test.)
- **Browser e2e (opt-in, `make test-browser`)**: simulate a 302/HTML `db.gz`, assert the sign-in screen renders and the cache stays clean; assert the always-authed (ungated) path is unchanged.
- **Existing contract/browser/stress suites unchanged** — the test env is ungated, so they exercise the always-authed path exactly as today.

## Docs

- Root `CLAUDE.md` / `frontend` notes: the Access gating model, the same-origin constraint, the `/packs/_auth.html` bounce, `cdn-url: /packs/`, and that `srr inspect --url <gated CDN>` would need a CF service token (the prod fetch loop uses the local store, so it's unaffected).
- A short deploy note: creating the Access app + the `srr.llera.eu` nginx server block + the bounce file + the `cdn-url` change.

## Risks / open considerations

- **First load has no SW yet**, so the page-side `data.ts` `redirect:"manual"` handling is mandatory (not just the SW path). Covered by §3.
- **Bounce-loop / open-redirect** via `?r=` — guarded to same-origin, non-`/packs/` targets (§1).
- **`assets/` are gated too** (they live under `/packs/`). Acceptable — they're content. Covered by the central `cacheFirst` guard (§5).
- **PWA install / manifest** is at the public `/manifest.webmanifest`; its existing `crossorigin="use-credentials"` is harmless here. No change needed.
- **Cloudflare dependency** — gating is tied to CF Access; if CF is bypassed (direct origin access on the LAN), packs are ungated. Same trust boundary as the rest of the tunnel-fronted stack.
