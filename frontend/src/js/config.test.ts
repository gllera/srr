import { describe, it, expect, vi, beforeEach } from "vitest"

// config.ts owns the config surface (filter picker + unread toggle + settings +
// status). It reads DOM refs inside setup(), so the skeleton is seeded first; the
// module holds per-instance state (status cache, fill token), so each test gets a
// fresh instance via vi.resetModules() + dynamic import.
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
   searchAvailable: vi.fn(() => true),
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

// The sync status readout consumed by the status footer.
const sync = vi.hoisted(() => ({
   state: vi.fn(() => ({ on: false, okAt: 0, error: "", parked: false })),
}))
vi.mock("./sync", () => sync)

// config.ts reads refresh.lastRefreshError() in its status footer; the live
// content refresh itself is app.ts's wiring, so the status source is all config
// needs here.
vi.mock("./refresh", () => ({ lastRefreshError: () => "" }))

type Config = typeof import("./config")

const SKELETON =
   `<section class="srr-config" hidden>` +
   `<header class="srr-config-head"><h2 class="srr-config-title">Settings</h2>` +
   `<button class="srr-config-close"></button></header>` +
   `<div class="srr-config-body">` +
   `<div class="srr-config-actions">` +
   `<button class="srr-config-search"></button>` +
   `<button class="srr-config-unread" aria-pressed="false"></button>` +
   `<button class="srr-config-imgproxy"></button>` +
   `<button class="srr-config-backup"></button>` +
   `<button class="srr-config-sync"></button>` +
   `<button class="srr-config-refresh"></button>` +
   `</div>` +
   `<div class="srr-config-settings"></div>` +
   `<div class="srr-config-filter"></div>` +
   `<div class="srr-config-status"></div>` +
   `</div></section>` +
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
   onSearch: vi.fn(),
   onSelect: vi.fn(),
   onUnreadToggle: vi.fn(),
   onClose: vi.fn(),
   pinEntry: vi.fn<() => { label: string; action: () => void } | null>(() => null),
   openImgProxy: vi.fn(),
   openBackup: vi.fn(),
   openSync: vi.fn(),
   onRefresh: vi.fn(),
}

async function mount(): Promise<Config> {
   document.body.innerHTML = SKELETON
   vi.resetModules()
   const config = await import("./config")
   config.setup($(".srr-config"), hooks)
   return config
}

beforeEach(() => {
   vi.clearAllMocks()
   // jsdom has no real scroll; keep scrollTo a no-op spy (open() scrolls to top).
   window.scrollTo = vi.fn()
   nav.getCurrentFilterKey.mockReturnValue("")
   nav.savedCount.mockReturnValue(0)
   nav.searchAvailable.mockReturnValue(true)
   nav.isUnreadOnly.mockReturnValue(false)
   nav.unreadCounts.mockResolvedValue(new Map())
   data.groupFeedsByTag.mockReturnValue({ tagged: new Map(), sortedTags: [], untagged: [] })
   data.lastFetchedAt.mockReturnValue(0)
   data.hasArticles.mockReturnValue(true)
   data.metaReady.mockReturnValue(true)
   data.idxSummaryDegraded.mockReturnValue(false)
   ;(isStale as ReturnType<typeof vi.fn>).mockReturnValue(false)
   sync.state.mockReturnValue({ on: false, okAt: 0, error: "", parked: false })
   hooks.pinEntry.mockReturnValue(null)
})

describe("open / close", () => {
   it("open reveals the surface and close hides it", async () => {
      const config = await mount()
      expect($(".srr-config").hidden).toBe(true)
      config.open()
      expect($(".srr-config").hidden).toBe(false)
      expect(config.isOpen()).toBe(true)
      config.close()
      expect($(".srr-config").hidden).toBe(true)
      expect(config.isOpen()).toBe(false)
   })

   it("the close button fires onClose", async () => {
      const config = await mount()
      config.open()
      $(".srr-config-close").click()
      expect(hooks.onClose).toHaveBeenCalledTimes(1)
   })

   it("open scrolls the window to the top (config stacks over a scrolled list)", async () => {
      const config = await mount()
      config.open()
      expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
   })
})

describe("search row", () => {
   it("fires onSearch when tapped and is enabled while search is available", async () => {
      const config = await mount()
      config.open()
      const btn = $<HTMLButtonElement>(".srr-config-search")
      expect(btn.disabled).toBe(false)
      btn.click()
      expect(hooks.onSearch).toHaveBeenCalledTimes(1)
   })

   it("is disabled while the search index is unavailable (rebuilding)", async () => {
      nav.searchAvailable.mockReturnValue(false)
      const config = await mount()
      config.open()
      expect($<HTMLButtonElement>(".srr-config-search").disabled).toBe(true)
   })
})

describe("filter list", () => {
   it("renders [ALL] and feed rows; picking one fires onSelect with its token", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Feed5" })],
      })
      const config = await mount()
      config.open()
      const all = $<HTMLAnchorElement>('.srr-config-filter a[data-value=""]')
      expect(all.textContent).toContain("[ALL]")
      $<HTMLAnchorElement>('.srr-config-filter a[data-value="5"]').dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      expect(hooks.onSelect).toHaveBeenCalledWith("5")
      all.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      expect(hooks.onSelect).toHaveBeenCalledWith("")
   })

   it("lists empty feeds (includeEmpty) only when read items are shown (unread-only off)", async () => {
      nav.isUnreadOnly.mockReturnValue(false) // read items shown → empty feeds too
      const config = await mount()
      config.open()
      expect(data.groupFeedsByTag).toHaveBeenCalledWith(true)

      data.groupFeedsByTag.mockClear()
      nav.isUnreadOnly.mockReturnValue(true) // unread-only → feeds with articles only
      config.render()
      expect(data.groupFeedsByTag).toHaveBeenCalledWith(false)
   })

   it("shows a ★ Saved row only when something is saved", async () => {
      const config = await mount()
      config.open()
      expect($(".srr-config-filter").querySelector('a[data-value="~saved"]')).toBeNull()
      nav.savedCount.mockReturnValue(4)
      config.render()
      const saved = $<HTMLAnchorElement>('.srr-config-filter a[data-value="~saved"]')
      expect(saved.textContent).toContain("★ Saved")
   })

   it("groups tagged feeds and a tag-toggle click expands/collapses without selecting", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [feed({ id: 1, title: "A", tag: "news" })]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      const config = await mount()
      config.open()
      const group = $(".srr-config-filter .srr-tag-group")
      expect(group.classList.contains("srr-tag-collapsed")).toBe(true) // not the active tag
      $(".srr-config-filter .srr-tag-toggle").dispatchEvent(
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
      const config = await mount()
      config.open()
      await flush()
      const has = $<HTMLAnchorElement>('.srr-config-filter a[data-value="1"]')
      const none = $<HTMLAnchorElement>('.srr-config-filter a[data-value="2"]')
      expect(has.querySelector(".srr-unread")!.textContent).toBe("3")
      expect(none.classList.contains("srr-hidden")).toBe(true) // 0 unread, hidden in unread-only
   })

   it("marks a feed with a fetch error by tinting its label, no leading dot", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 9, title: "Broken", ferr: "boom" })],
      })
      const config = await mount()
      config.open()
      const row = $<HTMLAnchorElement>('.srr-config-filter a[data-value="9"]')
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
      const config = await mount()
      config.open()
      const row = $<HTMLAnchorElement>('.srr-config-filter a[data-value="7"]')
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
      const config = await mount()
      config.open()
      expect($<HTMLAnchorElement>(".srr-config-filter .srr-tag-header").dataset.grade).toBe("crit")
   })

   it("leaves a healthy feed untinted (no data-grade, untinted ⓘ)", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 9, title: "Fine" })],
      })
      const config = await mount()
      config.open()
      const row = $<HTMLAnchorElement>('.srr-config-filter a[data-value="9"]')
      expect(row.dataset.grade).toBeUndefined()
   })
})

describe("info dialog", () => {
   it("puts an ⓘ details button on feed rows only (not tags / [ALL] / ★ Saved)", async () => {
      nav.savedCount.mockReturnValue(1)
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map([["news", [feed({ id: 1, title: "A", tag: "news" })]]]),
         sortedTags: ["news"],
         untagged: [feed({ id: 5, title: "Feed5" })],
      })
      const config = await mount()
      config.open()
      expect($('.srr-config-filter a[data-value="5"] .srr-info-btn')).not.toBeNull()
      expect($(".srr-config-filter .srr-tag-header").querySelector(".srr-info-btn")).toBeNull()
      expect($('.srr-config-filter a[data-value=""]').querySelector(".srr-info-btn")).toBeNull()
      expect($('.srr-config-filter a[data-value="~saved"]').querySelector(".srr-info-btn")).toBeNull()
   })

   it("opens a feed detail card with its fields and live unread, without selecting the row", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Feed5", url: "http://example.com/rss", recipe: "default", total_art: 12 })],
      })
      nav.unreadCounts.mockResolvedValue(new Map([[5, 7]]))
      const config = await mount()
      config.open()
      $('.srr-config-filter a[data-value="5"] .srr-info-btn').dispatchEvent(
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
      const config = await mount()
      config.open()
      $('.srr-config-filter a[data-value="5"] .srr-info-btn').dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      // dt "Articles" and dd "6" concatenate in textContent.
      expect($(".srr-info-body").textContent).toContain("Articles6")
   })
})

describe("unread toggle", () => {
   // Inverted toggle: the "Read" button is pressed only when read articles are
   // ALSO shown (unread-only off), unpressed in the unread-only default.
   it("is NOT pressed in the unread-only default and fires onUnreadToggle on click", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      const config = await mount()
      config.open()
      const btn = $<HTMLButtonElement>(".srr-config-unread")
      expect(btn.getAttribute("aria-pressed")).toBe("false")
      btn.click()
      expect(hooks.onUnreadToggle).toHaveBeenCalledTimes(1)
   })

   it("is pressed when unread-only is off (read articles are shown)", async () => {
      nav.isUnreadOnly.mockReturnValue(false)
      const config = await mount()
      config.open()
      expect($<HTMLButtonElement>(".srr-config-unread").getAttribute("aria-pressed")).toBe("true")
   })
})

describe("quick actions + settings", () => {
   it("fires openBackup / openImgProxy / openSync when their icon buttons are tapped", async () => {
      const config = await mount()
      config.open()
      $<HTMLButtonElement>(".srr-config-backup").click()
      expect(hooks.openBackup).toHaveBeenCalledTimes(1)
      $<HTMLButtonElement>(".srr-config-imgproxy").click()
      expect(hooks.openImgProxy).toHaveBeenCalledTimes(1)
      $<HTMLButtonElement>(".srr-config-sync").click()
      expect(hooks.openSync).toHaveBeenCalledTimes(1)
   })

   it("the refresh quick-action fires onRefresh", async () => {
      const config = await mount()
      config.open()
      $<HTMLButtonElement>(".srr-config-refresh").click()
      expect(hooks.onRefresh).toHaveBeenCalledTimes(1)
   })

   it("renders no settings rows when pinEntry is null", async () => {
      const config = await mount()
      config.open()
      expect(document.querySelectorAll(".srr-config-settings .srr-config-action").length).toBe(0)
   })

   it("renders the offline-pin row from pinEntry and runs its action", async () => {
      const action = vi.fn()
      hooks.pinEntry.mockReturnValue({ label: "Download for offline", action })
      const config = await mount()
      config.open()
      const pin = [...document.querySelectorAll<HTMLButtonElement>(".srr-config-settings .srr-config-action")].find(
         (b) => b.textContent === "Download for offline",
      )!
      pin.click()
      expect(action).toHaveBeenCalledTimes(1)
   })
})

describe("status section", () => {
   const text = () => $(".srr-config-status").textContent
   const flagText = () => $$(".srr-status-flag").map((f) => f.textContent)

   it("shows the freshness line when healthy (no flag)", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      const config = await mount()
      config.render()
      expect($(".srr-status-fresh").textContent).toBe("Last updated D100 · ago100")
      expect($$(".srr-status-flag")).toHaveLength(0)
   })

   it("flags a stale fetch in user-facing terms (no 'backend')", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      ;(isStale as ReturnType<typeof vi.fn>).mockReturnValue(true)
      const config = await mount()
      config.render()
      expect(flagText()).toContain("Feed updates may have paused")
      expect(text()).not.toContain("backend")
   })

   it("flags a rebuilding search index and a degrading idx", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      data.metaReady.mockReturnValue(false)
      data.idxSummaryDegraded.mockReturnValue(true)
      const config = await mount()
      config.render()
      expect(flagText()).toContain("Search unavailable while the index rebuilds")
      expect($(".srr-status-note").textContent).toBe("Optimizing for faster loading…")
   })

   it("reports sync state only when a sync endpoint is configured", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      const config = await mount()
      config.render()
      expect(text()).not.toContain("Sync") // off → silent

      sync.state.mockReturnValue({ on: true, okAt: 0, error: "", parked: false })
      config.render()
      expect($$(".srr-status-note").map((n) => n.textContent)).toContain("Sync pending…")

      sync.state.mockReturnValue({ on: true, okAt: 200, error: "", parked: false })
      config.render()
      expect($$(".srr-status-note").map((n) => n.textContent)).toContain("Synced ago200")

      sync.state.mockReturnValue({ on: true, okAt: 200, error: "HTTP 401", parked: false })
      config.render()
      expect(flagText()).toContain("Sync failed — HTTP 401")
   })

   it("flags a parked background sync (read progress would rewind)", async () => {
      data.lastFetchedAt.mockReturnValue(100)
      sync.state.mockReturnValue({ on: true, okAt: 200, error: "", parked: true })
      const config = await mount()
      config.render()
      expect(flagText()).toContain("Sync paused — read progress would rewind. Sync now to resolve.")
   })

   it("is empty when nothing has been fetched", async () => {
      data.lastFetchedAt.mockReturnValue(0)
      const config = await mount()
      config.render()
      expect(text()).toBe("")
   })
})
