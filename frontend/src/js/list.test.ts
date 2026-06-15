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
      // Smallest chron >= from whose article exists and matches the active filter
      // (mirrors data.findRight over filter.channels); -1 when none.
      findRight: vi.fn(async (from: number) => {
         for (let i = from; i < mock.db.total_art; i++) {
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
   const filter = { channels: new Map<number, number>(), active: false, saved: false, search: false }
   let seen: Record<string, number> = {}
   let saved = new Set<number>()
   let searchTerm = ""
   let unreadOnly = false
   // Reader position + list anchor (settable per test). Default -1 == "newest"
   // (no valid reader article), so render() lays a newest-first feed like before.
   let pos = -1
   let anchor = -1
   return {
      filter,
      _setSeen: (s: Record<string, number>) => (seen = s),
      _setSaved: (s: number[]) => (saved = new Set(s)),
      _setSearch: (term: string) => {
         filter.search = true
         filter.active = true
         searchTerm = term
      },
      _setPos: (p: number) => (pos = p),
      // Set both the reader position and the list anchor (the common case: the
      // list anchors at the article the reader sits on).
      _setAnchor: (a: number) => {
         anchor = a
         pos = a
      },
      // Set ONLY the list anchor (leave pos), simulating listAnchor resolving a
      // resume / oldest position with no live reader article.
      _setListAnchor: (a: number) => (anchor = a),
      isSearchFilter: vi.fn(() => filter.search),
      searchQuery: vi.fn(() => searchTerm),
      isUnreadOnly: vi.fn(() => unreadOnly),
      _setUnreadOnly: (v: boolean) => (unreadOnly = v),
      filterKey: vi.fn(() => (filter.saved ? "S" : filter.search ? "q:" + searchTerm : filter.active ? "F" : "")),
      getCurrentFilterKey: vi.fn(() => ""),
      tokensSuffix: vi.fn(() => (filter.saved ? "!~saved" : filter.active ? "!F" : "")),
      currentChron: vi.fn(() => pos),
      // The list's keyboard cursor sets nav.pos to the selected row (the chan arg
      // is still recorded for assertions; the real setter also clears prefetch).
      select: vi.fn((chron: number) => (pos = chron)),
      anchorChron: vi.fn(() => anchor),
      // The real listAnchor resolves resume/oldest per filter; the list only
      // consumes the resolved chronIdx, so the mock hands back the test's anchor
      // (that resolution is exercised in nav.test.ts against the real nav).
      listAnchor: vi.fn(async () => anchor),
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
      // The list's neighbor walk: channel mode delegates to data.findLeft/Right
      // (which read filter.channels), saved mode walks the explicit set.
      feedLeft: vi.fn(async (from: number) => {
         if (!filter.saved) return data.findLeft(from)
         let res = -1
         for (const c of [...saved].sort((a, b) => a - b)) {
            if (c > from) break
            res = c
         }
         return res
      }),
      feedRight: vi.fn(async (from: number) => {
         if (!filter.saved) return data.findRight(from)
         for (const c of [...saved].sort((a, b) => a - b)) if (c >= from) return c
         return -1
      }),
   }
})
vi.mock("./nav", () => nav)

vi.mock("./fmt", () => ({
   timeAgo: (n: number) => `${n}s`,
   srcColorIndex: (id: number) => id % 8,
   // Two chrons per "day" so a small fixture spans multiple strata.
   dayLabel: (n: number) => "D" + Math.floor(n / 2),
}))

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
      nav.filter.search = false
      nav._setUnreadOnly(false)
      nav._setSeen({})
      nav._setSaved([])
      nav._setPos(-1)
      nav._setAnchor(-1)
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
      // Source-first head: channel name leads, age right-aligned beside it.
      expect(top.querySelector(".srr-row-source")!.textContent).toBe("Chan1")
      // timeAgo is stubbed to `${when}s`; when = published || fetched_at (=chron here)
      expect(top.querySelector(".srr-row-age")!.textContent).toBe("3s")
      expect(top.getAttribute("href")).toBe("#3")
   })

   it("inserts a sticky day divider before the first row of each day stratum", async () => {
      // dayLabel stub buckets 2 chrons/day; rows 5..0 → D2,D2,D1,D1,D0,D0.
      setIndex(6)
      await list.render()
      const divs = Array.from(document.querySelectorAll(".srr-day-divider"))
      expect(divs.map((d) => d.textContent)).toEqual(["D2", "D1", "D0"])
      // Each divider sits immediately before the newest row of its day.
      expect((divs[0].nextElementSibling as HTMLElement).dataset.chron).toBe("5")
      expect((divs[1].nextElementSibling as HTMLElement).dataset.chron).toBe("3")
   })

   it("omits day dividers in search mode (title hits are cross-time)", async () => {
      setIndex(6)
      nav._setSearch("x")
      await list.render()
      expect(document.querySelectorAll(".srr-day-divider").length).toBe(0)
   })

   it("steps the keyboard cursor across a day boundary, skipping the divider", async () => {
      setIndex(6)
      nav._setAnchor(3) // start on chron 3 (a D1 row); chron 4 is D2, across a divider
      await list.render()
      expect(await list.moveSelection("newer")).toBe(4)
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

   it("search mode shows a 'no matching articles' state when the query has no hits", async () => {
      setIndex(4, () => 1)
      nav._setSearch("zzz")
      // The first (and only) walk finds nothing → empty list. Once, so the
      // default findLeft impl is restored for the following tests.
      data.findLeft.mockResolvedValueOnce(-1)
      await list.render()
      const empty = container.querySelector(".srr-list-empty")
      expect(empty).not.toBeNull()
      // Names the query and offers recovery, instead of a vague "no matches".
      expect(empty!.textContent).toContain("No titles match")
      expect(empty!.querySelector(".srr-empty-em")!.textContent).toBe("“zzz”")
   })

   it("shows an 'all caught up' state when unseen-only leaves nothing unread", async () => {
      setIndex(4, () => 1)
      nav.filter.active = true
      nav.filter.channels = new Map([[99, 0]]) // nothing matches → empty feed
      nav._setUnreadOnly(true)
      await list.render()
      const empty = container.querySelector(".srr-list-empty")
      expect(empty).not.toBeNull()
      expect(empty!.querySelector(".srr-empty-eyebrow")!.textContent).toBe("All caught up")
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

   it("show() re-anchors (no rebuild/walk) when the reader's article is a rendered row", async () => {
      setIndex(3)
      await list.render()
      data.findLeft.mockClear()
      data.findRight.mockClear()
      nav._setPos(1) // the reader sat on a row that's already in the window
      await list.show() // same filterKey + row present → reuse path, no walk
      expect(data.findLeft).not.toHaveBeenCalled()
      expect(data.findRight).not.toHaveBeenCalled()
   })

   it("anchors at the current position: newer ('next') rows above, older below", async () => {
      setIndex(10)
      nav._setAnchor(5) // the reader's article
      await list.render()
      // Newest-first: newer (will-be-seen-next) above the anchor, older below.
      expect($chrons()).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
   })

   it("highlights the reader's current article row, moving it as you read", async () => {
      const current = () =>
         $rows()
            .filter((a) => a.classList.contains("srr-row-current"))
            .map((a) => Number(a.dataset.chron))
      setIndex(10)
      nav._setAnchor(5) // the reader's article
      await list.render()
      expect(current()).toEqual([5]) // exactly the reader's row is highlighted
      // Reading another article moves the highlight on the next refresh (return path).
      nav._setPos(7)
      list.refresh()
      expect(current()).toEqual([7])
   })

   it("anchors at the oldest article (no nav info) with the newer rows above it", async () => {
      setIndex(10)
      nav._setListAnchor(0) // listAnchor resolved the filter's oldest article
      await list.render()
      // Oldest at the bottom; every newer article sits above it (scroll up to advance).
      expect($chrons()).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
      expect($chrons()[$rows().length - 1]).toBe(0)
      // The oldest row is the anchor scrolled to the top (jsdom scroll is a spy).
      expect(window.scrollTo).toHaveBeenCalled()
   })

   it("pages newer batches above on loadNewer (prepend), then exhausts at the top", async () => {
      setIndex(100)
      nav._setAnchor(50)
      await list.render()
      // One batch each side of the anchor: newer [80..51] above, [50..21] below.
      expect($chrons()[0]).toBe(80)
      expect($chrons()[$rows().length - 1]).toBe(21)
      await list.loadNewer()
      expect($chrons()[0]).toBe(99) // paged up to the newest, prepended above
      await list.loadNewer() // exhausted upward: no-op
      expect($chrons()[0]).toBe(99)
      // Older paging downward still works from the same window.
      await list.loadMore()
      expect($chrons()[$rows().length - 1]).toBe(0)
   })

   it("show() rebuilds when the reader's article is outside the loaded window", async () => {
      setIndex(100)
      nav._setAnchor(50)
      await list.render() // window [80..21]
      expect($chrons()).not.toContain(5)
      data.findLeft.mockClear()
      nav._setAnchor(5) // the reader jumped far below the window
      await list.show()
      expect(data.findLeft).toHaveBeenCalled() // rebuilt
      expect($chrons()).toContain(5)
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

   // ── Keyboard selection cursor (moveSelection) ──────────────────────────────
   // A/← step to the older neighbor (row below), D/→ to the newer (row above) —
   // mirroring the reader's left()/right(). The highlight is .srr-row-current.
   const $current = () =>
      $rows()
         .filter((a) => a.classList.contains("srr-row-current"))
         .map((a) => Number(a.dataset.chron))

   it("moveSelection steps the highlight to the older (down) / newer (up) neighbor", async () => {
      setIndex(10)
      nav._setAnchor(5) // reader's article → row 5 starts highlighted
      await list.render()
      expect($current()).toEqual([5])

      expect(await list.moveSelection("older")).toBe(4) // A/← → older = the row below
      expect($current()).toEqual([4]) // exactly one row highlighted
      expect(nav.select).toHaveBeenLastCalledWith(4, 1) // pos + channel synced

      expect(await list.moveSelection("newer")).toBe(5) // D/→ → newer = the row above
      expect(await list.moveSelection("newer")).toBe(6)
      expect($current()).toEqual([6])
   })

   it("moveSelection pages the next batch when stepping past the loaded edge", async () => {
      setIndex(35)
      nav._setAnchor(34) // newest; one older batch below → window [34..5]
      await list.render()
      expect($rows().length).toBe(30)
      // Walk the cursor down to the oldest loaded row (5).
      for (let i = 0; i < 29; i++) await list.moveSelection("older")
      expect($current()).toEqual([5])
      // One more older step pages the next batch in and lands on 4.
      expect(await list.moveSelection("older")).toBe(4)
      expect($rows().length).toBe(35)
      expect($current()).toEqual([4])
   })

   const $rowFor = (chron: number) => $rows().find((a) => Number(a.dataset.chron) === chron)!

   it("at the oldest article it bumps the row (down) instead of moving", async () => {
      setIndex(5)
      nav._setAnchor(0) // oldest = current, at the bottom of the window
      await list.render()
      expect($current()).toEqual([0])
      expect(await list.moveSelection("older")).toBe(-1)
      expect($current()).toEqual([0]) // unchanged
      expect($rowFor(0).classList.contains("srr-row-bump-down")).toBe(true) // boundary cue
   })

   it("at the newest article it bumps the row (up) instead of moving", async () => {
      setIndex(5)
      nav._setAnchor(4) // newest = current, at the top of the window
      await list.render()
      expect($current()).toEqual([4])
      expect(await list.moveSelection("newer")).toBe(-1)
      expect($current()).toEqual([4])
      expect($rowFor(4).classList.contains("srr-row-bump-up")).toBe(true)
   })

   it("with no cursor yet, the first step establishes the selection on a visible row", async () => {
      setIndex(4) // pos = -1 → no row highlighted
      await list.render()
      expect($current()).toEqual([])
      const landed = await list.moveSelection("newer")
      // The first key drops the cursor (no step); jsdom's zero-rect geometry
      // falls back to the oldest visible row. Exactly one row is now current.
      expect(landed).toBeGreaterThanOrEqual(0)
      expect($current()).toEqual([landed])
      expect(nav.select).toHaveBeenCalledWith(landed, expect.anything())
   })
})
