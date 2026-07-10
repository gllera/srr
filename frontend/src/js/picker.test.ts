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
vi.mock("./refresh", () => ({ lastRefreshError: () => "" }))

type Picker = typeof import("./picker")

const SKELETON =
   `<section class="srr-picker" hidden>` +
   `<header class="srr-picker-head"><h2 class="srr-picker-title">Feeds</h2>` +
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

const hooks = {
   onSelect: vi.fn(),
   onClose: vi.fn(),
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
      expect(has.querySelector(".srr-unread")!.textContent).toBe("3")
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
      expect(all.querySelector(".srr-unread")!.textContent).toBe("7")
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
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         // last_ok well past the crit staleness window, no ferr.
         untagged: [feed({ id: 7, title: "Stale", last_ok: 1 })],
      })
      const picker = await mount()
      picker.open()
      const row = $<HTMLAnchorElement>('.srr-picker-filter a[data-value="7"]')
      expect(row.dataset.grade).toBe("crit")
      // No ferr, but the row still exposes a non-color text cue.
      expect(row.title).not.toBe("")
      expect(row.getAttribute("aria-label")).toMatch(/Stale/)
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
})

describe("info dialog", () => {
   it("puts an ⓘ details button on feed rows and [ALL] (not tags / ★ Saved)", async () => {
      nav.savedCount.mockReturnValue(1)
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [feed({ id: 1, title: "A", tag: "news" })]]]),
         sortedTags: ["news"],
         untagged: [feed({ id: 5, title: "Feed5" })],
      })
      const picker = await mount()
      picker.open()
      expect($('.srr-picker-filter a[data-value="5"] .srr-info-btn')).not.toBeNull()
      expect($('.srr-picker-filter a[data-value=""]').querySelector(".srr-info-btn")).not.toBeNull()
      expect($(".srr-picker-filter .srr-tag-header").querySelector(".srr-info-btn")).toBeNull()
      expect($('.srr-picker-filter a[data-value="~saved"]').querySelector(".srr-info-btn")).toBeNull()
   })

   it("opens the store-wide card from [ALL]'s ⓘ — inventory, health census, live unread", async () => {
      const a = feed({ id: 1, title: "A", tag: "news", total_art: 10, xp: 2 })
      const b = feed({ id: 2, title: "B", ferr: "boom" }) // crit; total_art 1
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
      $('.srr-picker-filter a[data-value=""] .srr-info-btn').dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      await flush()
      expect($(".srr-info-title").textContent).toBe("All feeds")
      const rows = new Map($$(".srr-info-grid dt").map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))
      expect(rows.get("Feeds")).toBe("2")
      expect(rows.get("Tags")).toBe("1")
      expect(rows.get("Articles")).toBe("9") // live: (10−2) + 1, expired excluded
      expect(rows.get("Saved")).toBe("3")
      expect(rows.get("Healthy")).toBe("1")
      expect(rows.get("Error")).toBe("1")
      expect(rows.has("Stale")).toBe(false) // zero problem rows stay absent
      expect(rows.get("Search index")).toBe("Ready")
      expect($(".srr-info-unread").textContent).toBe("5") // async store-wide sum
      expect(hooks.onSelect).not.toHaveBeenCalled() // ⓘ never selects the row
   })

   it("opens a feed detail card with its fields and live unread, without selecting the row", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Feed5", url: "http://example.com/rss", recipe: "default", total_art: 12 })],
      })
      nav.unreadCounts.mockResolvedValue(new Map([[5, 7]]))
      const picker = await mount()
      picker.open()
      $('.srr-picker-filter a[data-value="5"] .srr-info-btn').dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      expect(hooks.onSelect).not.toHaveBeenCalled() // ⓘ is not a row selection
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(true)
      expect($(".srr-info-title").textContent).toBe("Feed5")
      expect($(".srr-info-body").textContent).toContain("http://example.com/rss")
      await flush()
      expect($(".srr-info-unread").textContent).toBe("7")
      $(".srr-info-close").click()
      expect($(".srr-info-dialog").classList.contains("srr-open")).toBe(false)
   })

   it("shows the live article count (total_art − xp) in the detail card", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Feed5", url: "http://example.com/rss", total_art: 10, xp: 4 })],
      })
      nav.unreadCounts.mockResolvedValue(new Map([[5, 0]]))
      const picker = await mount()
      picker.open()
      $('.srr-picker-filter a[data-value="5"] .srr-info-btn').dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      // dt "Articles" and dd "6" concatenate in textContent.
      expect($(".srr-info-body").textContent).toContain("Articles6")
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

   it("always shows the build version, even before anything is fetched", async () => {
      // SRR_VERSION is a build-time define; vitest.shared.ts pins it to "test".
      data.lastFetchedAt.mockReturnValue(0)
      await render()
      expect(box.querySelector(".srr-status-version")!.textContent).toBe("srr test")
      // …and it is the ONLY status content on an empty store.
      expect(box.textContent).toBe("srr test")
   })
})
