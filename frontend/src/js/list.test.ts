import { describe, it, expect, vi, beforeEach } from "vitest"

// list.ts captures its container at setup() and holds module-scoped paging
// state, so each test gets a fresh instance via vi.resetModules() + dynamic
// import. ./data and ./nav are mocked (no real fetches / localStorage); ./fmt's
// timeAgo is stubbed to a deterministic string.

const data = vi.hoisted(() => {
   const mock = {
      db: { total_art: 0, feeds: {} } as IDB,
      _arts: new Map<number, IArticle>(),
      // Largest chron <= from whose article exists and matches the active filter
      // (mirrors data.findLeft over filter.feeds); -1 when none.
      findLeft: vi.fn(async (from: number) => {
         for (let i = from; i >= 0; i--) {
            const a = mock._arts.get(i)
            if (!a) continue
            if (nav.filter.feeds.size > 0 && !nav.filter.feeds.has(a.f)) continue
            return i
         }
         return -1
      }),
      // Smallest chron >= from whose article exists and matches the active filter
      // (mirrors data.findRight over filter.feeds); -1 when none.
      findRight: vi.fn(async (from: number) => {
         for (let i = from; i < mock.db.total_art; i++) {
            const a = mock._arts.get(i)
            if (!a) continue
            if (nav.filter.feeds.size > 0 && !nav.filter.feeds.has(a.f)) continue
            return i
         }
         return -1
      }),
      loadArticle: vi.fn(async (chron: number) => mock._arts.get(chron)!),
      loadMeta: vi.fn(async (chron: number) => {
         const a = mock._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      }),
      feedTitle: vi.fn((id: number) => "Feed" + id),
      // Resident after the anchor walk; the list reads it to sync nav.select's
      // feed arg when it makes the resolved anchor the current selection.
      getFeedId: vi.fn(async (chron: number) => mock._arts.get(chron)!.f),
   }
   return mock
})
vi.mock("./data", () => data)

const nav = vi.hoisted(() => {
   const filter = { feeds: new Map<number, number>(), active: false, saved: false, search: false }
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
      // Search snapshot cards (fe-opt#F1): default undefined so renderSearch takes
      // its defensive loadMeta fallback, matching the existing search-render tests.
      searchCard: vi.fn(() => undefined),
      isUnreadOnly: vi.fn(() => unreadOnly),
      _setUnreadOnly: (v: boolean) => (unreadOnly = v),
      filterKey: vi.fn(() => (filter.saved ? "S" : filter.search ? "q:" + searchTerm : filter.active ? "F" : "")),
      getCurrentFilterKey: vi.fn(() => ""),
      filterLabel: vi.fn((key: string) => (/^\d+$/.test(key) ? data.feedTitle(Number(key)) : key)),
      tokensSuffix: vi.fn(() => (filter.saved ? "!~saved" : filter.active ? "!F" : "")),
      currentChron: vi.fn(() => pos),
      // The list's keyboard cursor sets nav.pos to the selected row (the feed arg
      // is still recorded for assertions; the real setter also clears prefetch).
      select: vi.fn((chron: number) => (pos = chron)),
      anchorChron: vi.fn(() => anchor),
      // The real listAnchor resolves resume/oldest per filter; the list only
      // consumes the resolved chronIdx, so the mock hands back the test's anchor
      // (that resolution is exercised in nav.test.ts against the real nav).
      listAnchor: vi.fn(async () => anchor),
      getSeenMap: vi.fn(() => seen),
      isRowUnread: vi.fn((chron: number, feed: number, s: Record<string, number>) => {
         const v = s["feed:" + feed]
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
      // The list's neighbor walk: feed mode delegates to data.findLeft/Right
      // (which read filter.feeds), saved mode walks the explicit set.
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
   CHECK_SVG: "<svg></svg>",
}))

type List = typeof import("./list")

const art = (over: Partial<IArticle>): IArticle => ({ f: 1, a: 100, p: 0, t: "T", l: "", c: "", ...over }) as IArticle

// Seed the fake index with one article per chron (0..n-1). `feed(chron)` lets a
// test interleave feeds; default everything to feed 1.
function setIndex(n: number, feed: (chron: number) => number = () => 1) {
   data._arts.clear()
   for (let i = 0; i < n; i++) data._arts.set(i, art({ f: feed(i), t: "title " + i, a: i }))
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
      nav.filter.feeds = new Map()
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

   it("renders rows newest-first with title + feed·age meta", async () => {
      setIndex(4)
      await list.render()
      expect($chrons()).toEqual([3, 2, 1, 0])
      const top = $rows()[0]
      expect(top.querySelector(".srr-row-title")!.textContent).toBe("title 3")
      // Source-first head: feed name leads, age right-aligned beside it.
      expect(top.querySelector(".srr-row-source")!.textContent).toBe("Feed1")
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

   it("paints skeleton rows immediately, then fills them in place", async () => {
      setIndex(3) // chrons 0,1,2 → titles "title 0..2", newest-first 2,1,0
      // Gate loadMeta so we can inspect the skeleton phase before content lands.
      let release: (() => void) | null = null
      const gate = new Promise<void>((r) => (release = () => r()))
      data.loadMeta.mockImplementation(async (chron: number) => {
         await gate
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })

      const p = list.render()
      // Flush microtasks (the async feed walk) without resolving the gated fills.
      await new Promise((r) => setTimeout(r, 0))
      const skeletons = $rows()
      expect(skeletons.length).toBe(3)
      expect(skeletons.every((r) => r.classList.contains("srr-row-skeleton"))).toBe(true)
      expect(skeletons[0].querySelector(".srr-row-title")!.textContent).toBe("")

      release!()
      await p
      const filled = $rows()
      expect(filled.every((r) => !r.classList.contains("srr-row-skeleton"))).toBe(true)
      expect(filled[0].querySelector(".srr-row-title")!.textContent).toBe("title 2")

      // Restore the default (non-gated) loadMeta so later tests aren't affected.
      data.loadMeta.mockImplementation(async (chron: number) => {
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
   })

   it("fills packs nearest the navigation anchor first, with bounded concurrency", async () => {
      setIndex(10) // chrons 0..9, all feed 1
      nav._setAnchor(5) // returning to chron 5 → list anchors (centers) there
      const calls: number[] = []
      let release: (() => void) | null = null
      const gate = new Promise<void>((r) => (release = () => r()))
      data.loadMeta.mockImplementation(async (chron: number) => {
         calls.push(chron)
         await gate
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })

      const p = list.render()
      await new Promise((r) => setTimeout(r, 0)) // skeletons placed + first wave dispatched
      // Bounded concurrency: only the pool's width is in flight before any resolve.
      expect(calls.length).toBe(6)
      // …and that first wave is the six rows nearest the anchor (chron 5), never
      // the far ends (0, 9, 1) — content you're looking at loads first.
      expect(calls.slice().sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8])

      release!()
      await p
      expect($rows().every((r) => !r.classList.contains("srr-row-skeleton"))).toBe(true)

      data.loadMeta.mockImplementation(async (chron: number) => {
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
   })

   // Default (non-gated) loadMeta, restored by tests that install a gated one.
   const defaultLoadMeta = () =>
      data.loadMeta.mockImplementation(async (chron: number) => {
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })

   it("fires onInteractive at first paint (before fills) and on an empty store", async () => {
      setIndex(3)
      let release: (() => void) | null = null
      const gate = new Promise<void>((r) => (release = () => r()))
      data.loadMeta.mockImplementation(async (chron: number) => {
         await gate
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
      const cb = vi.fn()
      const p = list.render(false, cb)
      await new Promise((r) => setTimeout(r, 0))
      expect(cb).toHaveBeenCalledTimes(1) // fired at first paint, fills still gated
      release!()
      await p
      expect(cb).toHaveBeenCalledTimes(1) // not re-fired after fills
      defaultLoadMeta()

      // An empty store must STILL fire it — otherwise the surface stays 'busy'.
      data.db.total_art = 0
      const cb2 = vi.fn()
      await list.render(false, cb2)
      expect(cb2).toHaveBeenCalledTimes(1)
   })

   it("fires onInteractive on the show() reuse path (no rebuild)", async () => {
      setIndex(4)
      nav._setAnchor(2) // a rendered row, so show() takes the reuse path
      await list.render()
      const cb = vi.fn()
      await list.show(false, cb) // builtKey matches + row present → reuse
      expect(cb).toHaveBeenCalledTimes(1)
   })

   it("a superseding render aborts the gated one cleanly (no dup rows, bounded waste)", async () => {
      setIndex(20)
      let release: (() => void) | null = null
      const gate = new Promise<void>((r) => (release = () => r()))
      const calls: number[] = []
      data.loadMeta.mockImplementation(async (chron: number) => {
         calls.push(chron)
         await gate
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
      const p1 = list.render()
      await new Promise((r) => setTimeout(r, 0))
      expect(calls.length).toBe(6) // p1's first pool wave only
      const p2 = list.render() // supersede before releasing
      await new Promise((r) => setTimeout(r, 0))
      expect(calls.length).toBe(12) // + p2's first wave
      release!()
      await Promise.all([p1, p2])
      // p1 dispatched only its first wave (6) then aborted on the token guard; p2
      // ran all 20. 6 + 20 = 26 (not 40), proving the superseded run stops fetching.
      expect(calls.length).toBe(26)
      // One clean set of 20 filled rows — no duplicates from the superseded run.
      expect($rows().length).toBe(20)
      expect($rows().every((r) => !r.classList.contains("srr-row-skeleton"))).toBe(true)
      defaultLoadMeta()
   })

   it("search renders all hits via feedLeft walk (no streaming)", async () => {
      // In the new design renderSearch calls nav.feedLeft repeatedly (through walk),
      // not searchMore. Set up three articles at sparse chrons; feedLeft skips gaps.
      nav.filter.search = true
      data._arts.clear()
      data._arts.set(9, art({ f: 1, a: 9, t: "a nine" }))
      data._arts.set(5, art({ f: 1, a: 5, t: "a five" }))
      data._arts.set(1, art({ f: 1, a: 1, t: "a one" }))
      data.db.total_art = 10
      await list.render()
      expect($rows().map((r) => r.querySelector(".srr-row-title")!.textContent)).toEqual(["a nine", "a five", "a one"])
   })

   it("search stops the initial render at one batch (BATCH=30) and pages older via loadMore", async () => {
      // 31 consecutive hits: walk collects first 30 (BATCH), leaving chron 0 for loadMore.
      nav.filter.search = true
      data._arts.clear()
      for (let k = 0; k <= 30; k++) data._arts.set(k, art({ f: 1, a: k, t: "t" + k }))
      data.db.total_art = 31
      await list.render()
      expect($rows().length).toBe(30) // first BATCH of 30 hits
      await list.loadMore()
      expect($rows().length).toBe(31) // the 31st hit paged in
      expect($rows()[30].querySelector(".srr-row-title")!.textContent).toBe("t0")
   })

   it("fillRow falls back to '(untitled)' for an empty title", () => {
      const row = list.rowEl(1, null, {})
      list.fillRow(row, { f: 1, w: 100, t: "" }, {})
      expect(row.querySelector(".srr-row-title")!.textContent).toBe("(untitled)")
   })

   it("relabelDividers builds nothing while every row is still a skeleton", () => {
      const rows = document.createElement("div")
      rows.className = "srr-list-rows"
      rows.append(list.rowEl(2, null, {}), list.rowEl(1, null, {}), list.rowEl(0, null, {}))
      document.querySelector(".srr-list")!.replaceChildren(rows)
      list.__setRowsForTest(rows)
      list.__relabelDividersForTest()
      expect(rows.querySelectorAll(".srr-day-divider").length).toBe(0)
   })

   it("skips the post-fill anchor re-assert after a user scroll gesture", async () => {
      setIndex(10)
      nav._setAnchor(5) // anchoredMid → render positions and would re-assert on fill
      let release: (() => void) | null = null
      const gate = new Promise<void>((r) => (release = () => r()))
      data.loadMeta.mockImplementation(async (chron: number) => {
         await gate
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
      const scrollSpy = window.scrollTo as unknown as ReturnType<typeof vi.fn>
      const p = list.render()
      await new Promise((r) => setTimeout(r, 0))
      const afterPaint = scrollSpy.mock.calls.length // initial positioning done
      document.dispatchEvent(new Event("wheel")) // user takes over scrolling
      release!()
      await p
      // No additional scrollTo from the per-fill / final re-assert — user wins.
      expect(scrollSpy.mock.calls.length).toBe(afterPaint)
      defaultLoadMeta()
   })

   it("propagates a fill failure so the app can surface it (no silent permanent skeleton)", async () => {
      setIndex(3)
      data.loadMeta.mockImplementation(async (chron: number) => {
         if (chron === 2) throw new Error("meta fetch failed")
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
      await expect(list.render()).rejects.toThrow("meta fetch failed")
      defaultLoadMeta()
   })

   it("search render: fills rows via loadMeta, selects newest, shows terminus", async () => {
      // renderSearch uses the skeleton→loadMeta fill pattern. After awaiting render()
      // all rows are filled (no skeletons). The newest hit becomes the current article.
      nav.filter.search = true
      data._arts.clear()
      data._arts.set(9, art({ f: 1, a: 1700000009, t: "alpha nine" }))
      data._arts.set(5, art({ f: 1, a: 1700000005, t: "alpha five" }))
      data._arts.set(1, art({ f: 1, a: 1700000001, t: "alpha one" }))
      data.db.total_art = 10

      await list.render()
      const rows = $rows()
      expect(rows.map((r) => r.querySelector(".srr-row-title")!.textContent)).toEqual([
         "alpha nine",
         "alpha five",
         "alpha one",
      ])
      // Rows are filled by loadMeta — no skeletons remain after await.
      expect(rows.some((r) => r.classList.contains("srr-row-skeleton"))).toBe(false)
      // Newest hit selected as the reader position.
      expect(rows.find((r) => r.classList.contains("srr-row-current"))?.dataset.chron).toBe("9")
      expect(nav.select).toHaveBeenCalledWith(9, 1)
      // Hit set exhausted → terminus shown.
      expect(container.querySelector(".srr-wire-end")).not.toBeNull()
   })

   it("re-renders newest-first regardless of prior feedLeft calls (no drained-iterator regression)", async () => {
      // In the new snapshot design there is no mutable iterator to drain — each
      // render() starts a fresh walk from feedLeft(total_art-1). Verify that calling
      // render() again after reader navigation still shows the full hit set top-down.
      nav.filter.search = true
      data._arts.clear()
      data._arts.set(9, art({ f: 1, a: 9, t: "newest" }))
      data._arts.set(5, art({ f: 1, a: 5, t: "middle" }))
      data._arts.set(1, art({ f: 1, a: 1, t: "oldest" }))
      data.db.total_art = 10

      // Simulate reader navigation: call feedLeft a few times (as if stepping).
      await nav.feedLeft(8) // → 5
      await nav.feedLeft(4) // → 1

      // Re-render: must show the full hit set from newest to oldest.
      await list.render()
      expect($rows().map((r) => r.querySelector(".srr-row-title")!.textContent)).toEqual(["newest", "middle", "oldest"])
   })

   it("relabelDividers skips skeleton rows (no data-ts)", () => {
      // Build a rows container by hand: one filled row, one skeleton.
      const rows = document.createElement("div")
      rows.className = "srr-list-rows"
      const filled = list.rowEl(5, { f: 1, w: 1700000000, t: "a" }, {})
      const skel = list.rowEl(4, null, {})
      rows.append(filled, skel)
      document.querySelector(".srr-list")!.replaceChildren(rows)
      list.__setRowsForTest(rows)
      list.__relabelDividersForTest()
      // Exactly one divider — for the filled row; the skeleton contributes none.
      expect(rows.querySelectorAll(".srr-day-divider").length).toBe(1)
   })

   it("builds a skeleton row when no card is given, then fills it", () => {
      const row = list.rowEl(3, null, {})
      expect(row.classList.contains("srr-row-skeleton")).toBe(true)
      expect(row.dataset.chron).toBe("3")
      expect(row.getAttribute("href")).toContain("#3")
      // No content yet, and no data-ts (dividers must skip it).
      expect(row.querySelector(".srr-row-title")!.textContent).toBe("")
      expect(row.dataset.ts).toBeUndefined()

      list.fillRow(row, { f: 1, w: 1700000003, t: "title 3" }, {})
      expect(row.classList.contains("srr-row-skeleton")).toBe(false)
      expect(row.dataset.ts).toBe("1700000003")
      expect(row.dataset.feed).toBe("1")
      expect(row.querySelector(".srr-row-title")!.textContent).toBe("title 3")
      expect(row.querySelector(".srr-row-source")!.textContent).toBe("Feed1")
   })

   it("steps the keyboard cursor across a day boundary, skipping the divider", async () => {
      setIndex(6)
      nav._setAnchor(3) // start on chron 3 (a D1 row); chron 4 is D2, across a divider
      await list.render()
      expect(await list.moveSelection("newer")).toBe(4)
   })

   it("marks rows unread strictly after the feed's seen high-water", async () => {
      setIndex(5)
      nav._setSeen({ "feed:1": 2 }) // 0,1,2 read · 3,4 unread
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

   it("a never-seen feed renders every row unread", async () => {
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

   const $end = () => container.querySelector(".srr-wire-end")

   it("caps the oldest end with the end-of-wire terminus once exhausted, not before", async () => {
      setIndex(65)
      await list.render()
      expect($end()).toBeNull() // first batch loaded, more below
      await list.loadMore()
      expect($end()).toBeNull()
      await list.loadMore() // reaches chron 0 → exhausted downward
      expect($end()).not.toBeNull()
      expect($end()!.querySelector(".srr-wire-end-rule")!.textContent).toBe("OLDEST")
      // Idempotent — a further no-op load doesn't add a second.
      await list.loadMore()
      expect(container.querySelectorAll(".srr-wire-end").length).toBe(1)
   })

   it("shows the terminus at render when the whole view fits one batch", async () => {
      setIndex(4)
      await list.render()
      expect($end()).not.toBeNull()
   })

   const $top = () => container.querySelector(".srr-wire-top")

   it("caps the newest end with the LATEST terminus once exhausted upward, not before", async () => {
      setIndex(65)
      nav._setAnchor(2) // open mid-feed: newer articles exist above
      await list.render()
      expect($top()).toBeNull() // the newer batch above isn't exhausted yet
      await list.loadNewer()
      expect($top()).toBeNull()
      await list.loadNewer() // pages up to chron 64 → exhausted upward
      expect($top()).not.toBeNull()
      expect($top()!.querySelector(".srr-wire-end-rule")!.textContent).toBe("LATEST")
      // Idempotent — a further no-op load doesn't add a second.
      await list.loadNewer()
      expect(container.querySelectorAll(".srr-wire-top").length).toBe(1)
   })

   it("shows the LATEST terminus at render when opened at the newest", async () => {
      setIndex(4) // default anchor -1 → opens at the newest end
      await list.render()
      expect($top()).not.toBeNull()
   })

   it("only includes feeds in the active filter", async () => {
      setIndex(6, (c) => (c % 2 === 0 ? 1 : 2)) // even=feed1, odd=feed2
      nav.filter.active = true
      nav.filter.feeds = new Map([[1, 0]])
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
      nav.filter.feeds = new Map([[99, 0]]) // no articles in feed 99
      await list.render()
      expect(container.querySelector(".srr-list-empty")).not.toBeNull()
   })

   it("names the filtered feed (not its raw id) in the no-articles message", async () => {
      setIndex(4, () => 1)
      nav.filter.active = true
      nav.filter.feeds = new Map([[99, 0]]) // an empty single-feed filter
      nav.getCurrentFilterKey.mockReturnValueOnce("99") // single untagged-feed filter: key is the id
      await list.render()
      const empty = container.querySelector(".srr-list-empty")
      expect(empty!.querySelector(".srr-empty-em")!.textContent).toBe("Feed99")
      expect(empty!.querySelector(".srr-empty-msg")!.textContent).toBe("Nothing in Feed99 yet.")
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
      nav.filter.feeds = new Map([[99, 0]]) // nothing matches → empty feed
      nav._setUnreadOnly(true)
      await list.render()
      const empty = container.querySelector(".srr-list-empty")
      expect(empty).not.toBeNull()
      // The reward state gets the accent checkmark the cold/absent states don't,
      // plus the shared "All caught up" eyebrow.
      expect(empty!.querySelector(".srr-caughtup-check")).not.toBeNull()
      expect(empty!.querySelector(".srr-empty-eyebrow")!.textContent).toBe("All caught up")
   })

   it("names the filtered feed (not its raw id) in the caught-up message", async () => {
      setIndex(4, () => 1)
      nav.filter.active = true
      nav.filter.feeds = new Map([[99, 0]]) // nothing matches → caught-up empty
      nav._setUnreadOnly(true)
      nav.getCurrentFilterKey.mockReturnValueOnce("99") // a single untagged-feed filter: key is the id
      await list.render()
      const empty = container.querySelector(".srr-list-empty")
      // The emphasized name is the feed's title (filterLabel resolves the id), not "99".
      expect(empty!.querySelector(".srr-empty-em")!.textContent).toBe("Feed99")
      expect(empty!.querySelector(".srr-empty-msg")!.textContent).toBe("Nothing unread in Feed99.")
   })

   it("renders the 'not started' message for a never-opened feed (distinct from caught-up)", () => {
      // The reader's not-started placeholder (a feed with unread you've never
      // opened): its own directed line, NOT the "All caught up" reward — the feed
      // HAS unread. Reachable only via emptyStateEl({notStarted}) (the reader path);
      // the list surface itself shows the unread rows and never this state.
      nav._setUnreadOnly(true)
      nav.getCurrentFilterKey.mockReturnValueOnce("99")
      const empty = list.emptyStateEl({ notStarted: true })
      expect(empty.querySelector(".srr-empty-eyebrow")!.textContent).toBe("Not started")
      expect(empty.querySelector(".srr-caughtup-check")).toBeNull() // not the reward state
      expect(empty.querySelector(".srr-empty-em")!.textContent).toBe("Feed99")
      expect(empty.querySelector(".srr-empty-msg")!.textContent).toContain("from the list")
   })

   it("shows 'Nothing saved' (not the caught-up reward) for an empty Saved view with unread-only on", () => {
      // unread-only is a global flag orthogonal to the saved peek mode and
      // defaults ON, so the reward branch must not shadow the saved empty state.
      data.db.total_art = 4
      nav.filter.saved = true
      nav._setUnreadOnly(true)
      const empty = list.emptyStateEl({})
      expect(empty.querySelector(".srr-empty-eyebrow")!.textContent).toBe("Nothing saved")
      expect(empty.querySelector(".srr-caughtup-check")).toBeNull() // not the reward state
   })

   it("refresh re-derives read/unread dots from the live seen map", async () => {
      setIndex(4)
      await list.render()
      expect($rows().every((a) => a.classList.contains("srr-row-unread"))).toBe(true)
      nav._setSeen({ "feed:1": 3 }) // now all read
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

   it("selects the filter's resolved article (the anchor) as the current row on a fresh filter", async () => {
      // No live reader article (pos -1); listAnchor resolved the filter to a
      // specific article — a feed/tag's oldest-unread position. Updating the filter
      // makes that article the selection, so the list highlights the same article
      // the reader would open under it.
      const current = () =>
         $rows()
            .filter((a) => a.classList.contains("srr-row-current"))
            .map((a) => Number(a.dataset.chron))
      setIndex(10, (c) => c) // feed id == chron, so getFeedId(3) === 3
      nav._setListAnchor(3)
      nav.select.mockClear()
      await list.render()
      expect(current()).toEqual([3]) // the resolved article is the highlighted row
      expect(nav.select).toHaveBeenCalledWith(3, 3) // pos + feed synced from the anchor
      expect(nav.currentChron()).toBe(3)
   })

   it("does not move the cursor when the anchor is already the current article (reader return)", async () => {
      setIndex(10)
      nav._setAnchor(5) // live reader article: anchor === pos === 5, so seed === pos
      nav.select.mockClear()
      await list.render()
      expect(nav.select).not.toHaveBeenCalled() // no redundant cursor move
   })

   it("leaves the newest-default view ([ALL]/saved/search) unselected so the first arrow establishes the cursor", async () => {
      // listAnchor returns -1 (newest) for [ALL]/saved/search; there's no specific
      // resolved article, so the list stays cursor-less — a fresh [ALL] boot shows
      // nothing selected, and the first arrow drops the cursor on the visible row.
      const current = () =>
         $rows()
            .filter((a) => a.classList.contains("srr-row-current"))
            .map((a) => Number(a.dataset.chron))
      setIndex(10) // default anchor -1, pos -1
      nav.select.mockClear()
      await list.render()
      expect(current()).toEqual([]) // nothing pre-selected
      expect(nav.select).not.toHaveBeenCalled()
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

   it("pins every row's intrinsic size so scrolling up doesn't jump", async () => {
      // Rows are content-visibility:auto with a 4rem placeholder, so an unpinned row
      // above the viewport would render at the placeholder and correct to its real
      // height only as you scroll into it — and with overflow-anchor:none that resize
      // jumps the viewport. Every insertion path (render + prepend) renders the new
      // rows once to measure, pins the measured height as contain-intrinsic-size,
      // then hands them back to the virtualizer, so no row ever corrects.
      setIndex(100)
      nav._setAnchor(50)
      await list.render() // window top is chron 80, with a newer batch above
      await list.loadNewer() // prepends 99..81 above
      const pinned = (row: HTMLElement): void => {
         // The temporary render-for-measurement override is handed back to the
         // .srr-row class's content-visibility:auto (no inline override left)...
         expect(row.style.getPropertyValue("content-visibility")).toBe("")
         // ...with the measured height pinned as the intrinsic-size placeholder.
         expect(row.style.getPropertyValue("contain-intrinsic-size")).toMatch(/^auto \d+px$/)
      }
      const prepended = $rows().filter((a) => Number(a.dataset.chron) > 80)
      expect(prepended.length).toBeGreaterThan(0)
      for (const row of prepended) pinned(row)
      // Initial-render rows are pinned the same way — the invariant holds at every
      // insertion path, not just the prepend.
      pinned($rows().find((a) => Number(a.dataset.chron) === 80)!)
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
      expect(nav.select).toHaveBeenLastCalledWith(4, 1) // pos + feed synced

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

   // A stub DOMRect for the scroll-positioning tests (jsdom reports zero rects).
   const rect = (top: number, bottom: number) =>
      ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

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
      setIndex(4) // newest-default ([ALL]) → nothing pre-selected (pos -1)
      await list.render()
      expect($current()).toEqual([])
      const landed = await list.moveSelection("newer")
      // The first key drops the cursor (no step); jsdom's zero-rect geometry
      // falls back to the oldest visible row. Exactly one row is now current.
      expect(landed).toBeGreaterThanOrEqual(0)
      expect($current()).toEqual([landed])
      expect(nav.select).toHaveBeenCalledWith(landed, expect.anything())
   })

   it("moveSelection returns -1 on an empty list (no rows rendered)", async () => {
      setIndex(0) // total_art 0 → emptyState, rowsEl never created
      await list.render()
      expect(await list.moveSelection("older")).toBe(-1)
      expect(await list.moveSelection("newer")).toBe(-1)
   })

   it("on a single-row list, the first press establishes the cursor and the next bumps the edge", async () => {
      setIndex(1)
      await list.render()
      expect($chrons()).toEqual([0])
      expect(await list.moveSelection("older")).toBe(0) // no cursor → establish on the only row
      expect($current()).toEqual([0])
      // Genuinely exhausted both ways → no neighbor → bump + no move.
      expect(await list.moveSelection("older")).toBe(-1)
      expect($rows()[0].classList.contains("srr-row-bump-down")).toBe(true)
   })

   it("stepping up to an off-screen row scrolls it clear of the sticky day divider", async () => {
      setIndex(10)
      nav._setAnchor(5) // reader's article → row 5 current; row 6 is its newer neighbor
      await list.render()
      expect($current()).toEqual([5])

      // Row 6 sits off-screen ABOVE the viewport. The day dividers are sticky at
      // top:0, so top-aligning to the viewport edge alone parks the row beneath the
      // divider — its top hidden. The scroll must reserve the divider's height too.
      const target = $rowFor(6)
      target.getBoundingClientRect = () => rect(-100, -50)
      document
         .querySelectorAll<HTMLElement>(".srr-day-divider")
         .forEach((d) => Object.defineProperty(d, "offsetHeight", { value: 30, configurable: true }))
      Object.defineProperty(window, "scrollY", { value: 200, configurable: true })

      const spy = window.scrollTo as unknown as ReturnType<typeof vi.fn>
      spy.mockClear()
      expect(await list.moveSelection("newer")).toBe(6)
      // scrollY 200 + rect.top -100 − (sticky 0 + divider 30) = 70: flush below the
      // divider, no top margin (a margin would expose the same-day row above as a
      // gap). Without reserving the divider it lands at 92, leaving the top hidden.
      expect(spy).toHaveBeenCalledWith(0, 70)

      Object.defineProperty(window, "scrollY", { value: 0, configurable: true })
   })

   it("snaps flush when the same-day row above is clipped by the pinned divider (no gap)", async () => {
      setIndex(10) // dayLabel = 2 chrons/day, so row 6 is the 2nd row of its day (row 7 above)
      nav._setAnchor(5)
      await list.render()

      // The target row 6 sits comfortably in-band (top 80, not behind the inset),
      // but its same-day neighbour row 7 above is clipped by the pinned divider
      // (top 20 < divider-bottom 30 < bottom 80) — its empty lower edge would show
      // as a gap. The fix snaps row 6 flush to the divider bottom instead.
      $rowFor(6).getBoundingClientRect = () => rect(80, 140)
      $rowFor(7).getBoundingClientRect = () => rect(20, 80) // straddles the divider bottom
      document
         .querySelectorAll<HTMLElement>(".srr-day-divider")
         .forEach((d) => Object.defineProperty(d, "offsetHeight", { value: 30, configurable: true }))
      Object.defineProperty(window, "scrollY", { value: 200, configurable: true })

      const spy = window.scrollTo as unknown as ReturnType<typeof vi.fn>
      spy.mockClear()
      expect(await list.moveSelection("newer")).toBe(6)
      // scrollY 200 + rect.top 80 − (sticky 0 + divider 30) = 250 → row top lands at
      // 30 (flush), hiding the clipped row above. Old behavior left it at 80 (gap).
      expect(spy).toHaveBeenCalledWith(0, 250)

      Object.defineProperty(window, "scrollY", { value: 0, configurable: true })
   })

   it("stepping down parks the row flush above the toolbar (no bottom gap)", async () => {
      setIndex(10)
      nav._setAnchor(5) // row 5 current; older neighbour (row 4) is the step-down target
      await list.render()

      // Row 4 is below the live band (bottom 900 > innerHeight 768). It must land
      // flush against the toolbar inset (no toolbar in jsdom → bottom = 768), not
      // 8px above it — symmetric with the flush top, so going down leaves no gap.
      $rowFor(4).getBoundingClientRect = () => rect(840, 900)
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true })

      const spy = window.scrollTo as unknown as ReturnType<typeof vi.fn>
      spy.mockClear()
      expect(await list.moveSelection("older")).toBe(4)
      // scrollY 0 + rect.bottom 900 − bottom 768 = 132 → row bottom lands at 768
      // (flush). With the old +8 margin it parked at 140, leaving an 8px gap.
      expect(spy).toHaveBeenCalledWith(0, 132)
   })

   // ── Roving tabindex ────────────────────────────────────────────────────────
   // Tab lands on the cursor only, not every article: exactly one row sits in the
   // Tab order (tabindex 0) — the selected row, or the first row when none is.
   const $tabbable = () =>
      $rows()
         .filter((a) => a.tabIndex === 0)
         .map((a) => Number(a.dataset.chron))

   it("keeps only the selected row in the Tab order", async () => {
      setIndex(10)
      nav._setAnchor(5) // reader's article → row 5 is the selection
      await list.render()
      expect($tabbable()).toEqual([5]) // exactly one Tab stop, on the cursor
      expect($rows().every((a) => a.tabIndex === (Number(a.dataset.chron) === 5 ? 0 : -1))).toBe(true)
   })

   it("with no selection, the first row is the lone Tab stop", async () => {
      setIndex(4) // newest-default ([ALL]) → nothing pre-selected (pos -1)
      await list.render()
      expect($current()).toEqual([]) // no cursor…
      expect($tabbable()).toEqual([3]) // …so the first (newest) row is reachable by Tab
   })

   it("the Tab stop follows the cursor as moveSelection steps", async () => {
      setIndex(10)
      nav._setAnchor(5)
      await list.render()
      expect($tabbable()).toEqual([5])
      await list.moveSelection("older")
      expect($tabbable()).toEqual([4]) // moved with the highlight
      await list.moveSelection("newer")
      expect($tabbable()).toEqual([5])
   })

   it("re-establishes the Tab stop when un-saving removes the row that held it", async () => {
      setIndex(6)
      nav._setSaved([0, 2, 4])
      nav.filter.saved = true
      await list.render()
      expect($tabbable()).toEqual([4]) // newest saved row is the lone Tab stop (no cursor)
      tapStar(4) // un-save the row holding the Tab stop
      expect($chrons()).toEqual([2, 0])
      expect($tabbable()).toEqual([2]) // a remaining row must re-take the Tab order
   })

   // ── Anchor re-seed + divider integrity ─────────────────────────────────────
   it("re-seeds to the newest match when the anchor lies below the filter's oldest article", async () => {
      // 0,1 = ch2 (excluded); 2,3 = ch1. Anchor at 0 (a ch2 row): feedLeft(0)
      // under the ch1 filter is -1, so render re-seeds to the newest ch1 (3) and
      // opens newest-first there instead of anchoring on the non-matching row.
      setIndex(4, (c) => (c < 2 ? 2 : 1))
      nav.filter.feeds = new Map([[1, 0]])
      nav.filter.active = true
      nav._setPos(-1)
      nav._setListAnchor(0)
      await list.render()
      expect($chrons()).toEqual([3, 2]) // ch1 only, newest-first; never anchored on ch2's 0/1
   })

   it("re-labels day dividers when un-saving removes the last row of a day stratum", async () => {
      // dayLabel buckets 2 chrons/day: saved [0,2,4] → rows 4(D2), 2(D1), 0(D0),
      // one per day → three dividers. Un-saving 2 must drop its orphaned D1.
      setIndex(6)
      nav._setSaved([0, 2, 4])
      nav.filter.saved = true
      await list.render()
      const labels = () => Array.from(document.querySelectorAll(".srr-day-divider")).map((d) => d.textContent)
      expect(labels()).toEqual(["D2", "D1", "D0"])
      tapStar(2)
      expect($chrons()).toEqual([4, 0])
      expect(labels()).toEqual(["D2", "D0"]) // D1 dropped with its only row
   })

   // ── Bug #1+#11 — refresh() saved-view empty state + orphaned dividers ────────
   // dayLabel buckets 2 chrons/day.  saved=[0,2,4] → three rows, one per day →
   // three dividers D0/D1/D2.  refresh() after removing all three must:
   //   (#1)  show the "Nothing saved" empty state even though rowsEl still holds
   //         non-row children (day dividers, terminus blocks)
   //   (#11) call relabelDividers so every orphaned .srr-day-divider is gone
   it("refresh() shows empty state and drops orphaned dividers when all saved rows are removed", async () => {
      setIndex(6)
      nav._setSaved([0, 2, 4])
      nav.filter.saved = true
      await list.render()
      const labels = () => Array.from(document.querySelectorAll(".srr-day-divider")).map((d) => d.textContent)
      expect(labels()).toEqual(["D2", "D1", "D0"])

      // Un-save all three articles (simulating reader action) then call refresh()
      nav._setSaved([])
      list.refresh()

      // #1: empty state must appear (previously skipped because childElementCount > 0)
      expect(container.querySelector(".srr-list-empty")).not.toBeNull()
      // #11: no orphaned day dividers left
      expect(document.querySelectorAll(".srr-day-divider").length).toBe(0)
   })

   // ── Bug #4 — fetchOlder TypeError when rowsEl nulled mid-fetch ───────────────
   // Saved view with >=BATCH+1 articles so a second page is needed.  While
   // loadMeta is in flight, un-save the last visible row → showEmptyState() sets
   // rowsEl=null.  The re-check after loadMeta must also guard rowsEl or
   // rowsEl.appendChild throws.
   it("fetchOlder does not throw when rowsEl is nulled mid-loadMeta (saved view)", async () => {
      // 35 saved articles triggers a second page load (BATCH=30)
      const n = 35
      setIndex(n)
      const chronList = Array.from({ length: n }, (_, i) => i)
      nav._setSaved(chronList)
      nav.filter.saved = true
      await list.render() // lays the first 30 rows

      // Gate the next loadMeta batch so we can null rowsEl in flight
      let releaseLoadMeta: (() => void) | null = null
      const gate = new Promise<void>((r) => (releaseLoadMeta = () => r()))
      data.loadMeta.mockImplementation(async (chron: number) => {
         await gate
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })

      // Start paging; don't await yet
      const paging = list.loadMore()

      // While loadMeta is gated: un-save every visible row → showEmptyState → rowsEl=null
      nav._setSaved([])
      list.refresh()
      expect(container.querySelector(".srr-list-empty")).not.toBeNull()

      // Release the gated batch and let fetchOlder finish — must NOT throw
      releaseLoadMeta!()
      await expect(paging).resolves.not.toThrow()

      // Restore default loadMeta
      data.loadMeta.mockImplementation(async (chron: number) => {
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
   })

   // ── Bug #10 — NaN feedId from a skeleton row in selectRow ────────────────────
   // selectRow on a skeleton (no dataset.feed) must NOT call nav.select with NaN.
   // Once fillRow stamps dataset.feed, if the row holds .srr-row-current nav.select
   // must be called with the correct (chron, feed) to sync nav state.
   it("selectRow on a skeleton does not call nav.select with NaN; re-selects once fillRow runs", async () => {
      setIndex(3)
      // Gate loadMeta so skeletons remain when we call moveSelection
      let releaseLoadMeta: (() => void) | null = null
      const gate = new Promise<void>((r) => (releaseLoadMeta = () => r()))
      data.loadMeta.mockImplementation(async (chron: number) => {
         await gate
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })

      const p = list.render()
      // Flush microtasks so skeletons are in DOM but fills are gated
      await new Promise((r) => setTimeout(r, 0))
      expect($rows().every((r) => r.classList.contains("srr-row-skeleton"))).toBe(true)

      // Move selection while rows are still skeletons
      nav.select.mockClear()
      await list.moveSelection("older") // establishes cursor on first visible row (skeleton)

      // nav.select must NOT have been called with NaN as the feed arg
      const nanCall = nav.select.mock.calls.find((args) => isNaN(args[1]))
      expect(nanCall).toBeUndefined()

      // Once the fills land, the current row's nav.select should be called
      nav.select.mockClear()
      releaseLoadMeta!()
      await p

      // nav.select should be called for the currently-highlighted row with a real feed id
      const selectCalls = nav.select.mock.calls
      const currentRow = $rows().find((r) => r.classList.contains("srr-row-current"))
      expect(currentRow).not.toBeUndefined()
      const chron = Number(currentRow!.dataset.chron)
      const feed = Number(currentRow!.dataset.feed)
      expect(isNaN(feed)).toBe(false)
      const reSelect = selectCalls.find((args) => args[0] === chron && args[1] === feed)
      expect(reSelect).not.toBeUndefined()

      data.loadMeta.mockImplementation(async (c: number) => {
         const a = data._arts.get(c)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
   })

   // ── Bug #10 follow-up — stale skeleton re-select after cursor move ────────
   // refresh() can run between selectRow (skeleton window) and fillRow, moving
   // .srr-row-current to a different row.  fillRow must clear selectPending but
   // must NOT call nav.select with the stale (skeleton chron, skeleton feed).
   it("fillRow does not re-select a skeleton that is no longer .srr-row-current", async () => {
      setIndex(3)
      // Gate loadMeta so skeletons remain after render()
      let releaseLoadMeta: (() => void) | null = null
      const gate = new Promise<void>((r) => (releaseLoadMeta = () => r()))
      data.loadMeta.mockImplementation(async (chron: number) => {
         await gate
         const a = data._arts.get(chron)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })

      const p = list.render()
      // Flush microtasks so skeletons are in DOM but fills are gated
      await new Promise((r) => setTimeout(r, 0))
      expect($rows().every((r) => r.classList.contains("srr-row-skeleton"))).toBe(true)

      // Establish cursor on chron=2 (newest) skeleton
      nav.select.mockClear()
      await list.moveSelection("older")
      const skeletonRow = $rows().find((r) => r.classList.contains("srr-row-current"))
      expect(skeletonRow).not.toBeUndefined()
      const skeletonChron = Number(skeletonRow!.dataset.chron)
      expect(skeletonRow!.dataset.selectPending).toBe("1")

      // Simulate refresh() moving the cursor to a DIFFERENT chron (e.g. the reader
      // navigated away while the skeleton was pending) — pick a row that is NOT
      // the skeleton we just selected.
      const otherChron = $chrons().find((c) => c !== skeletonChron)!
      nav._setPos(otherChron)
      list.refresh()

      // The skeleton row must no longer carry .srr-row-current after refresh()
      expect(skeletonRow!.classList.contains("srr-row-current")).toBe(false)
      // But it still has selectPending (refresh() does not clear it)
      expect(skeletonRow!.dataset.selectPending).toBe("1")

      // Now release fills and wait for render to settle
      nav.select.mockClear()
      releaseLoadMeta!()
      await p

      // nav.select must NOT have been called with the stale skeleton's chron
      const staleCall = nav.select.mock.calls.find((args) => args[0] === skeletonChron)
      expect(staleCall).toBeUndefined()

      data.loadMeta.mockImplementation(async (c: number) => {
         const a = data._arts.get(c)!
         return { f: a.f, w: a.p || a.a, t: a.t }
      })
   })

   // ── onStoreGrown — silent top-reopen after a store refresh ───────────────
   // A grown store (data.refresh + nav.onStoreRefreshed, both merged) must NOT
   // rebuild or move the viewport: the top merely reopens (terminus off, sentinel
   // kicked live again) so newer rows arrive through the existing prepend +
   // scroll-compensation machinery — invisibly above the fold when parked at the
   // top, on the next upward scroll otherwise. Exception: an empty state
   // (nothing on screen to disturb) rebuilds instead.
   describe("onStoreGrown", () => {
      it("reopens an exhausted top when a newer match exists (terminus off, no rebuild)", async () => {
         setIndex(3) // chrons 0..2, anchored at newest → exhaustedTop, LATEST terminus
         await list.render()
         expect($top()).not.toBeNull()
         const rowsBefore = $rows().length

         // Grow the store: article 3 lands above the current window.
         data._arts.set(3, art({ f: 1, t: "title 3", a: 3 }))
         data.db.total_art = 4

         await list.onStoreGrown()
         expect($top()).toBeNull() // reopened
         expect($rows().length).toBe(rowsBefore) // no prepend — fully silent
         // The top is genuinely live again (exhaustedTop cleared, not just the
         // terminus DOM): an explicit page-in prepends the new article and
         // re-exhausts at the new newest end.
         await list.loadNewer()
         expect($chrons()[0]).toBe(3)
         expect($top()).not.toBeNull()
      })

      it("keeps the terminus when the refresh brought nothing for this filter", async () => {
         setIndex(3)
         await list.render()
         expect($top()).not.toBeNull()
         await list.onStoreGrown() // no growth: the probe finds nothing newer
         expect($top()).not.toBeNull() // terminus untouched, no flicker
      })

      it("rebuilds when the list shows an empty state", async () => {
         setIndex(0)
         await list.render()
         expect(container.querySelector(".srr-list-empty")).not.toBeNull()

         data._arts.set(0, art({ f: 1, t: "title 0", a: 0 }))
         data.db.total_art = 1

         await list.onStoreGrown()
         expect($rows().length).toBeGreaterThan(0)
         expect(container.querySelector(".srr-list-empty")).toBeNull()
      })

      it("a stale probe bails on the token guard when a rerender supersedes it mid-flight", async () => {
         // Same discipline as "a superseding render aborts the gated one": gate
         // the reopen probe, rebuild while it's pending, then release it — the
         // stale onStoreGrown must not reopen the NEW render's top.
         setIndex(3)
         await list.render()
         data._arts.set(3, art({ f: 1, t: "title 3", a: 3 }))
         data.db.total_art = 4

         let release: (() => void) | null = null
         const gate = new Promise<void>((r) => (release = () => r()))
         nav.feedRight.mockImplementationOnce(async (from: number) => {
            await gate
            return data.findRight(from)
         })

         const p = list.onStoreGrown() // probe dispatched, gated
         await list.rerender() // supersede: fresh token, rows [3..0], terminus present
         expect($chrons()).toEqual([3, 2, 1, 0])
         expect($top()).not.toBeNull()
         release!()
         await p
         // The stale probe found a match but bailed on the token guard: the new
         // render's terminus stays, exactly once.
         expect(container.querySelectorAll(".srr-wire-top").length).toBe(1)
      })

      it("kicks the top-sentinel observer on reopen so a user parked at the top still pages", async () => {
         // IntersectionObserver only fires on intersection CHANGES, and the usual
         // exhaustedTop position is parked at scroll 0 with the top sentinel
         // ALREADY intersecting — removing the terminus alone would never resume
         // paging there. The reopen must unobserve+re-observe the top sentinel,
         // which re-delivers its CURRENT intersection state.
         const calls: { op: string; el: Element }[] = []
         class FakeIO {
            observe(el: Element): void {
               calls.push({ op: "observe", el })
            }
            unobserve(el: Element): void {
               calls.push({ op: "unobserve", el })
            }
            disconnect(): void {
               // teardownObserver calls this on rebuild; nothing to record
            }
         }
         vi.stubGlobal("IntersectionObserver", FakeIO)
         try {
            setIndex(3)
            await list.render()
            // render lays [topSentinel, rows, bottomSentinel] into the container.
            const sentinel = container.firstElementChild!
            expect(sentinel.className).toBe("srr-list-sentinel")
            calls.length = 0

            data._arts.set(3, art({ f: 1, t: "title 3", a: 3 }))
            data.db.total_art = 4
            await list.onStoreGrown()
            expect(calls).toEqual([
               { op: "unobserve", el: sentinel },
               { op: "observe", el: sentinel },
            ])
         } finally {
            vi.unstubAllGlobals()
         }
      })
   })
})
