import { describe, it, expect, vi, beforeEach } from "vitest"

// picker.ts owns the filter-picker overlay (feed / tag rows + info dialogs) and
// the renderStatus builder the settings menu borrows for its footer. It reads
// DOM refs inside setup(), so the skeleton is seeded first; the module holds
// per-instance state (fill tokens, focus restore), so each test gets a fresh
// instance via vi.resetModules() + dynamic import.
const data = vi.hoisted(() => {
   const mock = {
      db: { feeds: {} } as IDB,
      groupFeedsByTag: vi.fn(() => ({ tagged: new Map(), sortedTags: [] as string[], untagged: [] as IFeed[] })),
      lastFetchedAt: vi.fn(() => 0),
      hasArticles: vi.fn(() => true),
      metaReady: vi.fn(() => true),
      idxSummaryDegraded: vi.fn(() => false),
   }
   return mock
})
vi.mock("./data", () => data)

const nav = vi.hoisted(() => ({
   getCurrentFilterKey: vi.fn(() => ""),
   savedCount: vi.fn(() => 0),
   SAVED_TOKEN: "~saved",
   isUnreadOnly: vi.fn(() => false),
   setUnreadOnly: vi.fn<(on: boolean) => void>(),
   unreadCounts: vi.fn<(chs: IFeed[]) => Promise<Map<number, number>>>(async () => new Map()),
   tagUnreadFromCounts: vi.fn<(group: IFeed[], counts: Map<number, number>) => number>((group, counts) =>
      group.reduce((sum, ch) => sum + Math.max(0, counts.get(ch.id) ?? 0), 0),
   ),
}))
vi.mock("./nav", () => nav)

// Deterministic pure-fn stand-ins so the status assertions are stable.
vi.mock("./fmt", () => ({
   srcColorIndex: (id: number) => id % 8,
   formatDate: (t: number) => `D${t}`,
   timeAgoProse: (t: number) => `ago${t}`,
   countBadge: (n: number) => (n > 999 ? "999+" : String(n)),
   formatBytes: (n: number) => `${n}B`,
   isStale: vi.fn(() => false),
   URL_DENY: /^\s*(?:javascript|data|vbscript|file)\s*:/i,
}))
import { isStale } from "./fmt"

// The sync status readout consumed by renderStatus.
const sync = vi.hoisted(() => ({
   state: vi.fn(() => ({ on: false, okAt: 0, error: "" })),
}))
vi.mock("./sync", () => sync)

// picker.ts reads refresh.lastRefreshError() in renderStatus; the live content
// refresh itself is app.ts's wiring, so the status source is all picker needs.
// A vi.fn so a test can surface a failure string (default empty = healthy).
const refresh = vi.hoisted(() => ({ lastRefreshError: vi.fn(() => "") }))
vi.mock("./refresh", () => refresh)

type Picker = typeof import("./picker")

const SKELETON =
   `<section class="srr-picker" hidden>` +
   `<header class="srr-picker-head"><h2 class="srr-picker-title">Feeds</h2>` +
   `<button class="srr-picker-info" aria-pressed="false"></button>` +
   `<button class="srr-picker-showread" aria-pressed="false"></button>` +
   `<button class="srr-picker-close"></button></header>` +
   `<div class="srr-picker-filter"></div>` +
   `</section>` +
   `<div class="srr-info-dialog">` +
   `<div class="srr-info-card"><header class="srr-info-head">` +
   `<h2 class="srr-info-title"></h2><button class="srr-info-close"></button></header>` +
   `<div class="srr-info-body"></div></div></div>`

const feed = (over: Partial<IFeed>): IFeed =>
   ({ id: 1, title: "Test", url: "http://x", total_art: 1, ...over }) as IFeed

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const $$ = <T extends HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const flush = () => new Promise((r) => setTimeout(r, 0)) // let fillUnread's await settle
const key = (el: EventTarget, k: string, shiftKey = false) =>
   el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }))
const md = () => new MouseEvent("mousedown", { bubbles: true, cancelable: true })
const click = () => new MouseEvent("click", { bubbles: true, cancelable: true })

const hooks = {
   onSelect: vi.fn(),
   onClose: vi.fn(),
   onToggleShowRead: vi.fn(),
}

async function mount(): Promise<Picker> {
   document.body.innerHTML = SKELETON
   vi.resetModules()
   const picker = await import("./picker")
   picker.setup($(".srr-picker"), hooks)
   return picker
}

beforeEach(() => {
   vi.clearAllMocks()
   data.db.feeds = {} // plain shared state, not a mock — reset by hand
   nav.getCurrentFilterKey.mockReturnValue("")
   nav.savedCount.mockReturnValue(0)
   nav.isUnreadOnly.mockReturnValue(false)
   nav.unreadCounts.mockResolvedValue(new Map())
   data.groupFeedsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [] })
   data.lastFetchedAt.mockReturnValue(0)
   data.hasArticles.mockReturnValue(true)
   data.metaReady.mockReturnValue(true)
   data.idxSummaryDegraded.mockReturnValue(false)
   ;(isStale as ReturnType<typeof vi.fn>).mockReturnValue(false)
   sync.state.mockReturnValue({ on: false, okAt: 0, error: "" })
   refresh.lastRefreshError.mockReturnValue("")
})

describe("open / close", () => {
   it("open reveals the overlay and close hides it", async () => {
      const picker = await mount()
      expect($(".srr-picker").hidden).toBe(true)
      picker.open()
      expect($(".srr-picker").hidden).toBe(false)
      expect(picker.isOpen()).toBe(true)
      picker.close()
      expect($(".srr-picker").hidden).toBe(true)
      expect(picker.isOpen()).toBe(false)
   })

   it("the close button fires onClose", async () => {
      const picker = await mount()
      picker.open()
      $(".srr-picker-close").click()
      expect(hooks.onClose).toHaveBeenCalledTimes(1)
   })

   it("open focuses the overlay container; close restores focus to the opener", async () => {
      const picker = await mount()
      // Simulate the toolbar readout that opened the overlay.
      const opener = document.createElement("button")
      document.body.appendChild(opener)
      opener.focus()
      picker.open()
      // Container focus (not a row) — Escape lands in the picker without
      // painting a filter row pre-selected.
      expect(document.activeElement).toBe($(".srr-picker"))
      picker.close()
      expect(document.activeElement).toBe(opener)
   })
})

describe("filter list", () => {
   it("renders [ALL] and feed rows; picking one fires onSelect with its token", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Feed5" })],
      })
      const picker = await mount()
      picker.open()
      const all = $<HTMLAnchorElement>('.srr-picker-filter a[data-value=""]')
      expect(all.textContent).toContain("[ALL]")
      $<HTMLAnchorElement>('.srr-picker-filter a[data-value="5"]').dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      expect(hooks.onSelect).toHaveBeenCalledWith("5")
      all.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      expect(hooks.onSelect).toHaveBeenCalledWith("")
   })

   it("lists empty feeds (includeEmpty) only when read items are shown (unread-only off)", async () => {
      nav.isUnreadOnly.mockReturnValue(false) // read items shown → empty feeds too
      const picker = await mount()
      picker.open()
      expect(data.groupFeedsByTag).toHaveBeenCalledWith(true)

      data.groupFeedsByTag.mockClear()
      nav.isUnreadOnly.mockReturnValue(true) // unread-only → feeds with articles only
      picker.render()
      expect(data.groupFeedsByTag).toHaveBeenCalledWith(false)
   })

   it("shows a ★ Saved row only when something is saved", async () => {
      const picker = await mount()
      picker.open()
      expect($(".srr-picker-filter").querySelector('a[data-value="~saved"]')).toBeNull()
      nav.savedCount.mockReturnValue(4)
      picker.render()
      const saved = $<HTMLAnchorElement>('.srr-picker-filter a[data-value="~saved"]')
      expect(saved.textContent).toContain("★ Saved")
      // The saved count reads as the same inline "×N" phrase as the unread counts.
      expect(saved.querySelector(".srr-saved-num")!.textContent).toBe("×4")
   })

   it("groups tagged feeds and a tag-toggle click expands/collapses without selecting", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [feed({ id: 1, title: "A", tag: "news" })]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      const picker = await mount()
      picker.open()
      const group = $(".srr-picker-filter .srr-tag-group")
      expect(group.classList.contains("srr-tag-collapsed")).toBe(true) // not the active tag
      $(".srr-picker-filter .srr-tag-toggle").dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      expect(group.classList.contains("srr-tag-collapsed")).toBe(false)
      expect(hooks.onSelect).not.toHaveBeenCalled() // toggling is not a selection
   })

   it("badges feeds with unread and hides fully-read rows in unread-only mode", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 1, title: "Has" }), feed({ id: 2, title: "None" })],
      })
      nav.isUnreadOnly.mockReturnValue(true)
      nav.unreadCounts.mockResolvedValue(
         new Map([
            [1, 3],
            [2, 0],
         ]),
      )
      const picker = await mount()
      picker.open()
      await flush()
      const has = $<HTMLAnchorElement>('.srr-picker-filter a[data-value="1"]')
      const none = $<HTMLAnchorElement>('.srr-picker-filter a[data-value="2"]')
      expect(has.querySelector(".srr-unread")!.textContent).toBe("×3")
      expect(none.classList.contains("srr-hidden")).toBe(true) // 0 unread, hidden in unread-only
   })

   it("badges [ALL] with the total unread across every listed feed", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [feed({ id: 1, title: "A", tag: "news" })]]]),
         sortedTags: ["news"],
         untagged: [feed({ id: 2, title: "B" })],
      })
      nav.unreadCounts.mockResolvedValue(
         new Map([
            [1, 3],
            [2, 4],
         ]),
      )
      const picker = await mount()
      picker.open()
      await flush()
      const all = $<HTMLAnchorElement>('.srr-picker-filter a[data-value=""]')
      expect(all.querySelector(".srr-unread")!.textContent).toBe("×7")
   })

   it("leaves [ALL] unnumbered when everything is read (badge only above zero)", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 1, title: "A" })],
      })
      nav.unreadCounts.mockResolvedValue(new Map([[1, 0]]))
      const picker = await mount()
      picker.open()
      await flush()
      expect($<HTMLAnchorElement>('.srr-picker-filter a[data-value=""]').querySelector(".srr-unread")).toBeNull()
   })

   it("marks a feed with a fetch error by tinting its label, no leading dot", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 9, title: "Broken", ferr: "boom" })],
      })
      const picker = await mount()
      picker.open()
      const row = $<HTMLAnchorElement>('.srr-picker-filter a[data-value="9"]')
      // Health rides on data-grade (CSS tints the label and ⓘ button); no leading
      // dot that would shift the title rightward and misalign the list.
      expect(row.dataset.grade).toBe("crit")
      expect(row.querySelector(".srr-err-dot")).toBeNull()
      expect(row.title).toBe("boom")
   })

   it("adds a non-color title/aria cue to a stale-by-age feed (no ferr)", async () => {
      // last_ok in the warn window (STALE_WARN_SEC ≤ age < STALE_CRIT_SEC) and no
      // ferr → the feed genuinely grades "warn". Title has NO "Stale" in it, so the
      // aria assertion proves the grade's copy, not the feed name (the old bug).
      const lastOk = Math.floor(Date.now() / 1000) - 7 * 86400
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 7, title: "Weekly digest", last_ok: lastOk })],
      })
      const picker = await mount()
      picker.open()
      const row = $<HTMLAnchorElement>('.srr-picker-filter a[data-value="7"]')
      expect(row.dataset.grade).toBe("warn")
      // No ferr, but the row still exposes a non-color text cue tied to the grade.
      expect(row.title).toBe("feed may be stale")
      expect(row.getAttribute("aria-label")).toMatch(/feed may be stale/)
   })

   it("grades a 7-day-stale feed as warn", async () => {
      // The warn window (3–14 days) — the middle grade no crit/ferr test reaches.
      const lastOk = Math.floor(Date.now() / 1000) - 7 * 86400
      const stale = feed({ id: 3, title: "Weekly", tag: "news", last_ok: lastOk })
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [stale]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      const picker = await mount()
      picker.open()
      // The feed row grades warn (amber), not crit …
      expect($<HTMLAnchorElement>('.srr-picker-filter a[data-value="3"]').dataset.grade).toBe("warn")
      // … and its tag header inherits the warn grade + the stale (not unavailable) copy.
      const header = $<HTMLAnchorElement>(".srr-picker-filter .srr-tag-header")
      expect(header.dataset.grade).toBe("warn")
      expect(header.title).toBe("a feed in this tag may be stale")
   })

   it("tints a tag header by its worst member's grade", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([
            [
               "news",
               [feed({ id: 1, title: "A", tag: "news" }), feed({ id: 2, title: "B", tag: "news", ferr: "boom" })],
            ],
         ]),
         sortedTags: ["news"],
         untagged: [],
      })
      const picker = await mount()
      picker.open()
      expect($<HTMLAnchorElement>(".srr-picker-filter .srr-tag-header").dataset.grade).toBe("crit")
   })

   it("leaves a healthy feed untinted (no data-grade, untinted ⓘ)", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 9, title: "Fine" })],
      })
      const picker = await mount()
      picker.open()
      const row = $<HTMLAnchorElement>('.srr-picker-filter a[data-value="9"]')
      expect(row.dataset.grade).toBeUndefined()
   })

   it("hides a fully-read tag group in unread-only, except the active lane's", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [feed({ id: 1, title: "A", tag: "news" })]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      nav.isUnreadOnly.mockReturnValue(true)
      nav.unreadCounts.mockResolvedValue(new Map([[1, 0]])) // whole group fully read
      const picker = await mount()
      picker.open()
      await flush()
      expect($(".srr-picker-filter .srr-tag-group").classList.contains("srr-hidden")).toBe(true)
      // The active tag's own group stays visible even fully read.
      nav.getCurrentFilterKey.mockReturnValue("news")
      picker.render()
      await flush()
      expect($(".srr-picker-filter .srr-tag-group").classList.contains("srr-hidden")).toBe(false)
   })

   it("auto-expands the active single-feed filter's tag group", async () => {
      const a = feed({ id: 1, title: "A", tag: "news" })
      data.db.feeds = { 1: a } // activeTag() reads the feed's tag from here
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [a]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      nav.getCurrentFilterKey.mockReturnValue("1") // feed 1 active → expand its "news" group
      const picker = await mount()
      picker.open()
      expect($(".srr-picker-filter .srr-tag-group").classList.contains("srr-tag-collapsed")).toBe(false)
   })

   it("tints exactly the active filter row with srr-active, following the current key", async () => {
      nav.savedCount.mockReturnValue(3) // so the ★ Saved scope chip renders alongside [ALL]
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Five" })],
      })
      const picker = await mount()
      picker.open()
      await flush()
      const active = () => $$(".srr-picker-filter .srr-active").map((e) => e.getAttribute("data-value"))
      // Default current key "" → [ALL] wears the tint alone.
      expect(active()).toEqual([""])
      // Feed 5 active → the tint moves to its row (and off [ALL]).
      nav.getCurrentFilterKey.mockReturnValue("5")
      picker.render()
      await flush()
      expect(active()).toEqual(["5"])
      // ★ Saved active → the scope chip wears it.
      nav.getCurrentFilterKey.mockReturnValue(nav.SAVED_TOKEN)
      picker.render()
      await flush()
      expect(active()).toEqual([nav.SAVED_TOKEN])
   })
})

describe("show-read toggle (picker header)", () => {
   it("reflects unread-only as aria-pressed — pressed means read articles are shown", async () => {
      nav.isUnreadOnly.mockReturnValue(false) // read shown → pressed
      const picker = await mount()
      picker.open()
      expect($(".srr-picker-showread").getAttribute("aria-pressed")).toBe("true")

      nav.isUnreadOnly.mockReturnValue(true) // unread-only → not pressed
      picker.render()
      expect($(".srr-picker-showread").getAttribute("aria-pressed")).toBe("false")
   })

   it("clicking it calls onToggleShowRead and re-renders the rows for the new mode", async () => {
      nav.isUnreadOnly.mockReturnValue(false)
      const picker = await mount()
      picker.open()
      expect(data.groupFeedsByTag).toHaveBeenLastCalledWith(true) // read shown → empty feeds listed
      // app.ts's hook flips the nav mode; simulate that flip so render() sees it.
      hooks.onToggleShowRead.mockImplementation(() => nav.isUnreadOnly.mockReturnValue(true))
      data.groupFeedsByTag.mockClear()
      $(".srr-picker-showread").click()
      expect(hooks.onToggleShowRead).toHaveBeenCalledTimes(1)
      expect(data.groupFeedsByTag).toHaveBeenCalledWith(false) // re-rendered in unread-only mode
      expect($(".srr-picker-showread").getAttribute("aria-pressed")).toBe("false")
      hooks.onToggleShowRead.mockReset()
   })
})

// The stats-mode dialogs: while the header Info toggle is pressed, tapping a
// row opens its detail card instead of filtering (the per-row ⓘ buttons this
// replaced are gone).
describe("info dialog", () => {
   const statsOn = () => $(".srr-picker-info").click()

   it("renders no per-row ⓘ buttons — stats mode replaced them", async () => {
      nav.savedCount.mockReturnValue(1)
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [feed({ id: 1, title: "A", tag: "news" })]]]),
         sortedTags: ["news"],
         untagged: [feed({ id: 5, title: "Feed5" })],
      })
      const picker = await mount()
      picker.open()
      expect($$(".srr-picker-filter .srr-info-btn")).toHaveLength(0)
   })

   it("the Info toggle tracks aria-pressed and open() resets it off", async () => {
      const picker = await mount()
      picker.open()
      expect($(".srr-picker-info").getAttribute("aria-pressed")).toBe("false")
      statsOn()
      expect($(".srr-picker-info").getAttribute("aria-pressed")).toBe("true")
      expect($(".srr-picker").classList.contains("srr-picker-statsmode")).toBe(true)
      statsOn() // second click toggles back off
      expect($(".srr-picker-info").getAttribute("aria-pressed")).toBe("false")
      statsOn()
      picker.close()
      picker.open() // a fresh open always starts in picking mode
      expect($(".srr-picker-info").getAttribute("aria-pressed")).toBe("false")
      expect($(".srr-picker").classList.contains("srr-picker-statsmode")).toBe(false)
   })

   it("without stats mode a row click selects; with it the same click opens the card", async () => {
      const f = feed({ id: 5, title: "Feed5" })
      data.db.feeds = { 5: f } // openRowInfo resolves the tapped feed from here
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [f],
      })
      const picker = await mount()
      picker.open()
      const row = $<HTMLAnchorElement>('.srr-picker-filter a[data-value="5"]')
      row.dispatchEvent(click())
      expect(hooks.onSelect).toHaveBeenCalledWith("5")
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(false)
      hooks.onSelect.mockClear()
      statsOn()
      row.dispatchEvent(click())
      expect(hooks.onSelect).not.toHaveBeenCalled() // stats mode never selects
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(true)
      expect($(".srr-info-title").textContent).toBe("Feed5")
   })

   it("in stats mode ★ Saved is inert — no card of its own, no selection", async () => {
      nav.savedCount.mockReturnValue(3)
      const picker = await mount()
      picker.open()
      statsOn()
      $('.srr-picker-filter a[data-value="~saved"]').dispatchEvent(click())
      expect(hooks.onSelect).not.toHaveBeenCalled()
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(false)
   })

   it("opens a tag rollup card from a tag header — members only, no store-wide rows", async () => {
      const a = feed({ id: 1, title: "A", tag: "news", total_art: 10, xp: 2, cb: 1_000, ab: 500 })
      const b = feed({ id: 2, title: "B", tag: "news", ferr: "boom", cb: 234 })
      const other = feed({ id: 3, title: "C" })
      data.db.feeds = { 1: a, 2: b, 3: other }
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [a, b]]]),
         sortedTags: ["news"],
         untagged: [other],
      })
      nav.unreadCounts.mockResolvedValue(
         new Map([
            [1, 4],
            [2, 1],
         ]),
      )
      const picker = await mount()
      picker.open()
      statsOn()
      $(".srr-picker-filter .srr-tag-header").dispatchEvent(click())
      await flush()
      expect(hooks.onSelect).not.toHaveBeenCalled()
      expect($(".srr-info-title").textContent).toBe("news")
      const rows = new Map($$(".srr-info-grid dt").map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))
      expect(rows.get("Feeds")).toBe("2") // the tag's members, not the whole store
      expect(rows.get("Articles")).toBe("9") // live: (10−2) + 1, expired excluded
      expect(rows.get("Stored content")).toBe("1234B")
      expect(rows.get("Stored assets")).toBe("500B")
      expect(rows.get("Healthy")).toBe("1")
      expect(rows.get("Error")).toBe("1")
      // Store-wide-only rows stay off the tag card.
      expect(rows.has("Tags")).toBe(false)
      expect(rows.has("Saved")).toBe(false)
      expect($(".srr-info-unread").textContent).toBe("5") // async sum over members
   })

   it("opens the store-wide card from [ALL] — inventory, health census, live unread", async () => {
      const a = feed({ id: 1, title: "A", tag: "news", total_art: 10, xp: 2, cb: 1_000_000, ab: 500_000 })
      const b = feed({ id: 2, title: "B", ferr: "boom", cb: 234_000 }) // crit; total_art 1
      data.db.feeds = { 1: a, 2: b }
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [a]]]),
         sortedTags: ["news"],
         untagged: [b],
      })
      nav.savedCount.mockReturnValue(3)
      nav.unreadCounts.mockResolvedValue(
         new Map([
            [1, 4],
            [2, 1],
         ]),
      )
      const picker = await mount()
      picker.open()
      statsOn()
      $('.srr-picker-filter a[data-value=""]').dispatchEvent(click())
      await flush()
      expect($(".srr-info-title").textContent).toBe("All feeds")
      const rows = new Map($$(".srr-info-grid dt").map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))
      expect(rows.get("Feeds")).toBe("2")
      expect(rows.get("Tags")).toBe("1")
      expect(rows.get("Articles")).toBe("9") // live: (10−2) + 1, expired excluded
      expect(rows.get("Saved")).toBe("3")
      expect(rows.get("Stored content")).toBe("1234000B") // cb summed across feeds
      expect(rows.get("Stored assets")).toBe("500000B") // ab summed; only a has any
      expect(rows.get("Healthy")).toBe("1")
      expect(rows.get("Error")).toBe("1")
      expect(rows.has("Stale")).toBe(false) // zero problem rows stay absent
      // Pack internals stay off the reader-facing card (generation, latest-pack
      // names, search-index state — the settings footer owns the last one).
      expect(rows.has("Generation")).toBe(false)
      expect(rows.has("Latest packs")).toBe(false)
      expect(rows.has("Search index")).toBe(false)
      expect($(".srr-info-unread").textContent).toBe("5") // async store-wide sum
      expect(hooks.onSelect).not.toHaveBeenCalled() // a stats-mode tap never selects
   })

   it("opens a feed detail card with its fields and live unread, without selecting the row", async () => {
      const f = feed({
         id: 5,
         title: "Feed5",
         url: "http://example.com/rss",
         recipe: "default",
         total_art: 12,
         cb: 1_234_567,
         ab: 89_000_000,
         exp: 30,
      })
      data.db.feeds = { 5: f }
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [f],
      })
      nav.unreadCounts.mockResolvedValue(new Map([[5, 7]]))
      const picker = await mount()
      picker.open()
      statsOn()
      $('.srr-picker-filter a[data-value="5"]').dispatchEvent(click())
      expect(hooks.onSelect).not.toHaveBeenCalled() // a stats-mode tap is not a selection
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(true)
      expect($(".srr-info-title").textContent).toBe("Feed5")
      expect($(".srr-info-body").textContent).toContain("http://example.com/rss")
      // Internal bookkeeping stays off the reader-facing card: no feed id,
      // processing recipe, HTTP validators, or dedup/pack state.
      const dts = $$(".srr-info-grid dt").map((dt) => dt.textContent)
      for (const label of ["Feed ID", "Recipe", "ETag", "Last-Modified", "Dedup cache", "Start index"]) {
         expect(dts).not.toContain(label)
      }
      // Storage + retention rows wired to cb / ab / exp (formatBytes stubbed).
      const rows = new Map($$(".srr-info-grid dt").map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))
      expect(rows.get("Stored content")).toBe("1234567B")
      expect(rows.get("Stored assets")).toBe("89000000B")
      expect(rows.get("Retention")).toBe("30 days")
      await flush()
      expect($(".srr-info-unread").textContent).toBe("7")
      $(".srr-info-close").click()
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(false)
   })

   it("shows the live article count (total_art − xp) in the detail card", async () => {
      const f = feed({ id: 5, title: "Feed5", url: "http://example.com/rss", total_art: 10, xp: 4 })
      data.db.feeds = { 5: f }
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [f],
      })
      nav.unreadCounts.mockResolvedValue(new Map([[5, 0]]))
      const picker = await mount()
      picker.open()
      statsOn()
      $('.srr-picker-filter a[data-value="5"]').dispatchEvent(click())
      // dt "Articles" and dd "6" concatenate in textContent.
      expect($(".srr-info-body").textContent).toContain("Articles6")
      // Counter-less feed: zero stored content, no assets row (nothing to
      // report), retention defaults to Forever (exp absent == 0 == keep).
      const rows = new Map($$(".srr-info-grid dt").map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))
      expect(rows.get("Stored content")).toBe("0B")
      expect(rows.has("Stored assets")).toBe(false)
      expect(rows.get("Retention")).toBe("Forever")
   })

   it("feed info card shows Status/Failed-attempts/error for an unhealthy feed", async () => {
      const f = feed({ id: 9, title: "Broken", ferr: "boom", fail_streak: 4 })
      data.db.feeds = { 9: f }
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [f],
      })
      const picker = await mount()
      picker.open()
      statsOn()
      $('.srr-picker-filter a[data-value="9"]').dispatchEvent(click())
      // The Status chip reads "Error" tinted crit (ferr present).
      const chip = $(".srr-info-health")
      expect(chip.textContent).toBe("Error")
      expect(chip.dataset.grade).toBe("crit")
      // The fail-streak row and the raw error text both surface.
      const rows = new Map($$(".srr-info-grid dt").map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))
      expect(rows.get("Failed attempts")).toBe("4")
      expect($(".srr-info-error").textContent).toBe("boom")
   })

   it("store info shows a Stale census row", async () => {
      const lastOk = Math.floor(Date.now() / 1000) - 7 * 86400
      const stale = feed({ id: 3, title: "Weekly", last_ok: lastOk }) // warn, no ferr
      data.db.feeds = { 3: stale }
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [stale],
      })
      const picker = await mount()
      picker.open()
      statsOn()
      $('.srr-picker-filter a[data-value=""]').dispatchEvent(click())
      const rows = new Map($$(".srr-info-grid dt").map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))
      expect(rows.get("Healthy")).toBe("0")
      expect(rows.get("Stale")).toBe("1") // one warn feed → census "Stale" row
      expect(rows.has("Error")).toBe(false) // no crit feed → the Error row stays absent
   })

   it("the tag collapse toggle still expands/collapses in stats mode, opening no card", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [feed({ id: 1, title: "A", tag: "news" })]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      const picker = await mount()
      picker.open()
      statsOn()
      const group = $(".srr-picker-filter .srr-tag-group")
      $(".srr-picker-filter .srr-tag-toggle").dispatchEvent(click())
      expect(group.classList.contains("srr-tag-collapsed")).toBe(false)
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(false)
      expect(hooks.onSelect).not.toHaveBeenCalled()
   })
})

// The info dialog's hand-written modal shell (openInfoDialog) — parallel to the
// dropdown modals': capture-phase Escape/Tab trap, backdrop-vs-card mousedown,
// focus restore, and no-stacking on a second open.
describe("info dialog modal shell", () => {
   const openFeedInfo = async (over: Partial<IFeed> = {}) => {
      const f = feed({ id: 5, title: "Feed5", url: "http://example.com/rss", ...over })
      data.db.feeds = { 5: f }
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [f],
      })
      const picker = await mount()
      picker.open()
      $(".srr-picker-info").click() // stats mode: a row tap opens the card
      const btn = $('.srr-picker-filter a[data-value="5"]')
      btn.focus() // so openInfoDialog captures it as the focus-restore target
      btn.dispatchEvent(click())
      return { picker, btn }
   }

   it("info dialog closes on Escape and restores focus", async () => {
      const { btn } = await openFeedInfo()
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(true)
      key($(".srr-info-close"), "Escape")
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(false)
      expect(document.activeElement).toBe(btn)
   })

   it("info dialog traps Tab — last wraps to first, Shift+Tab first wraps to last", async () => {
      await openFeedInfo()
      // Focusables in DOM order: the ✕ close button, then the Source URL link.
      const closeBtn = $(".srr-info-close")
      const link = $(".srr-info-link")
      link.focus()
      key(link, "Tab") // forward from the last → wraps to the first
      expect(document.activeElement).toBe(closeBtn)
      closeBtn.focus()
      key(closeBtn, "Tab", true) // Shift+Tab from the first → wraps to the last
      expect(document.activeElement).toBe(link)
   })

   it("info dialog closes on a backdrop mousedown but not a card mousedown", async () => {
      await openFeedInfo()
      const dialog = $(".srr-info-dialog")
      $(".srr-info-card").dispatchEvent(md()) // inside the card → stays open
      expect(dialog.classList.contains("srr-open")).toBe(true)
      dialog.dispatchEvent(md()) // on the backdrop itself → closes
      expect(dialog.classList.contains("srr-open")).toBe(false)
   })

   it("info dialog does not stack — a second stats-mode tap replaces the first", async () => {
      const f5 = feed({ id: 5, title: "Feed5" })
      const f6 = feed({ id: 6, title: "Feed6" })
      data.db.feeds = { 5: f5, 6: f6 }
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [f5, f6],
      })
      const picker = await mount()
      picker.open()
      $(".srr-picker-info").click()
      $('.srr-picker-filter a[data-value="5"]').dispatchEvent(click())
      $('.srr-picker-filter a[data-value="6"]').dispatchEvent(click())
      expect($$(".srr-info-dialog.srr-open")).toHaveLength(1) // exactly one open
      expect($(".srr-info-title").textContent).toBe("Feed6") // the second took over
   })
})

describe("renderStatus (the settings menu's footer)", () => {
   // renderStatus fills a caller-owned node — app.ts builds the footer div per
   // menu open and hands it to showContextMenu.
   let box: HTMLElement
   const render = async () => {
      const picker = await mount()
      box = document.createElement("div")
      picker.renderStatus(box)
      return picker
   }
   const flagText = () => [...box.querySelectorAll(".srr-status-flag")].map((f) => f.textContent)
   const noteText = () => [...box.querySelectorAll(".srr-status-note")].map((n) => n.textContent)

   it("shows the freshness line relative-only when healthy (no flag, no absolute date)", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      await render()
      // Relative time only — the absolute date would crowd a menu footer.
      expect(box.querySelector(".srr-status-fresh")!.textContent).toBe("Updated ago100")
      expect(box.textContent).not.toContain("D100")
      expect(flagText()).toHaveLength(0)
   })

   it("flags a stale fetch in user-facing terms (no 'backend')", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      ;(isStale as ReturnType<typeof vi.fn>).mockReturnValue(true)
      await render()
      expect(flagText()).toContain("Feed updates may have paused")
      expect(box.textContent).not.toContain("backend")
   })

   it("flags a rebuilding search index and a degrading idx", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      data.metaReady.mockReturnValue(false)
      data.idxSummaryDegraded.mockReturnValue(true)
      await render()
      expect(flagText()).toContain("Search unavailable while the index rebuilds")
      expect(noteText()).toContain("Optimizing for faster loading…")
   })

   it("reports sync state only when a sync endpoint is configured", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      const picker = await render()
      expect(box.textContent).not.toContain("Sync") // off → silent

      sync.state.mockReturnValue({ on: true, okAt: 0, error: "" })
      picker.renderStatus(box)
      expect(noteText()).toContain("Sync pending…")

      sync.state.mockReturnValue({ on: true, okAt: 200, error: "" })
      picker.renderStatus(box)
      expect(noteText()).toContain("Synced ago200")

      sync.state.mockReturnValue({ on: true, okAt: 200, error: "HTTP 401" })
      picker.renderStatus(box)
      expect(flagText()).toContain("Sync failed — HTTP 401")
   })

   it("renderStatus surfaces a refresh failure", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      refresh.lastRefreshError.mockReturnValue("HTTP 500")
      await render()
      expect(flagText()).toContain("Refresh failed — HTTP 500")
   })

   it("always shows the build version, even before anything is fetched", async () => {
      // SRR_VERSION is a build-time define; vitest.shared.ts pins it to "test".
      data.lastFetchedAt.mockReturnValue(0)
      await render()
      expect(box.querySelector(".srr-status-version")!.textContent).toBe("srr test")
      // …and it is the ONLY status content on an empty store.
      expect(box.textContent).toBe("srr test")
   })
})
