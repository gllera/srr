// config.ts — the config / settings surface. A third surface beside the list and
// the reader (ephemeral, not hash-routed): opened from the list's now-viewing
// button, it owns the quick-action icon bar (search · unread · image proxy ·
// backup), the contextual offline-pin row, the filter picker (feed / tag / [ALL]
// / ★Saved), and last the freshness/degradation status line — a quiet footer
// below the long picker rather than a banner above it. The four
// quick actions are static buttons in the skeleton (config.ts only wires their
// clicks + the search-disabled / read-toggle pressed state); the filter-list rendering
// is the former toolbar feed-menu, ported to a static in-flow panel; it reuses the
// same class names so the row styles (now under .srr-config-filter) carry over.
import * as data from "./data"
import { formatDate, isStale, srcColorIndex, timeAgoProse } from "./fmt"
import * as nav from "./nav"

export type ConfigHooks = {
   // Leave config for the list with the search bar open (the "Search articles…"
   // row). The row is disabled in render() while nav.searchAvailable() is false.
   onSearch: () => void
   // Pick a filter (feed id / tag / "" for [ALL] / ~saved). The caller closes
   // config and re-filters the list.
   onSelect: (token: string) => void
   // Flip the global unread-only mode and rebuild the list.
   onUnreadToggle: () => void
   // Escape / ✕ → leave config (app.ts routes this to the reader).
   onClose: () => void
   // The offline-pin row for the current filter scope, or null when unavailable.
   pinEntry: () => { label: string; action: () => void } | null
   openImgProxy: () => void
   openBackup: () => void
}

let root: HTMLElement
let filterBox: HTMLElement
let settingsBox: HTMLElement
let statusBox: HTMLElement
let unreadBtn: HTMLButtonElement
let searchBtn: HTMLButtonElement
let hooks: ConfigHooks
// The feed / tag info modal (a top-level sibling of the config surface, like the
// image-proxy / backup dialogs). Refs grabbed in setup(); closeInfo holds the
// active teardown so a re-open never stacks two.
let infoDialog: HTMLElement | null = null
let infoTitleEl: HTMLElement
let infoBodyEl: HTMLElement
let closeInfo: (() => void) | null = null
let infoFillToken: object | null = null

export function setup(el: HTMLElement, h: ConfigHooks): void {
   root = el
   hooks = h
   filterBox = el.querySelector(".srr-config-filter") as HTMLElement
   settingsBox = el.querySelector(".srr-config-settings") as HTMLElement
   statusBox = el.querySelector(".srr-config-status") as HTMLElement
   unreadBtn = el.querySelector(".srr-config-unread") as HTMLButtonElement
   searchBtn = el.querySelector(".srr-config-search") as HTMLButtonElement
   ;(el.querySelector(".srr-config-close") as HTMLElement).addEventListener("click", () => hooks.onClose())
   searchBtn.addEventListener("click", () => hooks.onSearch())
   unreadBtn.addEventListener("click", () => hooks.onUnreadToggle())
   ;(el.querySelector(".srr-config-backup") as HTMLElement).addEventListener("click", () => hooks.openBackup())
   ;(el.querySelector(".srr-config-imgproxy") as HTMLElement).addEventListener("click", () => hooks.openImgProxy())
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
   render()
   root.hidden = false
   // Config stacks over the list, which keeps the window scrolled wherever the
   // reader left it; always land at the top so the header / quick actions show
   // first. Only on open() — a re-render (e.g. the Read toggle) must not jump.
   window.scrollTo(0, 0)
}

export function close(): void {
   root.hidden = true
}

export function render(): void {
   // Search needs the meta/ index; disable the row while it rebuilds (the status
   // line below explains why), matching the old toolbar magnifier's gate.
   searchBtn.disabled = !nav.searchAvailable()
   // Inverted toggle: unread-only is the default view, so this button is OFF in
   // that default and pressed only when the reader has opted to ALSO show the
   // articles they've already read (unread-only off) — see styles.css.
   unreadBtn.setAttribute("aria-pressed", String(!nav.isUnreadOnly()))
   renderFilterList()
   renderSettings()
   refreshStatus()
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

// The ⓘ details button on a feed / tag row. A button-semantic span — a real
// <button> can't nest inside the row's <a> — so it carries role/tabindex and an
// Enter/Space keymap. Its click stops short of the row's filter-select.
function infoBtn(label: string, onOpen: () => void): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-info-btn"
   s.setAttribute("role", "button")
   s.setAttribute("tabindex", "0")
   s.setAttribute("aria-label", label)
   s.title = "Details"
   const svg = svgEl("svg", { viewBox: "0 0 24 24" })
   svg.setAttribute("aria-hidden", "true")
   svg.append(
      svgEl("circle", { cx: "12", cy: "12", r: "9" }),
      svgEl("line", { x1: "12", y1: "11", x2: "12", y2: "16" }),
      svgEl("circle", { cx: "12", cy: "7.6", r: "0.6" }),
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

// Feed-health grade for the row error dot (ported from dropdown.ts). "" healthy,
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

function errDot(grade: "warn" | "crit"): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = `srr-err-dot srr-stale-${grade}`
   s.setAttribute("aria-hidden", "true")
   return s
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
      }
      a.prepend(errDot(grade))
   }
   a.prepend(srcChip(ch.id))
   a.appendChild(infoBtn(`Details for ${ch.title}`, () => openFeedInfo(ch)))
   return a
}

function unreadBadge(n: number): HTMLSpanElement {
   const s = document.createElement("span")
   s.className = "srr-unread"
   s.textContent = n > 999 ? "999+" : String(n)
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
   const { tagged, sortedTags, untagged } = data.groupFeedsByTag()
   const current = nav.getCurrentFilterKey()
   const currentTag = activeTag()
   const cls = (base: string, v: string) => (v === current ? `${base} srr-active`.trim() : base)
   const frag = document.createDocumentFragment()
   const unreadRows: [HTMLAnchorElement, IFeed][] = []
   const headerRows: [HTMLAnchorElement, IFeed[]][] = []

   frag.appendChild(link("", "[ALL]", cls("", "")))

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
      if (worst) header.prepend(errDot(worst))
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
   void fillUnread(unreadRows, headerRows)
}

// Unread badges fill in after the list renders so a cold seen position never
// delays the panel. One freshness token guards every DOM write (a re-render or
// close orphans a stale pass). When unread-only is on, fully-read rows/tags hide.
async function fillUnread(rows: [HTMLAnchorElement, IFeed][], headers: [HTMLAnchorElement, IFeed[]][]) {
   const my = {}
   fillToken = my
   try {
      const counts = await nav.unreadCounts(rows.map(([, ch]) => ch))
      if (my !== fillToken) return
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

// ── Settings ─────────────────────────────────────────────────────────────────

// The offline-pin entry is a full-width labeled row (not an icon): its label is
// scope-dependent ("Download <tag> for offline" / "Remove offline copy") and it
// reports progress in the status bar, so it doesn't fold into a fixed glyph like
// the four quick actions above. Search / unread / backup / image-proxy are static
// icon buttons in the skeleton; this is the only thing settingsBox renders.
function actionRow(label: string, onClick: () => void): HTMLButtonElement {
   const b = document.createElement("button")
   b.type = "button"
   b.className = "srr-config-action"
   b.textContent = label
   b.addEventListener("click", onClick)
   return b
}

function renderSettings(): void {
   settingsBox.replaceChildren()
   const pin = hooks.pinEntry()
   if (pin) settingsBox.append(actionRow(pin.label, () => pin.action()))
}

// ── Status ───────────────────────────────────────────────────────────────────

let lastStatusSig: string | null = null

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

// The relocated freshness / degradation block — the former bottom banner, now a
// section of the config surface (silent everywhere else). The neutral "last
// updated" fact reads muted; anything wrong is broken out as its own amber flag
// row rather than tinting the whole line. A state-signature early return mirrors
// the banner's old text cache (skip the DOM rebuild when nothing changed).
export function refreshStatus(): void {
   const fetchedAt = data.lastFetchedAt()
   const stale = isStale(fetchedAt)
   const metaMissing = data.hasArticles() && !data.metaReady()
   const idxDegraded = data.idxSummaryDegraded()

   const sig = `${fetchedAt}|${stale}|${metaMissing}|${idxDegraded}`
   if (sig === lastStatusSig) return
   lastStatusSig = sig

   statusBox.replaceChildren()
   if (fetchedAt > 0) {
      const fresh = document.createElement("div")
      fresh.className = "srr-status-fresh"
      fresh.textContent = `Last updated ${formatDate(fetchedAt)} · ${timeAgoProse(fetchedAt)}`
      statusBox.append(fresh)
      if (stale) statusBox.append(statusFlag("Feed updates may have paused"))
   }
   if (metaMissing) statusBox.append(statusFlag("Search unavailable while the index rebuilds"))
   if (idxDegraded) statusBox.append(statusNote("Optimizing for faster loading…"))
}

// ── Feed / tag info dialog ─────────────────────────────────────────────────────

// A read-only detail card opened from a row's ⓘ button. Lays the feed/tag's
// stored fields out in grouped definition grids; the live unread counts (idx-
// derived, async) fill in after the card shows, guarded by infoFillToken so a
// close / re-open orphans a stale pass.

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
   a.href = ch.url
   a.textContent = ch.url
   a.className = "srr-info-link"
   a.rel = "noreferrer"
   addRow(src.dl, "URL", a)
   addRow(src.dl, "Tag", ch.tag || "Untagged")
   addRow(src.dl, "Feed ID", String(ch.id))
   frag.appendChild(src.sec)

   const content = infoSection("Content")
   addRow(content.dl, "Articles", String(ch.total_art))
   addRow(content.dl, "Unread", "…", "srr-info-unread")
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

   const proc = infoSection("Processing")
   addRow(proc.dl, "Ingest", ch.ingest || "Default (#rss)")
   addRow(proc.dl, "Pipeline", ch.pipe && ch.pipe.length ? ch.pipe.join("  →  ") : "Inherited from default")
   frag.appendChild(proc.sec)

   const tech = infoSection("Technical")
   addRow(tech.dl, "ETag", ch.etag || "—")
   addRow(tech.dl, "Last-Modified", ch.last_modified || "—")
   addRow(tech.dl, "Dedup cache", `${ch.bg?.length ?? 0} entries`)
   addRow(tech.dl, "Start index", String(ch.add_idx))
   frag.appendChild(tech.sec)

   return frag
}

function openFeedInfo(ch: IFeed): void {
   openInfoDialog(ch.title, buildFeedInfo(ch))
   void fillFeedUnread(ch)
}

// Fill the feed's live (idx-derived, async) unread count after the card shows;
// token-guarded so a close / re-open orphans a stale pass.
async function fillFeedUnread(ch: IFeed): Promise<void> {
   const my = {}
   infoFillToken = my
   try {
      const counts = await nav.unreadCounts([ch])
      if (my !== infoFillToken) return
      const el = infoBodyEl.querySelector(".srr-info-unread")
      if (el) el.textContent = String(counts.get(ch.id) ?? 0)
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
