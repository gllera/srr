// picker.ts — the feed / tag filter picker: a full-viewport overlay opened by
// the toolbar's filter button (.srr-filter, both surfaces). Ephemeral (not
// hash-routed) and fixed-position, so the list underneath keeps its scroll
// position untouched while it's open. It owns the filter rows ([ALL], ★ Saved,
// tag groups and feeds — source-color chips, health-tinted labels, async unread
// badges) and the feed/tag/store info dialogs, opened via the header "Info"
// stats toggle: while it's pressed, tapping a row shows that row's detail card
// instead of filtering (the per-row ⓘ buttons this replaces are gone). Picking
// a row normally closes the overlay and re-filters the LIST (app.ts onSelect →
// selectFilter). It also owns the header "Show read" toggle (the unread-only
// view mode — onToggleShowRead flips it via app.ts, which reconciles the
// surface underneath, then the picker re-renders its own rows). The remaining
// settings live on the now-viewing readout's anchored menu (app.ts
// openSettingsMenu), which borrows renderStatus() below for its status footer.
//
// RDR9 ("picker ergonomics at scale") adds three things to that panel, all of
// them local to this module: a type-to-filter row search in the header, a
// remembered scroll offset across opens, and a "★ Favorites" lane above the tag
// groups fed by a third header row-mode.
import { VERSION } from "./base"
import * as data from "./data"
import { wrapTabFocus } from "./dropdown"
import { countBadge, formatBytes, formatDate, isStale, srcColorIndex, timeAgoProse } from "./fmt"
import { favoritesKey, seenKey } from "./keys"
import { mountLabel } from "./mounts"
import * as nav from "./nav"
import * as refresh from "./refresh"
// The row search folds through search.ts's `fold` — the SAME normalizer the
// article index uses (NFD, marks stripped, per-rune lowercase, non-alphanumerics
// as separators, mirrored byte-for-byte with the Go writer). Typing "ambito"
// finds "Ámbito" in the picker exactly as it does in search, and there is one
// folding rule in the reader rather than a hand-synced second copy — the same
// argument urlish.ts makes for its URL regexes.
import { fold } from "./search"
import * as sync from "./sync"
import { URL_DENY } from "./urlish"

export type PickerHooks = {
   // Pick a filter (feed id / tag / "" for [ALL] / ~saved). The caller closes the
   // overlay and shows the LIST under that filter.
   onSelect: (token: string) => void
   // Escape / ✕ → close the overlay back to the list.
   onClose: () => void
   // Flip the unread-only ("Show read") view mode. app.ts owns the nav flip + the
   // surface reconciliation (list rebuild / reader re-probe); the picker only
   // re-renders its own rows afterward (their visibility tracks the mode).
   onToggleShowRead: () => void
   // Switch the active mount from the mount switcher (docs/MULTI-STORE-SPEC.md
   // §6.3). app.ts re-points the active lane + rebuilds the list; the picker
   // re-renders its own rows (now the new store's feeds/tags) in place.
   onSwitchMount: (mid: string) => void
}

let root: HTMLElement
let filterBox: HTMLElement
// The header's "Show read" toggle button — aria-pressed tracks the mode (pressed
// = read articles shown = unread-only OFF), synced on every render().
let showReadBtn: HTMLElement
// The header's "Info" stats toggle — while pressed, tapping a filter row opens
// its detail card instead of filtering.
let statsBtn: HTMLElement
// The header's "★" favorites toggle (RDR9) — while pressed, tapping a FEED row
// marks/unmarks it instead of filtering.
let favBtn: HTMLElement
// What a row tap MEANS. One variable, not two booleans, because the modes are
// mutually exclusive by construction: entering one leaves the other, and a tap
// can never mean two things at once. Ephemeral — reset to "pick" on every
// open(), so the overlay always comes up in its primary picking mode.
type RowMode = "pick" | "info" | "fav"
let rowMode: RowMode = "pick"
let hooks: PickerHooks
// The type-to-filter row search (RDR9).
let searchInput: HTMLInputElement
let searchClearBtn: HTMLElement
// The live query, already trimmed. Applied as a VISIBILITY pass over the rows
// that are already in the DOM (applyQuery) rather than a re-render: rebuilding
// per keystroke would restart fillUnread and drop every badge that had landed.
let query = ""
// Where the panel was scrolled when the query started, restored when it clears —
// narrowing parks you at the top, un-narrowing puts you back.
let preQueryTop = 0
// The "no rows match" note, created with the rows so applyQuery only toggles it.
let emptyNote: HTMLElement | null = null
// Scroll memory across opens (RDR9). Module state, deliberately NOT
// localStorage: it is a within-session convenience ("I was halfway down the
// feed list a moment ago"), and after a reload the row set is rebuilt from a
// store that may have changed underneath, so a persisted offset would land
// somewhere arbitrary. `sig` is the row set the offset was measured against —
// a different one lands at the top, which is the old behaviour.
let scrollMemo: { sig: string; top: number } | null = null
// Signature of the rows currently rendered (see rowSignature).
let rowSig = ""
// Focus restore target across open/close — the readout button that opened the
// overlay (mirrors the modals' restore discipline).
let restoreFocus: HTMLElement | null = null
// The feed / tag info modal (a top-level sibling of the picker overlay, like the
// image-proxy / backup dialogs). Refs grabbed in setup(); closeInfo holds the
// active teardown so a re-open never stacks two.
let infoDialog: HTMLElement | null = null
let infoTitleEl: HTMLElement
let infoBodyEl: HTMLElement
let closeInfo: (() => void) | null = null
let infoFillToken: object | null = null

export function setup(el: HTMLElement, h: PickerHooks): void {
   root = el
   hooks = h
   filterBox = el.querySelector(".srr-picker-filter") as HTMLElement
   ;(el.querySelector(".srr-picker-close") as HTMLElement).addEventListener("click", () => hooks.onClose())
   // The "Show read" toggle: flip the mode via app.ts (which reconciles the
   // surface underneath), then re-render our own rows for the new mode. The
   // overlay stays open — you keep browsing feeds after flipping.
   showReadBtn = el.querySelector(".srr-picker-showread") as HTMLElement
   showReadBtn.addEventListener("click", () => {
      hooks.onToggleShowRead()
      render()
   })
   statsBtn = el.querySelector(".srr-picker-info") as HTMLElement
   statsBtn.addEventListener("click", () => setRowMode(rowMode === "info" ? "pick" : "info"))
   favBtn = el.querySelector(".srr-picker-fav") as HTMLElement
   favBtn.addEventListener("click", () => setRowMode(rowMode === "fav" ? "pick" : "fav"))
   // The type-to-filter search (RDR9). No debounce: the work per keystroke is a
   // class toggle over rows already in the DOM, not a fetch or a rebuild.
   searchInput = el.querySelector(".srr-picker-search-input") as HTMLInputElement
   searchClearBtn = el.querySelector(".srr-picker-search-clear") as HTMLElement
   searchInput.addEventListener("input", () => setQuery(searchInput.value))
   searchClearBtn.addEventListener("click", () => {
      setQuery("")
      searchInput.focus()
   })
   // Escape is progressive: with a query up it clears the query and the overlay
   // STAYS — after typing, the first Escape means "undo the narrowing", not
   // "throw the panel away". Once the query is empty it is not handled here at
   // all, so it bubbles on to app.ts's document-level handler, which closes the
   // overlay exactly as it always did. Bubble phase on the overlay root: app.ts
   // listens on `document`, so stopping propagation here IS "handled".
   root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || query === "") return
      e.preventDefault()
      e.stopPropagation()
      setQuery("")
   })
   // Delegated filter pick: every row carries data-value (feed id / tag / "" /
   // ~saved). The tag collapse toggle stops its own click, but guard anyway.
   // In info mode the same tap routes to the row's detail card instead, and in
   // favorites mode to its ★ mark.
   filterBox.addEventListener("click", (e) => {
      const t = e.target as HTMLElement
      if (t.closest(".srr-tag-toggle")) return
      // A mount switcher row (§6.3): switch the active store in place (the picker
      // stays open; app.ts re-renders our rows for the new store).
      const m = t.closest("[data-mount]") as HTMLElement | null
      if (m) {
         e.preventDefault()
         hooks.onSwitchMount(m.dataset.mount!)
         return
      }
      const a = t.closest("[data-value]") as HTMLElement | null
      if (!a) return
      e.preventDefault()
      if (rowMode === "info") openRowInfo(a.dataset.value!)
      else if (rowMode === "fav") toggleFavorite(a.dataset.value!)
      else hooks.onSelect(a.dataset.value!)
   })
   infoDialog = document.querySelector(".srr-info-dialog")
   if (infoDialog) {
      infoTitleEl = infoDialog.querySelector(".srr-info-title") as HTMLElement
      infoBodyEl = infoDialog.querySelector(".srr-info-body") as HTMLElement
      ;(infoDialog.querySelector(".srr-info-close") as HTMLElement).addEventListener("click", () => closeInfo?.())
   }
}

export function isOpen(): boolean {
   return !root.hidden
}

export function open(): void {
   if (root.hidden) restoreFocus = document.activeElement as HTMLElement | null
   setRowMode("pick")
   // A query does not survive a close: a panel that comes up already narrowed
   // reads as "my feeds are missing", the same trap statsMode avoids by
   // resetting. The remembered SCROLL offset below is the opposite case — it
   // hides nothing, it only picks where the same full list starts.
   setQuery("")
   render()
   root.hidden = false
   // The overlay owns its own scroll (the list's window scroll is untouched
   // underneath). Come back where you left off — but only when the panel still
   // describes the same rows: a store refresh that added or dropped feeds, or a
   // Show-read flip, makes a remembered offset point at a different lane, so
   // those land at the top ([ALL] / ★ Saved first) exactly as before.
   root.scrollTop = scrollMemo && scrollMemo.sig === rowSig ? scrollMemo.top : 0
   // Focus the overlay container so Escape/arrows land here without painting a
   // row pre-selected (:focus-visible fires on programmatic focus — the same
   // reasoning as the context menu's container focus).
   root.tabIndex = -1
   root.focus()
}

export function close(): void {
   if (root.hidden) return
   // Remember where the panel was, against the row set that offset describes.
   // An offset measured while a query was narrowing the list describes rows
   // that are about to come back, so it is worth nothing — remember the top.
   scrollMemo = { sig: rowSig, top: query === "" ? root.scrollTop : 0 }
   root.hidden = true
   restoreFocus?.focus()
   restoreFocus = null
}

export function render(): void {
   // Pressed = read articles are shown (unread-only OFF) — the button reads as
   // "this option is active", the standard toggle-button semantic.
   showReadBtn.setAttribute("aria-pressed", String(!nav.isUnreadOnly()))
   renderFilterList()
}

// The header mode toggles: they flip what a row tap MEANS (pick the filter /
// open the row's detail card / mark it a favorite). The rows themselves don't
// change — the root classes are styling hooks for each mode's cursor and
// affordance, and the pressed button is what announces the changed meaning.
function setRowMode(m: RowMode): void {
   rowMode = m
   statsBtn.setAttribute("aria-pressed", String(m === "info"))
   favBtn.setAttribute("aria-pressed", String(m === "fav"))
   root.classList.toggle("srr-picker-statsmode", m === "info")
   root.classList.toggle("srr-picker-favmode", m === "fav")
}

// ── Type-to-filter (RDR9) ────────────────────────────────────────────────────

// The haystack a row is matched against, folded ONCE at build time and parked on
// the node. Not the row's textContent: that grows an "×12" unread badge as
// fillUnread lands, which would make a numeric query match arbitrary rows and
// would make a row's matchability depend on when you typed.
function stampMatch(el: HTMLElement, ...parts: string[]): void {
   el.dataset.match = fold(parts.join(" "))
}

function rowMatches(el: HTMLElement, q: string): boolean {
   return (el.dataset.match ?? "").includes(q)
}

// Set the live query and re-run the visibility pass. Called from the input, the
// ✕ clear, Escape, and open() (which always resets it).
function setQuery(next: string): void {
   const q = next.trim()
   if (searchInput.value !== next) searchInput.value = next // programmatic clears
   if (q === query) return
   // Entering the narrowed view parks the scroll at the top (the matches are up
   // there, wherever you had scrolled to); leaving it puts you back.
   if (query === "" && q !== "") preQueryTop = root.scrollTop
   query = q
   searchClearBtn.hidden = q === ""
   root.classList.toggle("srr-picker-filtering", q !== "")
   applyQuery()
   root.scrollTop = q === "" ? preQueryTop : 0
}

// Narrow the rendered rows to the query — a class toggle over nodes that are
// already in the DOM, so the async unread badges (and the fill in flight behind
// them) are untouched. `srr-qhidden` is its OWN hide reason, composing with the
// unread-only mode's `srr-hidden` rather than fighting it: a row hidden as
// fully-read stays hidden whether or not it matches.
function applyQuery(): void {
   const q = fold(query)
   const on = q !== ""
   let hits = 0
   const show = (el: HTMLElement, vis: boolean) => {
      el.classList.toggle("srr-qhidden", !vis)
      // Only rows the MODE is also showing count as hits — otherwise a store
      // whose matches are all fully-read would claim results and show none.
      if (vis && !el.classList.contains("srr-hidden")) hits++
   }

   // Tag groups: a header that matches shows its whole group; otherwise the
   // group survives on its matching members alone. Either way a surviving group
   // is force-expanded while filtering — a collapsed group would answer a query
   // with an empty panel.
   for (const group of filterBox.querySelectorAll<HTMLElement>(".srr-tag-group")) {
      const header = group.querySelector<HTMLElement>(".srr-tag-header")
      const whole = !on || (header !== null && rowMatches(header, q))
      let shown = 0
      for (const item of group.querySelectorAll<HTMLElement>(".srr-tag-item")) {
         const vis = whole || rowMatches(item, q)
         item.classList.toggle("srr-qhidden", !vis)
         if (vis && !item.classList.contains("srr-hidden")) shown++
      }
      const vis = whole || shown > 0
      group.classList.toggle("srr-qhidden", !vis)
      group.classList.toggle("srr-qexpand", on && vis)
      if (vis) hits += Math.max(shown, 1)
   }
   // Untagged feeds and the two scope chips, each on its own.
   for (const row of filterBox.querySelectorAll<HTMLElement>(":scope > a[data-value], .srr-scope-chip")) {
      show(row, !on || rowMatches(row, q))
   }
   // The tag separator is a rule between two groups of rows; with either side
   // filtered away it would be a stray line.
   for (const sep of filterBox.querySelectorAll<HTMLElement>(".srr-tag-sep")) sep.classList.toggle("srr-qhidden", on)
   // The mount switcher is deliberately NOT filtered: it is the STORE axis, not
   // a lane, and hiding the way back to another store because its label doesn't
   // contain a feed name would be a trap.
   if (emptyNote) {
      emptyNote.hidden = !on || hits > 0
      emptyNote.textContent = `No feeds or tags match “${query}”`
   }
}

// ── Favorites (RDR9) ─────────────────────────────────────────────────────────

// The favorite feed ids, device-local and per-store (keys.ts favoritesKey — a
// feed id only means something inside its own mount). Storage that throws
// (private mode, disabled by policy) degrades to "no favorites"; the lane is a
// convenience and must never be able to break the panel.
function readFavorites(): Set<number> {
   try {
      const raw = localStorage.getItem(favoritesKey(data.activeStore().mid))
      const arr: unknown = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(arr) ? arr.filter((v): v is number => typeof v === "number") : [])
   } catch {
      return new Set()
   }
}

function writeFavorites(ids: Set<number>): void {
   try {
      localStorage.setItem(favoritesKey(data.activeStore().mid), JSON.stringify([...ids]))
   } catch {
      // Full or disabled storage: the mark applies to this render and is lost
      // on reload, which is strictly better than throwing out of a row tap.
   }
}

// A favorites-mode row tap. Only FEEDS have favorites — a tag is already a lane
// and the scope chips are meta filters, so both are inert here, the same way
// ★ Saved is inert in stats mode.
function toggleFavorite(value: string): void {
   if (!/^\d+$/.test(value)) return
   const id = Number(value)
   const favs = readFavorites()
   if (!favs.delete(id)) favs.add(id)
   writeFavorites(favs)
   // The lane is part of the rendered rows, so the mark rebuilds them. Hold the
   // offset across the rebuild so the row you just tapped stays under your
   // thumb (the lane appearing or vanishing above it still shifts the rows by
   // its own height — that motion IS the feedback for the mark).
   const top = root.scrollTop
   render()
   root.scrollTop = top
}

// ── Filter list ──────────────────────────────────────────────────────────────

function link(value: string, text: string, className?: string): HTMLAnchorElement {
   const a = document.createElement("a")
   a.href = "#"
   a.dataset.value = value
   stampMatch(a, text)
   // Title rides in its own span so a flex row (scope chip / feed / tag
   // header — every row is one) ellipsizes it while chips / counts keep
   // their size.
   const title = document.createElement("span")
   title.className = "srr-row-title"
   title.textContent = text
   a.appendChild(title)
   if (className) a.className = className
   return a
}

function div(className: string): HTMLDivElement {
   const d = document.createElement("div")
   d.className = className
   return d
}

// Feed-health grade for the row's health tint (ported from dropdown.ts). "" healthy,
// "warn" amber, "crit" red. Degrades gracefully when the new vitals are absent.
const STALE_WARN_SEC = 3 * 86400
const STALE_CRIT_SEC = 14 * 86400
const FAIL_STREAK_CRIT = 3
function feedGrade(ch: IFeed): "" | "warn" | "crit" {
   const ferr = ch.ferr ?? ""
   const streak = ch.fail_streak ?? 0
   const lastOK = ch.last_ok ?? 0
   if (ferr || streak >= FAIL_STREAK_CRIT) return "crit"
   if (lastOK > 0) {
      const ageSec = Date.now() / 1000 - lastOK
      if (ageSec >= STALE_CRIT_SEC) return "crit"
      if (ageSec >= STALE_WARN_SEC) return "warn"
   }
   return ""
}

function srcChip(feedId: number): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-src-chip"
   s.dataset.src = String(srcColorIndex(feedId))
   s.setAttribute("aria-hidden", "true")
   return s
}

function feedLink(ch: IFeed, className: string, fav: boolean): HTMLAnchorElement {
   const a = link(String(ch.id), ch.title, `${className} srr-feed-row`.trim())
   // A feed is findable by its tag as well as its name: typing a desk shows the
   // feeds filed under it even when the collapsed group header is off screen.
   stampMatch(a, ch.title, ch.tag ?? "")
   if (fav) {
      a.dataset.fav = "1"
      const star = document.createElement("span")
      star.className = "srr-fav-star"
      // aria-hidden: the ★ Favorites lane, with a real text header, is what
      // carries this membership non-visually — the glyph would otherwise read
      // out on every row of that lane AND its twin in the tag group.
      star.setAttribute("aria-hidden", "true")
      star.textContent = "★"
      a.appendChild(star)
   }
   const grade = feedGrade(ch)
   if (grade !== "") {
      const ferr = ch.ferr ?? ""
      if (ferr) {
         a.title = ferr
         a.setAttribute("aria-label", `${ch.title} — feed error: ${ferr}`)
      } else {
         // Stale-by-age (no ferr): give the row a non-color text cue too, so the
         // health state reaches screen-reader / hover users, not just sighted ones.
         const note = grade === "crit" ? "feed may be unavailable" : "feed may be stale"
         a.title = note
         a.setAttribute("aria-label", `${ch.title} — ${note}`)
      }
      // Health shows as a label tint (data-grade → CSS colors the title). No
      // leading dot, so the label's left edge is unchanged. The title/aria-label
      // (above) carries the state non-visually.
      a.dataset.grade = grade
   }
   a.prepend(srcChip(ch.id))
   return a
}

// The inline unread count, reading as one phrase with the name it follows:
// "Source ×12" (italic, slightly smaller — CSS).
function unreadBadge(n: number): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-unread"
   s.textContent = `×${countBadge(n)}`
   return s
}

// Which tag group to auto-expand: the active tag filter, or the tag of the active
// single-feed filter so you can see where you are.
function activeTag(): string {
   const key = nav.getCurrentFilterKey()
   if (key === "" || key === nav.SAVED_TOKEN) return ""
   if (/^\d+$/.test(key)) return data.db.feeds[Number(key)]?.tag ?? ""
   return key
}

let fillToken: object | null = null

// The rendered row set, as a string: the ordered row tokens plus the view mode
// that decides which of them are visible. Two opens with the same signature are
// looking at the same panel, which is exactly when a remembered scroll offset
// still points at the row it was measured against. (Deliberately coarse: the
// async unread fill can hide fully-read rows WITHIN one mode without changing
// the signature. That drift is bounded by one fill and self-corrects on the
// next open; a signature that tracked it would have to wait for the fill,
// which is the one thing open() must not do.)
function rowSignature(): string {
   const rows = filterBox.querySelectorAll<HTMLElement>("[data-value], [data-mount], .srr-fav-header")
   const tokens = [...rows].map((e) => e.dataset.value ?? (e.dataset.mount !== undefined ? `@${e.dataset.mount}` : "★"))
   return `${nav.isUnreadOnly() ? "u" : "a"}|${tokens.join(",")}`
}

function renderFilterList(): void {
   // When read items are shown (unread-only off) the picker also lists feeds with
   // no articles yet (never-fetched / empty), so they can be inspected or picked;
   // unread-only mode lists only feeds that have articles (and fillUnread further
   // hides the fully-read ones below).
   const { tagged, sortedTags, untagged } = data.groupFeedsByTag(!nav.isUnreadOnly())
   const current = nav.getCurrentFilterKey()
   const currentTag = activeTag()
   const cls = (base: string, v: string) => (v === current ? `${base} srr-active`.trim() : base)
   const frag = document.createDocumentFragment()
   const unreadRows: [HTMLAnchorElement, IFeed][] = []
   const headerRows: [HTMLElement, IFeed[]][] = []
   const favs = readFavorites()

   // The mount switcher (docs/MULTI-STORE-SPEC.md §6.3) — the store axis ABOVE
   // tags and feeds. Shown ONLY when more than one store is mounted, so a
   // single-store user's picker is byte-identical. The active store's lanes
   // render below; tapping another mount switches the active store in place.
   const mounted = data.mountedStores()
   if (mounted.length > 1) frag.appendChild(renderMounts(mounted))

   // The two meta filters ride side by side as a scope-chip pair above the
   // feed rows — they aren't feeds (no source chip, no health), so they read
   // as scope pills rather than list members. [ALL]'s unread count (the
   // whole-store total) fills in async like every row's; ★ Saved only shows
   // when something is saved, and [ALL] goes full-width alone until then.
   const scope = div("srr-picker-scope")
   const allRow = link("", "[ALL]", cls("srr-scope-chip", ""))
   scope.appendChild(allRow)
   const savedN = nav.savedCount()
   if (savedN > 0) {
      const savedRow = link(nav.SAVED_TOKEN, "★ Saved", cls("srr-scope-chip", nav.SAVED_TOKEN))
      const num = document.createElement("span")
      num.className = "srr-saved-num"
      // Same inline "×N" phrase as the unread counts, so the two chips read alike.
      num.textContent = `×${savedN}`
      savedRow.appendChild(num)
      scope.appendChild(savedRow)
   }
   frag.appendChild(scope)

   // ★ Favorites — the pinned lane above the tag groups (RDR9). A favorite is
   // rendered here IN ADDITION to its normal row, not moved out of it: the tag
   // groups mirror how the feeds are FILED (the wire's own `tag`), and a header
   // whose health tint and unread rollup describe members it no longer lists
   // would simply be lying; the active-filter auto-expand ("show me where I
   // am") also has to find the feed inside its tag. A favorite is a shortcut,
   // not a re-filing — so it appears twice, and the one place that would
   // double-count it (the [ALL] total) sums over distinct feeds instead.
   const favFeeds = [...sortedTags.flatMap((t) => tagged.get(t)!), ...untagged].filter((ch) => favs.has(ch.id))
   if (favFeeds.length > 0) {
      const groupDiv = div("srr-tag-group srr-fav-group")
      // A plain div, not a link: the lane is a VIEW of feeds you marked, not a
      // filter token nav can resolve, so a tap on it has nothing to select.
      const header = div("srr-tag-header srr-fav-header")
      const title = document.createElement("span")
      title.className = "srr-row-title"
      title.textContent = "★ Favorites"
      header.appendChild(title)
      stampMatch(header, "★ Favorites")
      headerRows.push([header, favFeeds])
      const toggle = document.createElement("span")
      toggle.className = "srr-tag-toggle"
      toggle.addEventListener("click", (e) => {
         e.preventDefault()
         e.stopPropagation()
         groupDiv.classList.toggle("srr-tag-collapsed")
      })
      header.appendChild(toggle)
      groupDiv.appendChild(header)
      for (const ch of favFeeds) {
         const item = feedLink(ch, cls("srr-tag-item", String(ch.id)), true)
         unreadRows.push([item, ch])
         groupDiv.appendChild(item)
      }
      frag.appendChild(groupDiv)
   }

   for (const tag of sortedTags) {
      const group = tagged.get(tag)!
      const expanded = tag === currentTag && tag !== current
      const groupDiv = div(expanded ? "srr-tag-group" : "srr-tag-group srr-tag-collapsed")
      const header = link(tag, tag, cls("srr-tag-header", tag))
      const worst = group.reduce<"" | "warn" | "crit">(
         (g, ch) => (g === "crit" || feedGrade(ch) === "crit" ? "crit" : feedGrade(ch) || g),
         "",
      )
      if (worst) {
         header.dataset.grade = worst
         header.title = worst === "crit" ? "a feed in this tag may be unavailable" : "a feed in this tag may be stale"
      }
      headerRows.push([header, group])
      const toggle = document.createElement("span")
      toggle.className = "srr-tag-toggle"
      toggle.addEventListener("click", (e) => {
         e.preventDefault()
         e.stopPropagation()
         groupDiv.classList.toggle("srr-tag-collapsed")
      })
      header.appendChild(toggle)
      groupDiv.appendChild(header)
      for (const ch of group) {
         const item = feedLink(ch, cls("srr-tag-item", String(ch.id)), favs.has(ch.id))
         unreadRows.push([item, ch])
         groupDiv.appendChild(item)
      }
      frag.appendChild(groupDiv)
   }

   if (sortedTags.length > 0 && untagged.length > 0) frag.appendChild(div("srr-tag-sep"))
   for (const ch of untagged) {
      const item = feedLink(ch, cls("", String(ch.id)), favs.has(ch.id))
      unreadRows.push([item, ch])
      frag.appendChild(item)
   }

   // The row-search's empty state, built with the rows so applyQuery only has to
   // toggle it. role=status so a narrowing that finds nothing is announced.
   emptyNote = div("srr-picker-empty")
   emptyNote.setAttribute("role", "status")
   emptyNote.hidden = true
   frag.appendChild(emptyNote)

   filterBox.replaceChildren(frag)
   // The signature the scroll memory is compared against — every row token in
   // render order (favorites duplicate deliberately: gaining or losing the lane
   // IS a different panel) plus the view mode.
   rowSig = rowSignature()
   // Re-apply the live query: render() is also called with one up (the Show-read
   // flip, a favorite mark), and the fresh rows come out unfiltered.
   applyQuery()
   void fillUnread(unreadRows, headerRows, allRow)
}

// The per-mount status chip (docs/MULTI-STORE-SPEC.md §8.3). A CORS rejection and
// a network outage are indistinguishable to fetch, so the chip is honest about
// that when online rather than claiming a cause.
function mountChip(status: data.MountStatus): string {
   if (status.state === "ok") return ""
   if (status.kind === "toonew") return "Too new"
   if (status.kind === "offline") return navigator.onLine === false ? "Offline" : "Unreachable"
   return "Error"
}

// A mounted store's approximate total unread — the latest-pack tally summed
// (exact for a small store, a hint for one with frontiers deep in finalized
// packs). Read against the store's OWN namespaced seen map.
function storeUnread(store: data.Store): number {
   try {
      if (!store.db || store.db.total_art === 0) return 0
      let seen: Record<string, number> = {}
      try {
         seen = JSON.parse(localStorage.getItem(seenKey(store.mid)) || "{}") as Record<string, number>
      } catch {
         seen = {}
      }
      const feeds = Object.values(store.db.feeds) as IFeed[]
      if (feeds.length === 0) return 0
      const { counts } = data.unreadTally(feeds, (id: number) => seen["feed:" + id], store)
      let sum = 0
      for (const v of counts.values()) sum += v
      return sum
   } catch {
      return 0
   }
}

// The mount switcher: the store axis above tags/feeds (§6.3). Home first, then
// peers by ord (data.mountedStores order). The active store wears srr-active; an
// errored store shows a state chip instead of an unread rollup and is inert
// (setActive refuses it — no usable db). Rows carry data-mount for the delegated
// click handler in setup().
function renderMounts(stores: data.Store[]): HTMLElement {
   const activeMid = data.activeStore().mid
   const labels = new Map(data.mountRecords().map((r) => [r.id, mountLabel(r)]))
   const box = div("srr-picker-mounts")
   for (const s of stores) {
      const status = data.mountStatus(s.mid)
      const row = document.createElement("a")
      row.href = "#"
      row.dataset.mount = s.mid
      row.className = "srr-mount-row" + (s.mid === activeMid ? " srr-active" : "")
      const title = document.createElement("span")
      title.className = "srr-row-title"
      title.textContent = labels.get(s.mid) ?? s.mid
      row.appendChild(title)
      const chip = mountChip(status)
      if (chip) {
         const c = document.createElement("span")
         c.className = "srr-mount-chip"
         c.dataset.kind = status.kind
         c.textContent = chip
         row.appendChild(c)
      } else {
         const n = storeUnread(s)
         if (n > 0) {
            const num = document.createElement("span")
            num.className = "srr-unread"
            num.textContent = `×${countBadge(n)}`
            row.appendChild(num)
         }
      }
      box.appendChild(row)
   }
   return box
}

// Unread badges fill in after the list renders so a cold seen position never
// delays the panel. One freshness token guards every DOM write (a re-render or
// close orphans a stale pass). When unread-only is on, fully-read rows/tags hide.
async function fillUnread(
   rows: [HTMLAnchorElement, IFeed][],
   headers: [HTMLElement, IFeed[]][],
   allRow: HTMLAnchorElement,
) {
   const my = {}
   fillToken = my
   try {
      // DISTINCT feeds: the ★ Favorites lane renders a favorite a second time,
      // so both the count request and — critically — [ALL]'s total have to be
      // taken over the set, not the rows. Summing the rows would count every
      // favorite twice and put the picker's headline number above the reader's
      // pending pill, the exact class of bug the badge↔pill oracle exists for.
      const distinct = [...new Map(rows.map(([, ch]) => [ch.id, ch])).values()]
      const counts = await nav.unreadCounts(distinct)
      if (my !== fillToken) return
      // [ALL]'s number is the whole backlog — the sum over every listed feed
      // (rows the mode hides as fully-read contribute 0). Absent at zero, like
      // every row's badge.
      const total = nav.tagUnreadFromCounts(distinct, counts)
      if (total > 0) allRow.appendChild(unreadBadge(total))
      const hideRead = nav.isUnreadOnly()
      const activeKey = nav.getCurrentFilterKey()
      for (const [a, ch] of rows) {
         const n = counts.get(ch.id)!
         // Flex rows: the count sits inline right after the (shrink-to-fit)
         // title — "Source ×12" — so the title ellipsizes ahead of it. On a
         // favorite the trailing ★ is pinned to the row's far edge, so the badge
         // goes BEFORE it and the "name ×N" phrase stays unbroken.
         if (n > 0) a.insertBefore(unreadBadge(n), a.querySelector(".srr-fav-star"))
         if (hideRead && n === 0 && String(ch.id) !== activeKey) a.classList.add("srr-hidden")
      }
      headers.forEach(([h, group]) => {
         const n = nav.tagUnreadFromCounts(group, counts)
         if (n > 0) h.insertBefore(unreadBadge(n), h.querySelector(".srr-tag-toggle"))
         if (
            hideRead &&
            h.dataset.value !== activeKey &&
            !group.some((ch) => String(ch.id) === activeKey) &&
            group.every((ch) => counts.get(ch.id) === 0)
         )
            h.closest(".srr-tag-group")?.classList.add("srr-hidden")
      })
      // The fill just changed which rows the MODE shows, and the query's
      // "nothing matches" note counts only rows both passes agree on — so
      // re-run the narrowing over the settled row set.
      if (query !== "") applyQuery()
   } catch {
      // Best-effort decoration; the list works without badges.
   }
}

// ── Status ───────────────────────────────────────────────────────────────────

// A flagged status — an amber caution row with a leading dot, matching the
// graded-health "warn" used by the feed-error dots and the feed info card.
function statusFlag(text: string): HTMLElement {
   const row = document.createElement("div")
   row.className = "srr-status-flag"
   const dot = document.createElement("span")
   dot.className = "srr-status-dot"
   dot.setAttribute("aria-hidden", "true")
   row.append(dot, text)
   return row
}

// A quiet progress note (benign, no caution color).
function statusNote(text: string): HTMLElement {
   const row = document.createElement("div")
   row.className = "srr-status-note"
   row.textContent = text
   return row
}

// The freshness / degradation block — the settings menu's footer (app.ts builds
// the node and hands it to showContextMenu). The neutral "Updated …" fact reads
// muted and stays relative-only (the absolute date would crowd a menu footer);
// anything wrong is broken out as its own amber flag row rather than tinting
// the whole line. Rebuilt unconditionally — the footer is built per menu open,
// and the live sync callback re-fills the same node in place.
export function renderStatus(box: HTMLElement): void {
   const fetchedAt = data.lastFetchedAt()
   const metaMissing = data.hasArticles() && !data.metaReady()
   const syncState = sync.state()
   const refreshErr = refresh.lastRefreshError()

   box.replaceChildren()
   if (fetchedAt > 0) {
      const fresh = document.createElement("div")
      fresh.className = "srr-status-fresh"
      fresh.textContent = `Updated ${timeAgoProse(fetchedAt)}`
      box.append(fresh)
      if (isStale(fetchedAt)) box.append(statusFlag("Feed updates may have paused"))
   }
   if (metaMissing) box.append(statusFlag("Search unavailable while the index rebuilds"))
   if (data.idxSummaryDegraded()) box.append(statusNote("Optimizing for faster loading…"))
   // Sync readout, only when a sync endpoint is configured: a quiet "Synced …"
   // note while healthy, an amber flag with the failure when the last cycle
   // errored, and a pending note before the first cycle completes.
   if (syncState.on) {
      if (syncState.error) box.append(statusFlag(`Sync failed — ${syncState.error}`))
      else if (syncState.okAt > 0) box.append(statusNote(`Synced ${timeAgoProse(syncState.okAt)}`))
      else box.append(statusNote("Sync pending…"))
   }
   // The last background content-refresh failure — this row is the only place
   // it reaches the user (a page reload is the manual recovery gesture).
   if (refreshErr) box.append(statusFlag(`Refresh failed — ${refreshErr}`))
   // The build's version label, always last and always present (even on an
   // empty store — it's exactly what a bug report needs). VERSION is base.ts's
   // build-time define: the release tag in CI builds, "dev" locally.
   const ver = document.createElement("div")
   ver.className = "srr-status-version"
   ver.textContent = `srr ${VERSION}`
   box.append(ver)
}

// ── Feed / tag info dialog ─────────────────────────────────────────────────────

// A read-only detail card opened by tapping a row in stats mode (the header
// Info toggle). Lays the feed/tag's stored fields out in grouped definition
// grids; the live unread counts (idx-derived, async) fill in after the card
// shows, guarded by infoFillToken so a close / re-open orphans a stale pass.
// Reader-facing on purpose: internal bookkeeping (feed ids, HTTP validators,
// dedup/pack state, processing recipes) stays off the card — the admin GUI is
// where operators look.

// Stats-mode row routing: each row token opens its own card flavor — [ALL] the
// store rollup, a feed its detail card, a tag its member rollup. ★ Saved has no
// stored stats of its own (its count is already on the row), so it's inert.
function openRowInfo(value: string): void {
   if (value === "") return openStoreInfo()
   if (value === nav.SAVED_TOKEN) return
   if (/^\d+$/.test(value)) {
      const ch = data.db.feeds[Number(value)]
      if (ch) openFeedInfo(ch)
      return
   }
   openTagInfo(value)
}

function infoSection(title: string): { sec: HTMLElement; dl: HTMLDListElement } {
   const sec = document.createElement("section")
   sec.className = "srr-info-sec"
   const h = document.createElement("h3")
   h.className = "srr-info-sec-title"
   h.textContent = title
   const dl = document.createElement("dl")
   dl.className = "srr-info-grid"
   sec.append(h, dl)
   return { sec, dl }
}

function addRow(dl: HTMLDListElement, label: string, value: string | Node, ddClass?: string): void {
   const dt = document.createElement("dt")
   dt.textContent = label
   const dd = document.createElement("dd")
   if (ddClass) dd.className = ddClass
   if (typeof value === "string") dd.textContent = value
   else dd.appendChild(value)
   dl.append(dt, dd)
}

// A colored dot + word for a feed/tag health grade, reusing feedGrade()'s scale.
function healthChip(grade: "" | "warn" | "crit"): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-info-health"
   if (grade) s.dataset.grade = grade
   s.append(document.createTextNode(grade === "crit" ? "Error" : grade === "warn" ? "Stale" : "Healthy"))
   return s
}

// Absolute date + relative age for a unix timestamp; `fallback` when it's 0.
function fmtTime(t: number, fallback: string): string {
   return t > 0 ? `${formatDate(t)} (${timeAgoProse(t)})` : fallback
}

function buildFeedInfo(ch: IFeed): DocumentFragment {
   const frag = document.createDocumentFragment()
   const grade = feedGrade(ch)
   const ferr = ch.ferr ?? ""

   const src = infoSection("Source")
   const a = document.createElement("a")
   // Defense-in-depth: only link out when the URL's scheme is allowed (mirrors the
   // reader's article-link guard in app.ts); a denied scheme renders as plain text.
   if (!URL_DENY.test(ch.url)) a.href = ch.url
   a.textContent = ch.url
   a.className = "srr-info-link"
   a.rel = "noreferrer"
   addRow(src.dl, "URL", a)
   addRow(src.dl, "Tag", ch.tag || "Untagged")
   frag.appendChild(src.sec)

   const content = infoSection("Content")
   addRow(content.dl, "Articles", String(ch.total_art - (ch.xp ?? 0)))
   addRow(content.dl, "Unread", "…", "srr-info-unread")
   // The feed's store footprint, in plain units: cb = the article text it added
   // to the data packs (cumulative — expiration is logical, the bytes stay),
   // ab = its live self-hosted assets. Assets only show when there are any.
   addRow(content.dl, "Stored content", formatBytes(ch.cb ?? 0))
   const media = ch.ab ?? 0
   if (media > 0) addRow(content.dl, "Stored assets", formatBytes(media))
   // The retention policy (exp = ExpireDays), in plain words: how long this
   // feed's articles are kept before they expire; 0/absent = kept forever.
   const days = ch.exp ?? 0
   addRow(content.dl, "Retention", days > 0 ? (days === 1 ? "1 day" : `${days} days`) : "Forever")
   frag.appendChild(content.sec)

   const health = infoSection("Health")
   addRow(health.dl, "Status", healthChip(grade))
   addRow(health.dl, "Last fetched", fmtTime(ch.last_ok ?? 0, "Never"))
   addRow(health.dl, "Last new article", fmtTime(ch.last_new ?? 0, "—"))
   addRow(health.dl, "Latest published", fmtTime(ch.wm ?? 0, "—"))
   if ((ch.fail_streak ?? 0) > 0) addRow(health.dl, "Failed attempts", String(ch.fail_streak))
   if (ferr) {
      const box = document.createElement("p")
      box.className = "srr-info-error"
      box.textContent = ferr
      health.sec.appendChild(box)
   }
   frag.appendChild(health.sec)

   return frag
}

function openFeedInfo(ch: IFeed): void {
   openInfoDialog(ch.title, buildFeedInfo(ch))
   void fillFeedUnread(ch)
}

// Fill the feed's live (idx-derived, async) unread count after the card shows.
// A single feed's card is the store-wide fill scoped to one feed:
// tagUnreadFromCounts([ch], counts) reduces to counts.get(ch.id) ?? 0 (clamped
// ≥ 0), so this is a strict special case of fillStoreUnread — share its
// token-guarded body rather than duplicate it.
function fillFeedUnread(ch: IFeed): Promise<void> {
   return fillStoreUnread([ch])
}

// A feed-group rollup card body — the store ([ALL]) and a tag share the shape:
// inventory, storage footprint, and a health census of every member's grade.
// storeWide adds the rows only the whole store can answer (Tags, Saved).
// Freshness and the search-index state stay out (the settings menu's status
// footer owns both), and pack internals (generation, latest-pack names) never
// show.
function buildGroupInfo(feeds: IFeed[], storeWide: boolean): DocumentFragment {
   const frag = document.createDocumentFragment()

   const content = infoSection("Content")
   addRow(content.dl, "Feeds", String(feeds.length))
   if (storeWide) addRow(content.dl, "Tags", String(new Set(feeds.map((ch) => ch.tag).filter(Boolean)).size))
   // Live count, expired excluded — the same semantics as the feed card's row.
   addRow(content.dl, "Articles", String(feeds.reduce((sum, ch) => sum + ch.total_art - (ch.xp ?? 0), 0)))
   addRow(content.dl, "Unread", "…", "srr-info-unread")
   if (storeWide) addRow(content.dl, "Saved", String(nav.savedCount()))
   // Group footprint summed over every member — same rows as the feed card.
   addRow(content.dl, "Stored content", formatBytes(feeds.reduce((sum, ch) => sum + (ch.cb ?? 0), 0)))
   const media = feeds.reduce((sum, ch) => sum + (ch.ab ?? 0), 0)
   if (media > 0) addRow(content.dl, "Stored assets", formatBytes(media))
   frag.appendChild(content.sec)

   // The health census: feedGrade counts in the chip vocabulary (Healthy /
   // Stale / Error). Problem rows appear only when nonzero, so a healthy group
   // reads as one quiet line.
   const health = infoSection("Health")
   const grades = feeds.map(feedGrade)
   addRow(health.dl, "Healthy", String(grades.filter((g) => g === "").length))
   const warn = grades.filter((g) => g === "warn").length
   const crit = grades.filter((g) => g === "crit").length
   if (warn > 0) addRow(health.dl, "Stale", String(warn))
   if (crit > 0) addRow(health.dl, "Error", String(crit))
   frag.appendChild(health.sec)

   return frag
}

function openStoreInfo(): void {
   const feeds = Object.values(data.db.feeds ?? {})
   openInfoDialog("All feeds", buildGroupInfo(feeds, true))
   void fillStoreUnread(feeds)
}

// A tag row's card: the store rollup scoped to the tag's member feeds. The
// members come from the same grouping the rendered rows do, so the card always
// describes exactly the feeds listed under the header it was opened from.
function openTagInfo(tag: string): void {
   const group = data.groupFeedsByTag(!nav.isUnreadOnly()).tagged.get(tag)
   if (!group?.length) return
   openInfoDialog(tag, buildGroupInfo(group, false))
   void fillStoreUnread(group)
}

// The feed card's async live-unread fill, summed store-wide.
async function fillStoreUnread(feeds: IFeed[]): Promise<void> {
   const my = {}
   infoFillToken = my
   try {
      const counts = await nav.unreadCounts(feeds)
      if (my !== infoFillToken) return
      const el = infoBodyEl.querySelector(".srr-info-unread")
      if (el) el.textContent = String(nav.tagUnreadFromCounts(feeds, counts))
   } catch {
      // Best-effort: the card stands on its stored fields; the count stays "…".
   }
}

// Centered modal shell, mirroring the image-proxy / backup dialogs: dimmed
// backdrop, capture-phase Escape + Tab focus trap, backdrop-click close, focus
// restored to the opener (the filter row tapped in stats mode). Body is
// rebuilt per open.
function openInfoDialog(title: string, body: Node): void {
   const dialog = infoDialog
   if (!dialog) return
   if (closeInfo) closeInfo() // never stack two opens
   const restore = document.activeElement as HTMLElement | null
   infoTitleEl.textContent = title
   infoBodyEl.replaceChildren(body)

   const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
         e.preventDefault()
         e.stopPropagation()
         close()
      } else if (e.key === "Tab") {
         wrapTabFocus(e, dialog, "a[href], button, [tabindex]")
      }
   }
   const onDown = (e: MouseEvent) => {
      if (e.target === dialog) close()
   }
   const close = () => {
      dialog.classList.remove("srr-open")
      infoBodyEl.replaceChildren()
      infoFillToken = null
      document.removeEventListener("keydown", onKey, true)
      dialog.removeEventListener("mousedown", onDown)
      closeInfo = null
      restore?.focus()
   }
   closeInfo = close

   dialog.classList.add("srr-open")
   document.addEventListener("keydown", onKey, true)
   dialog.addEventListener("mousedown", onDown)
   ;(dialog.querySelector(".srr-info-close") as HTMLElement | null)?.focus()
}
