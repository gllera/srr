// picker.ts — the feed / tag filter picker: a full-viewport overlay opened by
// the toolbar's filter button (.srr-filter, both surfaces). Ephemeral (not
// hash-routed) and fixed-position, so the list underneath keeps its scroll
// position untouched while it's open. It owns the filter rows ([ALL], ★ Saved,
// tag groups and feeds — source-color chips, health-tinted labels, async unread
// badges, ⓘ detail buttons) and the feed/tag/store info dialogs those ⓘ buttons
// open. Picking a row closes the overlay and re-filters the LIST (app.ts
// onSelect → selectFilter). It also owns the header "Show read" toggle (the
// unread-only view mode — onToggleShowRead flips it via app.ts, which reconciles
// the surface underneath, then the picker re-renders its own rows). The remaining
// settings live on the now-viewing readout's anchored menu (app.ts
// openSettingsMenu), which borrows renderStatus() below for its status footer.
import { VERSION } from "./base"
import * as data from "./data"
import { countBadge, formatBytes, formatDate, isStale, srcColorIndex, timeAgoProse, URL_DENY } from "./fmt"
import * as nav from "./nav"
import * as refresh from "./refresh"
import * as sync from "./sync"

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
}

let root: HTMLElement
let filterBox: HTMLElement
// The header's "Show read" toggle button — aria-pressed tracks the mode (pressed
// = read articles shown = unread-only OFF), synced on every render().
let showReadBtn: HTMLElement
let hooks: PickerHooks
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
   // Delegated filter pick: every row carries data-value (feed id / tag / "" /
   // ~saved). The tag collapse toggle stops its own click, but guard anyway.
   filterBox.addEventListener("click", (e) => {
      const t = e.target as HTMLElement
      if (t.closest(".srr-tag-toggle")) return
      if (t.closest(".srr-info-btn")) return
      const a = t.closest("[data-value]") as HTMLElement | null
      if (!a) return
      e.preventDefault()
      hooks.onSelect(a.dataset.value!)
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
   render()
   root.hidden = false
   // The overlay owns its own scroll (the list's window scroll is untouched
   // underneath); land at the top so [ALL] / ★ Saved show first on every open.
   root.scrollTop = 0
   // Focus the overlay container so Escape/arrows land here without painting a
   // row pre-selected (:focus-visible fires on programmatic focus — the same
   // reasoning as the context menu's container focus).
   root.tabIndex = -1
   root.focus()
}

export function close(): void {
   if (root.hidden) return
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

// ── Filter list ──────────────────────────────────────────────────────────────

function link(value: string, text: string, className?: string): HTMLAnchorElement {
   const a = document.createElement("a")
   a.href = "#"
   a.dataset.value = value
   // Title rides in its own span so a flex row (feed / tag header) ellipsizes it
   // in the middle while chips / badges / the ⓘ button keep their size; plain
   // block rows ([ALL] / ★Saved) ignore the flex props and ellipsize as before.
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

const SVG_NS = "http://www.w3.org/2000/svg"
function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
   const e = document.createElementNS(SVG_NS, tag)
   for (const k in attrs) e.setAttribute(k, attrs[k])
   return e
}

// The ⓘ details button on a feed / [ALL] row. A button-semantic span — a real
// <button> can't nest inside the row's <a> — so it carries role/tabindex and an
// Enter/Space keymap. Its click stops short of the row's filter-select.
function infoBtn(label: string, onOpen: () => void): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-info-btn"
   s.setAttribute("role", "button")
   s.setAttribute("tabindex", "0")
   s.setAttribute("aria-label", label)
   s.title = "Details"
   // A solid disc with a knocked-out "i" — a filled badge, so it can't be
   // confused with the tag headers' open caret one row over (the two share the
   // same right gutter; fill vs line is what tells them apart at a glance).
   const svg = svgEl("svg", { viewBox: "0 0 24 24" })
   svg.setAttribute("aria-hidden", "true")
   svg.append(
      svgEl("circle", { class: "srr-info-disc", cx: "12", cy: "12", r: "9" }),
      svgEl("line", { x1: "12", y1: "11", x2: "12", y2: "16.5" }),
      svgEl("circle", { class: "srr-info-dot", cx: "12", cy: "7.75", r: "1.3" }),
   )
   s.appendChild(svg)
   const act = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      onOpen()
   }
   s.addEventListener("click", act)
   s.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") act(e)
   })
   return s
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

function feedLink(ch: IFeed, className: string): HTMLAnchorElement {
   const a = link(String(ch.id), ch.title, `${className} srr-feed-row`.trim())
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
      // Health shows as a label tint (data-grade → CSS colors the title); the ⓘ
      // is tinted by grade too. No leading dot, so the label's left edge is
      // unchanged. The title/aria-label (above) carries the state non-visually.
      a.dataset.grade = grade
   }
   a.prepend(srcChip(ch.id))
   const info = infoBtn(`Details for ${ch.title}`, () => openFeedInfo(ch))
   a.appendChild(info)
   return a
}

function unreadBadge(n: number): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-unread"
   s.textContent = countBadge(n)
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
   const headerRows: [HTMLAnchorElement, IFeed[]][] = []

   // [ALL] is a flex feed-row like the per-feed rows, so its unread badge and ⓘ
   // share their exact right-edge geometry (numeric column + gutter glyph).
   const allRow = link("", "[ALL]", cls("srr-feed-row", ""))
   allRow.appendChild(infoBtn("Details for all feeds", () => openStoreInfo()))
   frag.appendChild(allRow)

   const savedN = nav.savedCount()
   if (savedN > 0) {
      const savedRow = link(nav.SAVED_TOKEN, "★ Saved", cls("", nav.SAVED_TOKEN))
      const num = document.createElement("span")
      num.className = "srr-saved-num"
      num.textContent = String(savedN)
      savedRow.appendChild(num)
      frag.appendChild(savedRow)
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
         const item = feedLink(ch, cls("srr-tag-item", String(ch.id)))
         unreadRows.push([item, ch])
         groupDiv.appendChild(item)
      }
      frag.appendChild(groupDiv)
   }

   if (sortedTags.length > 0 && untagged.length > 0) frag.appendChild(div("srr-tag-sep"))
   for (const ch of untagged) {
      const item = feedLink(ch, cls("", String(ch.id)))
      unreadRows.push([item, ch])
      frag.appendChild(item)
   }

   filterBox.replaceChildren(frag)
   void fillUnread(unreadRows, headerRows, allRow)
}

// Unread badges fill in after the list renders so a cold seen position never
// delays the panel. One freshness token guards every DOM write (a re-render or
// close orphans a stale pass). When unread-only is on, fully-read rows/tags hide.
async function fillUnread(
   rows: [HTMLAnchorElement, IFeed][],
   headers: [HTMLAnchorElement, IFeed[]][],
   allRow: HTMLAnchorElement,
) {
   const my = {}
   fillToken = my
   try {
      const counts = await nav.unreadCounts(rows.map(([, ch]) => ch))
      if (my !== fillToken) return
      // [ALL]'s number is the whole backlog — the sum over every listed feed
      // (rows the mode hides as fully-read contribute 0). Absent at zero, like
      // every row's badge; before the ⓘ, like every feed row's.
      const total = nav.tagUnreadFromCounts(
         rows.map(([, ch]) => ch),
         counts,
      )
      if (total > 0) allRow.insertBefore(unreadBadge(total), allRow.querySelector(".srr-info-btn"))
      const hideRead = nav.isUnreadOnly()
      const activeKey = nav.getCurrentFilterKey()
      for (const [a, ch] of rows) {
         const n = counts.get(ch.id)!
         // Flex rows: the badge sits just before the ⓘ button (after the title),
         // not floated — so the title ellipsizes ahead of it.
         if (n > 0) a.insertBefore(unreadBadge(n), a.querySelector(".srr-info-btn"))
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

// A read-only detail card opened from a row's ⓘ button. Lays the feed/tag's
// stored fields out in grouped definition grids; the live unread counts (idx-
// derived, async) fill in after the card shows, guarded by infoFillToken so a
// close / re-open orphans a stale pass. Reader-facing on purpose: internal
// bookkeeping (feed ids, HTTP validators, dedup/pack state, processing
// recipes) stays off the card — the admin GUI is where operators look.

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

// The [ALL] row's card: the store-wide rollup none of the per-feed cards can
// show — inventory and a health census of every feed's grade. Freshness and
// the search-index state stay out (the settings menu's status footer owns
// both), and pack internals (generation, latest-pack names) never show.
function buildStoreInfo(): DocumentFragment {
   const frag = document.createDocumentFragment()
   const feeds = Object.values(data.db.feeds ?? {})

   const content = infoSection("Content")
   addRow(content.dl, "Feeds", String(feeds.length))
   addRow(content.dl, "Tags", String(new Set(feeds.map((ch) => ch.tag).filter(Boolean)).size))
   // Live count, expired excluded — the same semantics as the feed card's row.
   addRow(content.dl, "Articles", String(feeds.reduce((sum, ch) => sum + ch.total_art - (ch.xp ?? 0), 0)))
   addRow(content.dl, "Unread", "…", "srr-info-unread")
   addRow(content.dl, "Saved", String(nav.savedCount()))
   // Store footprint summed over every feed — same rows as the feed card.
   addRow(content.dl, "Stored content", formatBytes(feeds.reduce((sum, ch) => sum + (ch.cb ?? 0), 0)))
   const media = feeds.reduce((sum, ch) => sum + (ch.ab ?? 0), 0)
   if (media > 0) addRow(content.dl, "Stored assets", formatBytes(media))
   frag.appendChild(content.sec)

   // The health census: feedGrade counts in the chip vocabulary (Healthy /
   // Stale / Error). Problem rows appear only when nonzero, so a healthy store
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
   openInfoDialog("All feeds", buildStoreInfo())
   void fillStoreUnread(Object.values(data.db.feeds ?? {}))
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
// restored to the opener (the ⓘ button). Body is rebuilt per open.
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
         const f = dialog.querySelectorAll<HTMLElement>("a[href], button, [tabindex]")
         if (f.length === 0) return
         const first = f[0]
         const last = f[f.length - 1]
         if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
         } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
         }
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
