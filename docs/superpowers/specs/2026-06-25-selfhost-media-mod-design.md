# `#selfhost` — download & self-host feed images, videos, and audio

**Date:** 2026-06-25
**Status:** Approved (design) — implementation plan to follow
**Scope:** `backend/` + a small **frontend sanitizer-parity** change. Backend: new `mod/selfhost.go` (+ `selfhost_test.go`), a small refactor of `mod/helper_assets.go`, a context helper in `mod/`, one line in `feed.go`, an `<audio>` allowance in `mod/sanitize.go`. Frontend: an `<audio>` branch in `fmt.ts:sanitizeHtml` (+ `fmt.test.ts`). Plus docs. The two sanitizers must stay in parity (`sanitizer-parity-reviewer`).

## Problem

SRR already self-hosts and converts assets — but only ones a fetcher has
**already downloaded** into the run's shared cache dir and tagged with a
`#`-marker. The end-of-pipeline step in `feed.go:fetchURL` walks each item's
self-hostable attributes (`mod.RewriteAttrs`), and for every `#`-marker calls
`assetFetcher.UploadCacheRef`, which:

- keys the object by `sha256` of the source bytes (`assets/<2-hex>/<16-hex><ext>`),
- runs `SRR_ASSET_PEEK` to identify it,
- runs `SRR_ASSET_PROCESS` (e.g. `webify`) to **convert** it (image→WebP /
  video→WebM) — but only on a store miss,
- uploads it (content-hash dedup + store existence check),
- and the marker is rewritten to the final `assets/…` key.

Today only **external ingest commands** produce those markers. For a plain
`#feed` RSS fetch, remote `<img src="https://…">` / `<video src>` / `<audio src>`
URLs in the article body just stay remote: nothing downloads them, so nothing
converts or self-hosts them. The reader keeps hot-linking the publisher's
origin, and the operator's `SRR_ASSET_PROCESS` conversion never touches feed
media.

`UploadCacheRef`'s own comment already anticipates the fix — *"an external
ingest command **or a content-marker mod** can drop a file"*. This is that
content-marker mod.

**Audio is doubly absent.** Beyond the missing download step, `<audio>` is not
in *either* sanitizer's allowlist today: the backend bluemonday policy
(`mod/sanitize.go`) strips `<audio>` outright (so by the time `#selfhost` runs,
post-sanitize, there is no `<audio>` left to find), and the frontend
(`fmt.ts:sanitizeHtml`) has no `AUDIO` branch to resolve an `assets/` audio `src`
against the pack base. Supporting audio therefore requires a coordinated
two-sided sanitizer change, kept in parity.

## Goals

- A built-in pipeline mod that **downloads** an item's remote
  `<img>`/`<video>`/`<audio>` media into the run's shared cache dir and
  **rewrites** each reference to a `#`-marker, so the existing peek →
  `SRR_ASSET_PROCESS` → upload step converts and self-hosts it — **no new
  store/convert/dedup code**.
- Allow `<audio src>` through both sanitizers (in parity) so self-hosted audio
  survives storage and resolves against the pack base in the reader.
- Reuse the existing HTML attribute walk, the SSRF-guarded transport, and the
  content-hash upload/dedup path. The mod adds only the missing
  download-and-mark step.
- Fail-open per asset: one dead image never fails the feed.
- A no-op outside a real fetch (e.g. `srr preview`), where there is no cache dir
  and no uploader.

## Non-goals

- The mod does **not** convert or upload anything itself. Conversion is the
  operator's existing `SRR_ASSET_PROCESS` command; upload is the existing
  end-of-pipeline step. Without `SRR_ASSET_PROCESS` set, media is still
  self-hosted, just unconverted.
- `<a href>` linked files (PDFs, docs) are out of scope — "images, videos, and
  audio" only.
- `<source>` children (`<video><source>`, `<audio><source>`) are out of scope:
  the backend bluemonday policy already strips `<source>` (it's not allowlisted),
  so video self-hosting today only covers a direct `src`. Audio matches that —
  direct `<audio src>` only. Allowing `<source>` is a separate, broader sanitizer
  change.

## Design

### 1. New mod `mod/selfhost.go` — `#selfhost`

Network-bound built-in, modeled on `#readability` (`mod/readability.go`):

- Registered as `#selfhost`. The factory builds **one** `*http.Client{Transport:
  SafeTransport()}` per `Module` (i.e. per fetch worker, via `procPool`), reused
  across the items that worker processes. `SafeTransport()` is the SSRF-guarded
  transport — img/video URLs come from attacker-controlled feed content, so
  dials to private/loopback/link-local addresses are refused (override:
  `SRR_ALLOW_PRIVATE_FETCH`).

- **Parameters** (typed accessors with defaults, mirroring `#readability`):
  - `timeout=` (Go duration, default **120s**) — per-asset fetch budget; videos
    need headroom. Enforced via a per-asset `context.WithTimeout` so the shared
    client can carry different budgets per pipeline position.
  - `maxbody=` (byte size, default **128MiB**) — per-asset download cap.
  - `p.only("timeout", "maxbody")`; a malformed value or unknown key is a **hard
    error** (loud config feedback), distinct from the fail-open network path —
    identical to `#readability`.

- **Per item**: get the run cache dir from the fetch context
  (`cacheDirFromContext(ctx)`, §3). If empty (preview / `Validate` sentinel),
  **return nil** — leave content untouched. Otherwise walk `i.Content` over the
  media attribute set `{img:[src], video:[src,poster], audio:[src]}` (§2). For
  each value that is an absolute `http(s)://` URL:
  1. Compute the cache filename `<sha256(url)[:16]><ext>`, where `ext` is
     `path.Ext` of the URL path (kept only if it is a short, clean extension;
     omitted otherwise — `webify`/peek identify by bytes regardless).
  2. **URL-level download cache**: if that file already exists in the cache dir,
     skip the download (a URL reused across items/feeds this run, or carried over
     from a prior run, downloads once).
  3. Otherwise download via the SSRF-guarded client with a per-asset
     `context.WithTimeout(ctx, timeout)` and `io.LimitReader(body, maxbody+1)`;
     reject non-2xx and over-`maxbody` responses. Write **atomically** —
     `os.CreateTemp` in the cache dir, write, `fsync`-free `Rename` into place —
     so a cancelled/failed download never leaves a partial file a concurrent
     worker could pick up.
  4. On success, rewrite the attribute value to `#<filename>` (no leading slash
     needed: `UploadCacheRef` does `filepath.Join(cacheDir,
     filepath.FromSlash(localname))`).

- **Fail-open per asset**: a bad/relative URL, non-2xx, over-`maxbody`,
  SSRF-blocked dial, or write error → **leave the original remote URL in place**,
  log at WARN, continue to the next reference. One bad asset never fails the
  item or the feed (same philosophy as `#readability`). Partial success per item
  is fine: some media self-hosted, some left remote.

- `GUID`/`Published`/`Title`/`Link` are untouched, satisfying the pipeline
  immutability rule. Only `Content` attribute values change.

### 2. Shared attribute walk (`mod/helper_assets.go` refactor)

Today `RewriteAttrs` bakes the `#`-marker policy into `applyAttrs`. Extract the
HTML parse/walk/render core so both the upload step and `#selfhost` share one
implementation instead of two divergent HTML walks:

```go
// walkAssetAttrs parses content as an HTML fragment, walks every attribute in
// `attrs` (tag -> attr names), calls fn(tag, attr, value) for each, and
// replaces the value when fn returns ok. Unparseable content and a no-op pass
// both return the original string verbatim (no re-render), so quoting/whitespace
// survives when nothing changed.
func walkAssetAttrs(content string, attrs map[string][]string,
    fn func(tag, attr, val string) (string, bool, error)) (string, error)
```

- `RewriteAttrs(content, markerFn)` keeps its `markerShapeRe` memchr-speed
  fast-path, then delegates to `walkAssetAttrs(content, assetAttrs, wrapper)`
  where `wrapper` applies the `#`-prefix check and calls `markerFn` with the
  remainder. Behavior byte-for-byte unchanged.
- `#selfhost` calls `walkAssetAttrs(content, mediaAttrs, downloadFn)` with a new
  package-level `mediaAttrs = {"img": {"src"}, "video": {"src", "poster"},
  "audio": {"src"}}` (a narrower set than `assetAttrs`, which also carries
  `a href`). A cheap `strings.Contains` guard over `<img`/`<video`/`<audio` skips
  the parse when there is nothing to do.
- **`assetAttrs` gains `audio:[src]`** so the existing upload step rewrites an
  audio `#`-marker → `assets/` key (this also lets external-ingest strategies
  self-host audio — a consistent, free extension). It already walks `video
  poster`, so poster markers are consumed unchanged.

### 3. Cache-dir plumbing (`mod/` context helper)

A `Processor` is `func(context.Context, Params, *RawItem) error` — it has no
handle to the run's cache dir, which is owned by `feed.go`'s `fetchRun`. Thread
it through the fetch **context** (the run-scoped value already flows main→mod):

```go
// in mod/ (new helper, e.g. appended to helper_assets.go or a small file)
type cacheDirKey struct{}
func WithCacheDir(ctx context.Context, dir string) context.Context
func cacheDirFromContext(ctx context.Context) string // "" if unset
```

Set once at the top of `feed.go:Feed.Fetch`:

```go
ctx = mod.WithCacheDir(ctx, run.cacheDir)
```

so `Module.Validate` and every pipeline step in this fetch see it. `srr preview`
never sets it (it has no `fetchRun`/uploader and the upload step "simply never
runs" there), so `#selfhost` no-ops in preview — leaving media remote, which is
the correct preview behavior.

Chosen over changing the `Processor` signature (which would touch every built-in,
`Validate`, and their tests). A per-fetch working directory crossing the
main→mod API boundary is a legitimate `context.Value` use; `mod/` has no context
plumbing today, so this adds the first.

### 4. Placement (documented, not enforced)

`#selfhost` goes **after `#base`** — feed pipe `["#base", "#selfhost"]`,
resolving to `[#sanitize, #minify, #selfhost]`; with readability,
`["#readability", "#base", "#selfhost"]`. Running last means:

1. **It downloads only what survives sanitization.** Sanitize/minify run first,
   so `#selfhost` sees the final cleaned content and never spends bandwidth (or
   hits an attacker-chosen origin) on media in elements sanitize would strip.
   Sanitize keeps legitimate `https` img/video `src`, so the survivors are
   exactly the ones worth self-hosting.
2. **Its `#`-markers never round-trip through sanitize/minify.** They are
   produced last and consumed only by the end-of-pipeline upload step. (The
   "markers survive sanitize" property still matters for the *external-ingest*
   path, where markers are injected before the pipeline; that contract is
   unchanged. `#selfhost` sidesteps it by going last.)
3. **Posters work.** `#sanitize` constrains `<video poster>` to
   `^(https?://|assets/)`, so a `#`-marker poster is *only* stripped if it exists
   when sanitize runs. Because `#selfhost` runs after sanitize, the remote
   `https://` poster is still present when sanitize runs (kept), and the
   `#`-marker is created afterward — sanitize never sees it. The upload step's
   `assetAttrs` already walks `video poster`, and `fmt.ts:resolveMediaAttr`
   already resolves an `assets/` poster against the pack base. So posters
   self-host with zero extra machinery — but **only** in this placement.
   (Placed *before* sanitize, the poster marker would be stripped while
   img/video `src` markers survived — an inconsistent result. One more reason
   after-`#base` is the documented placement.)

Unlike `#readability` (which injects raw untrusted HTML that *must* be sanitized
afterward), `#selfhost` only rewrites attribute values on existing elements, so
it has no reason to precede sanitize.

### 5. `<audio>` sanitizer parity (backend + frontend)

`<img>`/`<video>` already round-trip both sanitizers; `<audio>` does not, so it
must be added on **both** sides, kept in parity (audit with
`sanitizer-parity-reviewer`):

- **Backend `mod/sanitize.go`** (the gating allowlist — strips anything not
  listed): add `AllowElements("audio")` plus a minimal attribute set mirroring
  `<video>` (no poster/visual attrs): `src` (bluemonday URL-scheme-validates it,
  as it does `video src`), `controls` (`^(|controls)$`), `preload`
  (`^(none|metadata|auto)$`). Without this, `#selfhost` — which runs after
  sanitize — never sees an `<audio>` element.
- **Frontend `fmt.ts:sanitizeHtml`** (defense-in-depth + URL resolution + forced
  attrs): add an `AUDIO` branch that
  1. **forces `controls`** — `node.setAttribute("controls", "")` — exactly as the
     `IMG` branch forces `loading=lazy`/`decoding=async`. An `<audio>` *without*
     `controls` renders as nothing (no player UI, zero size); feeds routinely
     ship bare `<audio src>`, so without this the self-hosted file would be
     stored but **invisible/unplayable**. Forcing it guarantees a usable player
     regardless of what the feed sent.
  2. resolves `src`: `resolveMediaAttr(node, "src", proxyPrefix, false)` — a
     relative `assets/…` src resolves against `PACK_BASE` (bounds-checked),
     external `http(s)` src passes through (`proxy:false`; image proxies don't
     handle audio, exactly like `<video src>`).

  Mirror both in `fmt.test.ts`. Forcing on the **frontend** (render layer) means
  it applies regardless of stored bytes; the backend still *allows* `controls`
  for parity/cleanliness, but display no longer depends on the feed having sent
  it. (`<video>` has the same allow-not-force gap today — a control-less video is
  a static frame — but changing video rendering is pre-existing behavior, flagged
  separately, not in this change.)

Audio's `<source>` children stay stripped on both sides (Non-goals). Optionally,
`collapseBrokenMedia` could collapse a failed `<audio>` like it does `<img>`/
`<video>` — minor, deferred.

## Data / control flow

```
fetchURL
  └─ processItem (pipeline)
       ├─ #sanitize        clamp content to allowed elements
       ├─ #minify          compact
       └─ #selfhost        for each surviving http(s) <img src|video src|video poster|audio src>:
                             download → cacheDir/<hash><ext> (atomic, URL-cached)
                             rewrite value → "#<hash><ext>"   (fail-open per asset)
  └─ end-of-pipeline upload step (RewriteAttrs, unchanged)
       └─ for each "#"-marker: UploadCacheRef
            ├─ peek (SRR_ASSET_PEEK)         identify
            ├─ process (SRR_ASSET_PROCESS)   convert (webify) on store miss
            ├─ content-hash dedup + store existence check
            └─ rewrite "#<hash><ext>" → "assets/<2-hex>/<16-hex><ext>"
```

Download dedup is the mod's (URL→cache-file existence). Upload dedup is SRR's
(source content hash + store existence + within-run memo). Both layers already
exist conceptually; `#selfhost` just supplies the first one for `#feed` content.

## Error handling

- **Per-asset (network/IO):** fail-open — leave the remote URL, WARN, continue.
- **Per-asset (HTML render error from `walkAssetAttrs`):** fail-open — return nil,
  leave `Content` unchanged, WARN (mirrors `#readability`).
- **Config (bad/unknown param):** hard error, surfaced by `Module.Validate`
  before the item loop, failing the feed loudly.
- **Upload step (downstream):** unchanged — a genuine in-cache upload failure
  (oversize after processing, store error) still hard-fails the feed via the
  existing `feed.go` path; a marker naming no file is declined (`errNotAsset`).

## Limitations (document in `backend/CLAUDE.md`)

- **Poster self-hosting is placement-dependent.** `<video poster>` self-hosts
  only when `#selfhost` runs *after* `#sanitize` (the documented after-`#base`
  placement). Placed before sanitize, the poster `#`-marker is stripped (sanitize
  constrains `poster` to `^(https?://|assets/)`) while img/video `src` markers
  survive — so posters silently stay remote. Document the placement requirement.
- **Conversion requires `SRR_ASSET_PROCESS`.** Without it, media is self-hosted
  unconverted (still a win: stable, cacheable, same-origin).
- **Audio conversion is best-effort / likely a no-op with `webify`.** `webify`
  targets image→WebP and video→WebM; it has no documented audio-only mode, so a
  standalone audio file (mp3/m4a/ogg) will probably fall through `runProcess`'s
  **fail-soft** path (non-zero exit / unhandled type → original uploaded
  unchanged). Net effect: audio is reliably **self-hosted** but, with today's
  `webify`, **not transcoded**. Transcoding audio would need an asset-process
  command that handles audio — orthogonal to this mod.
- **Cross-run URL cache may serve stale bytes** if a URL's content changes under
  the same URL — the same disposable-cache tradeoff as external ingest. The cache
  is ops-managed (no eviction); clear the cache dir to refresh.
- **SSRF override caveat:** with `SRR_ALLOW_PRIVATE_FETCH=1`, `#selfhost` (like
  `#readability`) will dial private addresses from feed content — intended only
  for trusted self-hosters fetching LAN media.

## Testing

`mod/selfhost_test.go` (httptest-server pattern from `readability_test.go` +
the in-cache-file assertions from `helper_assets_test.go`):

- Rewrites `<img src>`, `<video src>`, `<video poster>`, and `<audio src>`
  remote URLs to `#<hash><ext>` and lands the bytes in a temp cache dir.
- **URL dedup**: a URL repeated across two items causes exactly one HTTP GET.
- **Fail-open**: 404, over-`maxbody`, non-`http(s)` scheme, SSRF-blocked host,
  and HTML render edge cases all leave the original value and return nil.
- **No cache dir** (context without `WithCacheDir`): content unchanged, no
  network.
- **Param validation**: bad `timeout=`/`maxbody=` and unknown keys are errors
  (via `Validate`).
- **Untouched targets**: `<a href>` is left as-is.
- `walkAssetAttrs` refactor: existing `helper_assets_test.go` (the `RewriteAttrs`
  behavior) must stay green unchanged.

**Round-trip (main package).** `UploadCacheRef` is an unexported method on
`assetFetcher` in package `main`, so the end-to-end assert lives in a
**main-package** test (e.g. `feed_test.go`/`assets_test.go`), not in `mod/`: run
`#selfhost` through `processItem`/`Feed.fetchURL` against an httptest media
server + a local store, and assert the stored content ends with an `assets/…`
key (i.e. the mod's `#<hash><ext>` marker is consumed by the existing upload
step). `mod/selfhost_test.go` covers the mod in isolation (download+mark,
fail-open, dedup, params) where `UploadCacheRef` is not reachable.

**Sanitizer parity.**
- `mod/sanitize_test.go`: `<audio src=…>` with `controls`/`preload` survives the
  policy; a disallowed attr (e.g. `onplay`) and a bad `preload` value are
  stripped; `<source>` stays stripped.
- `frontend/src/js/fmt.test.ts`: `sanitizeHtml` keeps `<audio>`, **forces
  `controls`** (a bare `<audio src>` comes out with `controls`), resolves a
  relative `assets/…` `src` against `PACK_BASE`, bounds-drops a traversal
  (`../`/off-origin), and passes an external `http(s)` `src` through unproxied.
- Run `sanitizer-parity-reviewer` after the change to confirm the backend
  allowlist and the frontend filter agree on `<audio>`.

Gate: `make verify-be` (backend) + `make verify-fe` (frontend). The e2e contract
layer (`make verify`) exercises real packs; consider one contract assertion that
an `<audio src>` in feed content stores as an `assets/…` key and renders.

## Files

| File | Change |
|---|---|
| `backend/mod/selfhost.go` | **new** — `#selfhost` mod (register, client, params, download+mark, fail-open) |
| `backend/mod/selfhost_test.go` | **new** — mod-in-isolation tests (download+mark, fail-open, dedup, params) |
| `backend/mod/helper_assets.go` | extract `walkAssetAttrs`; `RewriteAttrs` delegates; add `mediaAttrs` (incl. `audio`); add `audio:[src]` to `assetAttrs`; add `WithCacheDir`/`cacheDirFromContext` |
| `backend/mod/sanitize.go` | allow `<audio>` + `src`/`controls`/`preload` (mirror `<video>`, no poster) |
| `backend/mod/sanitize_test.go` | `<audio>` allow/strip parity cases |
| `backend/feed.go` | one line: `ctx = mod.WithCacheDir(ctx, run.cacheDir)` in `Feed.Fetch` |
| `backend/feed_test.go` (or `assets_test.go`) | main-package round-trip: `#selfhost` → upload step → `assets/…` key |
| `frontend/src/js/fmt.ts` | add `AUDIO` branch in `sanitizeHtml`: force `controls`, resolve `src` against pack base (`proxy:false`) |
| `frontend/src/js/fmt.test.ts` | `<audio src>` sanitize/resolve cases |
| `backend/CLAUDE.md` | document `#selfhost` in the mod list + asset self-hosting note + limitations |
| `frontend/CLAUDE.md` | note `<audio>` is now sanitized/resolved (sanitizer parity) |
| `backend/README.md` | add `#selfhost` if it lists built-in mods |
