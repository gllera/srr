# RDR16 — Podcast mini-player (design)

**Date:** 2026-07-26 · **Finding:** RDR16 (`P3 · L`, FE-F11) · **Builds on:** FEB2 (S51, shipped)

## Problem

The backend's `#enclosure` injects podcast `<audio controls>` into article content, and the
operator listens to podcasts in the reader. Today:

- **prev/next kills playback.** `reader.ts render()` calls `el.content.replaceChildren`, which
  removes the `<audio>` element outright. FEB2 (S51) saves *position* so returning resumes, but
  the episode stops the instant you swipe.
- **back-to-list keeps playing, invisibly.** `el.article.hidden = true` is `display:none`, which
  does **not** pause media — so an episode survives back-to-list but becomes uncontrollable:
  no transport anywhere on screen.
- **scrolling the show notes loses the transport.** The `<audio>` sits wherever `#enclosure` put
  it (top of the article); scroll past it and there is no way to pause without scrolling back.

## Approach: relocate the live element

The article's own media element is **moved** — `appendChild`, an atomic remove+insert — out of
`.srr-content` into a persistent player host, before `replaceChildren` destroys it. On return to
the owning article it is swapped back into its slot in the freshly rendered content.

Per the HTML spec, the "removed from a `Document`" steps queue a task that runs the internal
pause steps **only if the element is not in a document** at stable state. An atomic move passes
that check, so playback is never interrupted. This is structural, not reconstructed: no second
element, no `src`/`currentTime` handoff, no re-buffer gap — and video works through the identical
path, CSS-constrained to a compact frame.

Rejected alternatives: a **separate persistent `<audio>`** in the bar (two elements to keep in
sync, audible re-buffer at handoff, lossy `currentTime` handoff on a stream, and video needs a
whole second mechanism); **handoff only on navigate-away** (same re-buffer gap, at exactly the
moment the feature exists to make seamless).

### Two separated concerns

- **Relocation is about survival.** The element moves only when its article stops being rendered.
- **The bar is about control.** It shows whenever media is active and you cannot see it: either
  its article is not rendered, **or** it is rendered but scrolled off-screen.

The second clause is what makes it a usable podcast player — hit play, scroll the show notes, the
transport follows you — without the element jarringly leaping out of the article as you scroll.
The bar's controls always target "the active media element", wherever it currently lives.

## The order-of-operations invariant

FEB2 pairs saved state to elements **by `querySelectorAll` index**. Adopting an element before
harvesting would shift every index after it, so the sequence in `reader.ts render()` is fixed:

```
harvest → adopt → replaceChildren → restore → rehome
```

- `harvestMediaState()` reads all media in the outgoing content, including the playing one.
- `player.adoptFromContent()` then moves the live element out.
- `replaceChildren` installs the new article.
- `restoreMediaState(chron)` applies FEB2 positions to the fresh elements.
- `player.rehomeInto(mid, chron)` swaps the live element in for the fresh one at its index. The
  fresh element's just-restored position is discarded — the live element carries the truth.

This ordering is not recoverable by reading either function alone and **must** be stated as a
comment at the call site.

## Module & ownership

New **`frontend/src/js/player.ts`**. Imports `els`, `data`, `fmt`, `keys`, `cache`, `mounts`.
It imports **neither `nav` nor `reader`** — `reader.ts` imports *it*, and everything it needs from
the router arrives through an injected `PlayerDeps`, the pattern `ReaderDeps` established in the
ENG2 split. The module graph stays acyclic with `app.ts` on top.

```ts
export interface PlayerDeps {
   // The bar's title button — jump to the article that owns the active media.
   openArticle: (mid: string, chron: number) => void
   // Write a position into FEB2's mediaStates (which lives in reader.ts, so this
   // is injected rather than imported — player.ts must not import reader.ts).
   rememberPosition: (mid: string, chron: number, index: number, s: { time: number; rate: number }) => void
}

export function setup(deps: PlayerDeps): void
// reader.ts after every render — which article is on screen. The chron of the
// mounted article is reader.ts's state, not ours, and a claim needs it for
// identity; the title/feedId let the bar label itself with no pack fetch.
// Called with null for the empty states (no article to claim into).
export function noteMounted(info: MountedArticle | null): void
// reader.ts, BEFORE replaceChildren and AFTER harvestMediaState.
export function adoptFromContent(): void
// reader.ts, AFTER replaceChildren and restoreMediaState.
export function rehomeInto(mid: string, chron: number): void
// app.ts at boot — restore a persisted episode into a paused bar (never autoplays).
export function restorePersisted(): void
// True while an episode is claimed (playing, paused, or restored-paused).
export function isActive(): boolean
```

`reader.ts` correspondingly exports `rememberPosition(mid, chron, index, MediaState)` — the
FEB2-store writer `app.ts` injects as the `PlayerDeps` callback — and its `mediaStates` LRU is
re-keyed `` `${mid}:${chron}` `` (see the mount-safety fix below).

### Claiming

`play` does not bubble, but non-bubbling events still traverse the **capture** phase — the
precedent is `collapseBrokenMedia`, which fmt.ts documents as registered on `.srr-content` with
`capture: true`. So: one capture-phase `play` listener on `document` claims any media element,
recording its identity. `pause`/`ended`/`error`/`timeupdate` are bound directly to the claimed
element and removed on release.

### Identity

```ts
interface Active { mid: string; chron: number; index: number; el: HTMLMediaElement }
```

`mid` is `data.activeStore().mid`. `index` is the element's position among
`querySelectorAll("audio,video")` within its article — the same pairing FEB2 uses.

## Incidental fix: FEB2 is mount-unsafe

`mediaStates` is `makeLRU<MediaState[]>(20)` keyed on bare `chron`. Since S38 (multi-store),
chron is only unique **within a mount** — two mounted stores both have a chron 42, so stepping
between them can restore one article's playback position onto a different article. `cache.ts`'s
`makeLRU<T, K>` is already generic over the key type, so the fix is
`makeLRU<MediaState[], string>(20)` keyed `` `${mid}:${chron}` ``. In scope because it is the same
subsystem, and the player's own identity needs `mid` for exactly the same reason.

## DOM

A `<div class="srr-player" hidden>` sibling of `.srr-toolbar`, placed before `.srr-pin-progress`.
It goes in **both `src/index.html` and `src/design.html`** — `design.test.ts` guards those
skeletons against drift and will fail if only one is updated.

```html
<div class="srr-player" role="region" aria-label="Now playing" hidden>
   <div class="srr-player-media"></div>            <!-- the live element is moved in here -->
   <div class="srr-player-body">
      <button class="srr-player-title" aria-label="Go to this article">
         <span class="srr-player-source"></span>   <!-- mono eyebrow, source-tinted -->
         <span class="srr-player-name"></span>     <!-- article title, ellipsized -->
      </button>
      <div class="srr-player-seek" role="slider" tabindex="0"
           aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
         <div class="srr-player-seek-fill"></div>
      </div>
   </div>
   <div class="srr-player-controls">
      <button class="srr-player-back15" aria-label="Back 15 seconds">−15</button>
      <button class="srr-player-toggle" aria-label="Play" aria-pressed="false"></button>
      <button class="srr-player-fwd15" aria-label="Forward 15 seconds">+15</button>
      <button class="srr-player-rate" aria-label="Playback speed">1×</button>
      <span class="srr-player-time"></span>
      <button class="srr-player-close" aria-label="Close player">&times;</button>
   </div>
</div>
```

`data-kind="audio"|"video"` on `.srr-player` selects the media-host treatment. `data-src` carries
the source color index (`fmt.srcColorIndex`), matching the reader masthead and list rails.

## CSS & chrome coexistence

- `z-index: var(--z-toolbar)` (6) — above the sticky day dividers (1) and search bar (5), below
  the picker overlay (10) and the lightbox/popups (1000).
- `.srr-container`'s `padding-bottom` / `scroll-padding-bottom` go from `4rem` to `7.5rem` under a
  `body.srr-playing` class, so the last paragraph clears the bar.
- `gestures.ts`'s `setHidden` additionally toggles `body.srr-toolbar-hidden`; CSS then translates
  `.srr-player` down into the toolbar's place when the toolbar auto-hides, instead of leaving it
  floating above a gap.
- Audio: `.srr-player-media` is zero-width (an `<audio>` has no useful visual; the custom chrome
  drives it). Video: a `4rem`-wide `16/9` frame.
- `prefers-reduced-motion`: no slide/fade transition, per project convention.
- The adopted element has `controls` removed while in the bar; `rehomeInto` restores it (fmt.ts
  force-sets `controls` on in-content audio, so it must go back).

## Gesture guard

`gestures.ts` binds touch handlers on `document` with **no target filtering**: any 50px horizontal
drag fires prev/next. A scrub gesture would navigate away instead of seeking. `.srr-player`
therefore stops propagation on `touchstart`. This also fixes the same latent problem for today's
in-content `<audio controls>` scrubber.

## Media Session

On claim and on rehome, set `navigator.mediaSession.metadata` (title = article title,
artist = feed title, album = `"SRR"`) and keep `playbackState` in step. Handlers: `play`, `pause`,
`seekbackward`, `seekforward`, `seekto`, `stop`.

**Deliberately not `previoustrack`/`nexttrack`.** Mapping those to prev/next *article* would turn
the lock screen into a navigation surface and skip the user out of the episode they are listening
to. Feature-detected throughout; absent support changes nothing else.

## Persistence

Two keys, declared in `keys.ts` (never raw literals — ENG5):

- `playerStateKey(mid)` → `srr-player` (home) / `srr-player@<mid>`. **Mid-qualified** because
  chron is per-store. Value:
  `{ chron, index, time, rate, src, kind, title, feedId }`.
- `PLAYER_RATE_KEY` → `srr-player-rate`, the device's preferred rate (global, not per store).

`title`/`feedId`/`src`/`kind` are persisted so the bar can render at boot with **zero pack
fetches**, preserving the O(1)-boot property.

Written throttled on `timeupdate` (~5s) plus `pause` and `pagehide`; cleared on `ended` and close.
At boot `restorePersisted()` shows the bar **paused** ("tap to resume") — never autoplaying, which
browsers block and users resent.

`src` comes back from localStorage and is therefore **untrusted**: it is re-validated through the
same URL rules `fmt.ts` applies (reject `URL_DENY` schemes; a relative key must resolve within the
store base) before it is ever assigned. `title` is set via `textContent`.

Additive keys, so **no `SCHEMA_VERSION` bump** — `schema.ts` reserves that for breaking shape
changes. Playback state stays **out of the profile blob**: it is device-local, like `srr-hash`.

**Resolved during implementation:** the planned "chron past the end of the store ⇒ clear" check
was dropped. It would have read `db.total_art`, which `types.d.ts`'s `IDB` does not declare —
`data.ts` accesses it anyway, and the resulting type error is pre-existing across the repo
(`e2e/contract/chaos.e2e.test.ts:99` has the same one), so the project does not gate on `tsc`.
Rather than add to that debt for a defensive check, the restore validates `src`, a non-negative
chron and a positive time, and leans on nav's documented clamp of an unaddressable chron to the
last article. A stale entry costs a wrong caption on the jump target, not a broken boot.

## Degradation & error handling

| Condition | Behaviour |
|---|---|
| `play()` rejected (autoplay policy) | Stay paused, silently. Not a fault, no popup. |
| Media `error` event | Dismiss the bar, clear persistence. |
| Offline | Plays from the SW asset bucket when cached (★-saved articles are pinned); else the error path. |
| No `IntersectionObserver` | Degrade to "bar shows when the article is not rendered". |
| No `navigator.mediaSession` | Skip metadata/handlers; everything else works. |
| Persisted episode whose article expired or was compacted | Validates false at boot, cleared silently. |

## Testing

**`player.test.ts`** (new, jsdom): claim-on-play; `adoptFromContent` actually moves the node
(assert `parentElement`); `rehomeInto` lands at the right index; the harvest-before-adopt index
invariant; close writes a FEB2 position through `rememberPosition`; rate cycling and its
persistence; Media Session metadata against a stubbed `navigator.mediaSession`; a hostile
persisted `src` rejected; `touchstart` propagation stopped.

**Existing FEB2 tests stay green**, plus a new case asserting the element *survives* prev/next
(same node identity), not merely its position. **Multi-store regression:** two mounts with the
same chron do not cross-contaminate positions.

**Browser e2e** (one case): the bar appears and adoption happened. *Named risk:* headless Chrome
needs `--autoplay-policy=no-user-gesture-required` and a decodable asset. If real playback proves
flaky, drive adoption from a synthetic `play` event and say so in the test rather than ship a
flaky CI job.

**Design harness:** a forced "player visible" state in `design.ts` so `make design-shots` covers
it across light/dark × mobile/desktop.

## Docs

- `frontend/CLAUDE.md`: a `player.ts` module row and a Key Behaviors paragraph; the existing FEB2
  paragraph corrected to mention relocation.
- `docs/FINDINGS-2026-07-20.md`: **remove the RDR16 entry entirely** — index row, section body,
  and the Appendix E synergy line — per the standing apply-findings rule, recording the outcome in
  memory instead.
- No backend change, no wire-format change, no `format.gen.ts` regeneration. Nothing in the
  writer↔reader contract moves.

## Phasing

1. Survival + bar + control targeting + gesture guard + the FEB2 mid fix
2. Media Session + rate control
3. Reload persistence + video compact frame

Each phase is independently shippable and verifiable with `make verify-fe`.

## Parallel execution plan

Split by **disjoint file sets** (splitting by phase would collide — all three phases center on
`player.ts`):

| Track | Files | Owner |
|---|---|---|
| A — core | `js/player.ts`, `js/player.test.ts`, `js/reader.ts` (integration + mid fix) | main session |
| B — DOM/CSS | `index.html`, `design.html`, `styles.css`, `js/design.ts` | agent |
| C — small edits | `js/keys.ts`, `js/gestures.ts`, `js/gestures.test.ts` | agent |
| D — docs | `frontend/CLAUDE.md`, `docs/FINDINGS-2026-07-20.md` | agent |

The contracts above (class names, key names, the `PlayerDeps`/export API) are what make the tracks
independent. Integration, full `make verify-fe` + `make test-browser`, and a consolidated review
happen in the main session after the tracks land.
