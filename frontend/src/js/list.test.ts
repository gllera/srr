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
      searchMore: vi.fn(async () => ({ hits: [] as { chron: number; f: number; w: number; t: string }[], done: true })),
      searchQuery: vi.fn(() => searchTerm),
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
      // Restore the default (empty) search stream so a per-test mockImplementation
      // can't leak into the next test.
      nav.searchMore.mockImplementation(async () => ({ hits: [], done: true }))
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

   it("streams search matches into the list as they are found", async () => {
      // 3 matches, newest-first 9,5,1; one per searchMore batch.
      const batches = [
         [{ chron: 9, f: 1, w: 1700000009, t: "alpha nine" }],
         [{ chron: 5, f: 1, w: 1700000005, t: "alpha five" }],
         [{ chron: 1, f: 1, w: 1700000001, t: "alpha one" }],
      ]
      let i = 0
      nav.filter.search = true // isSearchFilter() reads filter.search
      nav.searchMore.mockImplementation(async () => {
         if (i >= batches.length) return { hits: [], done: true }
         const hits = batches[i++]
         return { hits, done: i >= batches.length }
      })
      data.db.total_art = 10

      await list.render()
      const rows = $rows()
      expect(rows.map((r) => r.querySelector(".srr-row-title")!.textContent)).toEqual([
         "alpha nine",
         "alpha five",
         "alpha one",
      ])
      // Search rows are born complete — no skeletons.
      expect(rows.some((r) => r.classList.contains("srr-row-skeleton"))).toBe(false)
      // OLDEST terminus once the stream is done.
      expect(container.querySelector(".srr-wire-end")).not.toBeNull()
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
})
