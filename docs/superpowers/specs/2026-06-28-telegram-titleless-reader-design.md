# Titleless feeds: suppress the redundant reader heading

**Date:** 2026-06-28
**Status:** Design approved, pending implementation plan

## Problem

Telegram channel posts have no real title. The external ingest
(`srr-toolbox/bin/srr-telegram`, `make_title`) synthesizes one from the **first
non-empty line** of the message caption (truncated to 118 chars + `…`). The
article **content** (`c`) is the *full* caption rendered to HTML
(`<p>first line</p><p>…</p>`).

In the reader (`frontend/src/js/app.ts` `render`), the title becomes the `<h1>`
(`el.title.textContent = o.article.t`) and the content fills `.srr-content` —
so the first line is shown **twice**: once as the heading, once as the opening
of the body.

The home **list** (`list.ts` `fillRow`) shows only `art.t` as the row label, so
it genuinely needs the title. The duplication is reader-only.

This generalizes beyond Telegram to any microblog-style feed (Mastodon,
X-via-RSS) whose "title" is just the lead of the body — but the trigger is
explicit per-feed config, not a content heuristic (see Approach).

## Approach

Add an explicit **per-feed flag** in `db.gz` rather than a frontend heuristic
that compares title text to content. Rationale (chosen over the heuristic and
the ingest-side options during brainstorming):

- **No false positives/negatives.** A text-comparison heuristic must normalize
  whitespace/HTML and handle the `…` truncation; an explicit flag is exact.
- **No contract growth beyond one bool.** The ingest-side fix (emit empty title)
  would break the list row label and force a second "list-label" field.
- **The list keeps working unchanged** — it still renders `art.t`.

The flag is feed-level (per user decision). The external-ingest protocol emits
articles, not feed config, so the flag is set out-of-band when subscribing the
channel (CLI / `feed apply` / serve admin), not by the ingest run.

## Design

### 1. Data contract — `Feed.nt`

`backend/feed.go`, `Feed` struct (beside `Tag`/`Recipe`):

```go
// NoTitle marks a feed whose article titles duplicate the content lead
// (microblog sources like Telegram, where the title is the first line of the
// body). The reader hides the heading for these; the list still uses it as the
// row label. Set out-of-band when subscribing — the ingest can't set it.
NoTitle bool `json:"nt,omitempty"`
```

- `omitempty` + default `false` ⇒ every existing feed is unaffected and the key
  is absent in db.gz for normal feeds.
- `make generate` (`srr gen-ts`, `cmd_gents.go` reflection) flows this into
  `frontend/src/js/format.gen.ts` as `nt?: boolean` on `IFeedWire`. **Do not
  hand-edit `format.gen.ts`.** `make verify` (`generate-check`) fails if stale.
- `IFeed` (`frontend/src/js/types.d.ts`) extends `IFeedWire`, so it inherits
  `nt?` automatically — no change there.

### 2. Reader behavior — hide `<h1>`, expose a masthead permalink

> **Update (follow-up):** the masthead permalink is now shown on **every**
> article that carries a link (`.srr-kicker-link[href]`), not only titleless
> feeds — the sole link when the heading is hidden, an explicit "open original"
> companion to the title link otherwise. The glyph is a crisp NE arrow-up-right
> (clearer than the original chain-link at masthead size); on hover/focus it
> adopts the article's source color (`--src`) and nudges toward its corner
> (reduced-motion → color only), with a focus ring and a padded touch target.
> The CSS rule changed from `.srr-reader-titleless .srr-kicker-link[href]` to a
> plain `.srr-kicker-link[href] { display: inline-flex }`; `app.ts` already set
> the href on both links for every article, so no JS change was needed.

Current reader skeleton (`frontend/src/index.html`):

```html
<article class="srr-reader" hidden>
   <div class="srr-title-row">
      <div class="srr-kicker">
         <span class="srr-source"></span>
         <time class="srr-date"></time>
      </div>
      <a class="srr-title-link">
         <h1 class="srr-title" tabindex="-1"></h1>
      </a>
   </div>
   <div class="srr-content"></div>
</article>
```

The `.srr-kicker` masthead is **inside** `.srr-title-row`, so we hide only
`.srr-title-link` (the `<h1>` and its permalink anchor) — never the whole row.
The source-color spine (`.srr-reader[data-src] .srr-title-row`) and the
`SOURCE · date` kicker stay.

**Markup change** — add a permalink anchor to the kicker, in **both**
`index.html` and `src/design.html` (the `design.test.ts` skeleton drift guard
requires the mirror):

```html
<div class="srr-kicker">
   <span class="srr-source"></span>
   <time class="srr-date"></time>
   <a class="srr-kicker-link" aria-label="Open original" rel="noreferrer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><!-- chain-link, stroke style
         matching the existing .srr-config-action-icon SVGs --></svg>
   </a>
</div>
```

The icon is a neutral, universally legible chain-link glyph (no idiom
flourishes) in the same `viewBox="0 0 24 24"` stroke style as the existing
toolbar/config icons.

**`app.ts` `render(o)`** (non-placeholder path):

```ts
const titleless = !!data.db.feeds[o.article.f]?.nt
el.article.classList.toggle("srr-reader-titleless", titleless)

// Permalink: the title-link serves it for normal feeds; the kicker-link
// serves it when the title is hidden. Same URL_DENY guard either way.
const safeLink = o.article.l && !URL_DENY.test(o.article.l) ? o.article.l : ""
if (safeLink) el.kickerLink.href = safeLink
else el.kickerLink.removeAttribute("href")  // hides via :not([href]) CSS
```

- `el.kickerLink` is a new query (`document.querySelector(".srr-kicker-link")`).
- `renderEmptyReader` (placeholder path, early-returns before the above) must
  also clear `srr-reader-titleless` so a lingering class from a prior article
  doesn't bleed into the empty state. (The empty state already hides article
  chrome, so this is belt-and-suspenders.)
- `document.title` / the tab title keep using `o.article.t` — the synthesized
  first line is still a useful tab label even when not shown as a heading.

**CSS** (`src/styles.css`):

```css
.srr-kicker-link { display: none; flex-shrink: 0; color: inherit;
                   margin-left: 0.4rem; }
.srr-kicker-link svg { width: 0.95em; height: 0.95em; }
.srr-kicker-link:hover { color: var(--fg); }
.srr-reader-titleless .srr-title-link { display: none; }
.srr-reader-titleless .srr-kicker-link[href] { display: inline-flex; }
```

A titleless reader with no usable `l` shows no heading and no icon — the body
speaks for itself. The kicker keeps its existing `margin-bottom`, so spacing to
the content is preserved without the title block.

### 3. Setting the flag

The flag is set through the **`feed apply` / `feed edit`** JSON path only — the
single surface needed, since srr-toolbox subscribes channels via config/apply.

- **`feedView`** (`backend/cmd_feeds.go`, the `{id?, title, url, error?, tag?,
  recipe?}` JSON shape) gains `no_title bool` (`json:"no_title,omitempty"`).
  `feed apply` (whole-object replace) and `feed edit` (editor on the same JSON)
  round-trip it; `error` stays read-only as today.
- **serve round-trip safety:** `buildFeedViews`
  (`serve_overview.go`/`serve_feeds.go`) must include `no_title` in the
  projected shape so a GUI feed save reads-and-rewrites it instead of clobbering
  it to false. No dedicated checkbox in this pass (deferred).
- **No standalone `--no-title` CLI flag** on `feed add`/`upd` in this pass
  (deferred — `feed apply`/`edit` cover it).
- **srr-toolbox**: the Telegram channel subscribe step sets `nt: true` once per
  channel feed in the applied JSON. (Out of scope for this repo's code; noted
  for the operator.)

## Components & boundaries

| Unit | Change | Depends on |
|---|---|---|
| `backend/feed.go` | `+NoTitle bool` | — |
| `backend/cmd_gents.go` | none (reflection picks it up) | `Feed` tags |
| `frontend/src/js/format.gen.ts` | regenerated `nt?` | `make generate` |
| `backend/cmd_feeds.go` | `feedView.no_title` (apply/edit) | `Feed` |
| `backend/serve_*.go` | `buildFeedViews` round-trips `no_title` (no checkbox) | `feedView` |
| `frontend/src/index.html` + `design.html` | `.srr-kicker-link` markup | — |
| `frontend/src/js/app.ts` | titleless toggle + kicker permalink | `data.db.feeds`, `URL_DENY` |
| `frontend/src/styles.css` | titleless + kicker-link rules | — |

## Error handling / edge cases

- **Missing/denied `l`** on a titleless article → no heading, no permalink icon.
- **`nt` absent** (every legacy feed) → `?? false` → reader unchanged.
- **Placeholder (no-match) reader** → clear `srr-reader-titleless`.
- **db.gz from an old backend** without `nt` → key simply absent → false.
- **List / search / saved / `document.title`** → unchanged (still use `art.t`).

## Testing

The contract layer (`e2e/contract/`) mounts only `data.ts`/`nav.ts`, not
`app.ts`/the DOM, so the reader-render behavior is tested in the layers that
drive `app.ts`:

- **Backend (Go, in `make verify`):** `feed apply` round-trips `nt` onto the
  `Feed`; `viewOf` (feed edit) and `listViewOf` (serve GUI) both surface it so a
  save can't clobber it. gen-ts freshness is auto-covered by `verify`'s
  `generate-check`.
- **Frontend jsdom (`app.test.ts`, in `make verify`):** drives `app.ts` with a
  feed flagged `nt` and asserts the reader gets `srr-reader-titleless` and the
  masthead permalink (`.srr-kicker-link`) points at the article link; an
  ordinary feed gets neither. Pins the toggle/href wiring on the default gate.
- **Frontend browser e2e (`e2e/browser/titleless.e2e.test.ts`, opt-in via
  `make test-browser`):** real `srrb` writes a `feed apply`-flagged titleless
  feed + an ordinary one; the real built SPA proves the CSS actually hides the
  `<h1>` (offsetParent) and reveals the permalink for the titleless article, and
  the reverse for the ordinary one. Own `beforeAll` clears/rebuilds the shared
  packsDir (browser files run serially).
- **Skeleton drift:** the `.srr-kicker-link` markup is mirrored into
  `design.html` (and `app.test.ts`'s skeleton) so the `design.test.ts` guard and
  the jsdom mount stay in sync.

## Out of scope (YAGNI)

- Content-text heuristics for auto-detecting duplication.
- A separate list-label field / changing list rendering.
- Recipe-level inheritance of the flag (decided: per-feed).
- Standalone `--no-title` CLI flag and a serve-admin checkbox (deferred; set via
  the `feed apply`/`edit` JSON).
- srr-toolbox code changes (operator sets `nt` when subscribing).
