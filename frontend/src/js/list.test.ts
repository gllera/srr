import { describe, it, expect, vi, beforeEach } from "vitest"

// list.ts captures its container at setup() and holds module-scoped paging
// state, so each test gets a fresh instance via vi.resetModules() + dynamic
// import. ./data and ./nav are mocked (no real fetches / localStorage); ./fmt's
// timeAgo is stubbed to a deterministic string.

const data = vi.hoisted(() => {
   const mock = {
      db: { total_art: 0, channels: {} } as IDB,
      _arts: new Map<number, IArticle>(),
      // Largest chron <= from whose article exists and matches the active filter
      // (mirrors data.findLeft over filter.channels); -1 when none.
      findLeft: vi.fn(async (from: number) => {
         for (let i = from; i >= 0; i--) {
            const a = mock._arts.get(i)
            if (!a) continue
            if (nav.filter.channels.size > 0 && !nav.filter.channels.has(a.s)) continue
            return i
         }
         return -1
      }),
      loadArticle: vi.fn(async (chron: number) => mock._arts.get(chron)!),
      channelTitle: vi.fn((id: number) => "Chan" + id),
   }
   return mock
})
vi.mock("./data", () => data)

const nav = vi.hoisted(() => {
   const filter = { channels: new Map<number, number>(), active: false, saved: false }
   let seen: Record<string, number> = {}
   let saved = new Set<number>()
   return {
      filter,
      _setSeen: (s: Record<string, number>) => (seen = s),
      _setSaved: (s: number[]) => (saved = new Set(s)),
      filterKey: vi.fn(() => (filter.saved ? "S" : filter.active ? "F" : "")),
      getCurrentFilterKey: vi.fn(() => ""),
      tokensSuffix: vi.fn(() => (filter.saved ? "!~saved" : filter.active ? "!F" : "")),
      getSeenMap: vi.fn(() => seen),
      isRowUnread: vi.fn((chron: number, chan: number, s: Record<string, number>) => {
         const v = s["chan:" + chan]
         return v === undefined || chron > v
      }),
      isSaved: vi.fn((chron: number) => saved.has(chron)),
      toggleSaved: vi.fn((chron: number) => {
         if (saved.has(chron)) {
            saved.delete(chron)
            return false
         }
         saved.add(chron)
         return true
      }),
      savedCount: vi.fn(() => saved.size),
      // The list's neighbor walk: channel mode delegates to data.findLeft (which
      // reads filter.channels), saved mode walks the explicit set.
      feedLeft: vi.fn(async (from: number) => {
         if (!filter.saved) return data.findLeft(from)
         let res = -1
         for (const c of [...saved].sort((a, b) => a - b)) {
            if (c > from) break
            res = c
         }
         return res
      }),
   }
})
vi.mock("./nav", () => nav)

vi.mock("./fmt", () => ({ timeAgo: (n: number) => `${n}s` }))

type List = typeof import("./list")

const art = (over: Partial<IArticle>): IArticle => ({ s: 1, a: 100, p: 0, t: "T", l: "", c: "", ...over }) as IArticle

// Seed the fake index with one article per chron (0..n-1). `chan(chron)` lets a
// test interleave channels; default everything to channel 1.
function setIndex(n: number, chan: (chron: number) => number = () => 1) {
   data._arts.clear()
   for (let i = 0; i < n; i++) data._arts.set(i, art({ s: chan(i), t: "title " + i, a: i }))
   data.db.total_art = n
}

const $rows = () => Array.from(document.querySelector(".srr-list")!.querySelectorAll<HTMLElement>("a.srr-row"))
const $chrons = () => $rows().map((a) => Number(a.dataset.chron))

describe("list", () => {
   let list: List
   let container: HTMLElement
   let opened: number[]

   beforeEach(async () => {
      document.body.innerHTML = '<div class="srr-list"></div>'
      container = document.querySelector(".srr-list")!
      opened = []
      // jsdom has no real scroll; keep scrollTo a no-op spy.
      window.scrollTo = vi.fn()
      nav.filter.channels = new Map()
      nav.filter.active = false
      nav.filter.saved = false
      nav._setSeen({})
      nav._setSaved([])
      vi.resetModules()
      list = await import("./list")
      list.setup(container, (chron) => opened.push(chron))
   })

   it("renders rows newest-first with title + channel·age meta", async () => {
      setIndex(4)
      await list.render()
      expect($chrons()).toEqual([3, 2, 1, 0])
      const top = $rows()[0]
      expect(top.querySelector(".srr-row-title")!.textContent).toBe("title 3")
      // timeAgo is stubbed to `${when}s`; when = published || fetched_at (=chron here)
      expect(top.querySelector(".srr-row-meta")!.textContent).toBe("Chan1 · 3s")
      expect(top.getAttribute("href")).toBe("#3")
   })

   it("marks rows unread strictly after the channel's seen high-water", async () => {
      setIndex(5)
      nav._setSeen({ "chan:1": 2 }) // 0,1,2 read · 3,4 unread
      await list.render()
      const unread = (chron: number) =>
         $rows()
            .find((a) => Number(a.dataset.chron) === chron)!
            .classList.contains("srr-row-unread")
      expect(unread(4)).toBe(true)
      expect(unread(3)).toBe(true)
      expect(unread(2)).toBe(false)
      expect(unread(0)).toBe(false)
   })

   it("a never-seen channel renders every row unread", async () => {
      setIndex(3)
      await list.render()
      expect($rows().every((a) => a.classList.contains("srr-row-unread"))).toBe(true)
   })

   it("opens an article (and intercepts the row click) on tap", async () => {
      setIndex(4)
      await list.render()
      const row = $rows().find((a) => Number(a.dataset.chron) === 2)!
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true })
      row.dispatchEvent(ev)
      expect(opened).toEqual([2])
      expect(ev.defaultPrevented).toBe(true)
   })

   it("pages older batches on loadMore, then exhausts", async () => {
      setIndex(65) // BATCH=30 → 30, 60, 65
      await list.render()
      expect($rows().length).toBe(30)
      expect($chrons()[0]).toBe(64)
      await list.loadMore()
      expect($rows().length).toBe(60)
      await list.loadMore()
      expect($rows().length).toBe(65)
      expect($chrons()[64]).toBe(0)
      // Exhausted: further loads are no-ops.
      await list.loadMore()
      expect($rows().length).toBe(65)
   })

   it("only includes channels in the active filter", async () => {
      setIndex(6, (c) => (c % 2 === 0 ? 1 : 2)) // even=chan1, odd=chan2
      nav.filter.active = true
      nav.filter.channels = new Map([[1, 0]])
      await list.render()
      expect($chrons()).toEqual([4, 2, 0])
   })

   it("shows an empty state for an empty store", async () => {
      setIndex(0)
      await list.render()
      expect(container.querySelector(".srr-list-empty")).not.toBeNull()
      expect($rows().length).toBe(0)
   })

   it("shows an empty state when the filter matches nothing", async () => {
      setIndex(4, () => 1)
      nav.filter.active = true
      nav.filter.channels = new Map([[99, 0]]) // no articles in channel 99
      await list.render()
      expect(container.querySelector(".srr-list-empty")).not.toBeNull()
   })

   it("refresh re-derives read/unread dots from the live seen map", async () => {
      setIndex(4)
      await list.render()
      expect($rows().every((a) => a.classList.contains("srr-row-unread"))).toBe(true)
      nav._setSeen({ "chan:1": 3 }) // now all read
      list.refresh()
      expect($rows().some((a) => a.classList.contains("srr-row-unread"))).toBe(false)
   })

   it("rerender rebuilds even when the filter key is unchanged", async () => {
      setIndex(3)
      await list.render()
      expect($chrons()).toEqual([2, 1, 0])
      setIndex(5) // store grew (e.g. unseen-only flip changed membership)
      await list.rerender()
      expect($chrons()).toEqual([4, 3, 2, 1, 0])
   })

   it("show() refreshes (no rebuild) when re-entered with the same filter", async () => {
      setIndex(3)
      await list.render()
      data.findLeft.mockClear()
      await list.show() // same filterKey → refresh path, no findLeft walk
      expect(data.findLeft).not.toHaveBeenCalled()
   })

   const $star = (chron: number) =>
      $rows()
         .find((a) => Number(a.dataset.chron) === chron)!
         .querySelector<HTMLElement>(".srr-row-star")!
   const tapStar = (chron: number) =>
      $star(chron).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))

   it("renders a save star per row; saved rows carry srr-row-saved", async () => {
      setIndex(3)
      nav._setSaved([1])
      await list.render()
      expect($rows().every((a) => a.querySelector(".srr-row-star") !== null)).toBe(true)
      const saved = (chron: number) =>
         $rows()
            .find((a) => Number(a.dataset.chron) === chron)!
            .classList.contains("srr-row-saved")
      expect(saved(1)).toBe(true)
      expect(saved(0)).toBe(false)
      expect(saved(2)).toBe(false)
      expect($star(1).getAttribute("aria-pressed")).toBe("true")
   })

   it("tapping a row's star toggles saved without opening the reader", async () => {
      setIndex(3)
      await list.render()
      tapStar(2)
      expect(nav.toggleSaved).toHaveBeenCalledWith(2)
      expect(opened).toEqual([]) // the reader did NOT open
      const row = $rows().find((a) => Number(a.dataset.chron) === 2)!
      expect(row.classList.contains("srr-row-saved")).toBe(true)
      expect($star(2).getAttribute("aria-pressed")).toBe("true")
   })

   it("the saved view renders only saved chrons, newest-first", async () => {
      setIndex(6)
      nav._setSaved([0, 2, 4])
      nav.filter.saved = true
      await list.render()
      expect($chrons()).toEqual([4, 2, 0])
   })

   it("the saved view drops a row when its star is un-saved", async () => {
      setIndex(6)
      nav._setSaved([0, 2, 4])
      nav.filter.saved = true
      await list.render()
      tapStar(2)
      expect(nav.toggleSaved).toHaveBeenCalledWith(2)
      expect($chrons()).toEqual([4, 0]) // 2 left the feed
   })

   it("the saved view shows an empty state once the last row is un-saved", async () => {
      setIndex(3)
      nav._setSaved([1])
      nav.filter.saved = true
      await list.render()
      expect($chrons()).toEqual([1])
      tapStar(1)
      expect($rows().length).toBe(0)
      expect(container.querySelector(".srr-list-empty")).not.toBeNull()
   })

   it("refresh drops rows un-saved elsewhere (e.g. from the reader) in the saved view", async () => {
      setIndex(6)
      nav._setSaved([0, 2, 4])
      nav.filter.saved = true
      await list.render()
      expect($chrons()).toEqual([4, 2, 0])
      nav._setSaved([0, 4]) // article 2 un-saved in the reader
      list.refresh()
      expect($chrons()).toEqual([4, 0])
   })
})
