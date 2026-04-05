import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const data = vi.hoisted(() => ({
   PACK_SIZE: 1000 as const,
   db: {
      total_art: 3,
      data_tog: true,
      ts_tog: true,
      fetched_at: 0,
      first_fetched: 0,
      sub_seq: 0,
      next_pid: 1,
      pack_off: 0,
      subscriptions: [] as ISub[],
      subs_mapped: new Map<number, ISub>(),
   } as unknown as IDB,
   articles: [] as IIdxEntry[],
   idxPack: -1,
   init: vi.fn(),
   loadIdxPack: vi.fn(),
   getContent: vi.fn(),
   makeLRU() {
      const map = new Map()
      return {
         get(id: number) {
            const entry = map.get(id)
            if (entry) {
               map.delete(id)
               map.set(id, entry)
            }
            return entry
         },
         put(id: number, val: unknown) {
            map.delete(id)
            map.set(id, val)
         },
      }
   },
   streamSplit: vi.fn(),
   numFinalizedIdx(): number {
      return this.db.total_art > 0 ? Math.floor((this.db.total_art - 1) / 1000) : 0
   },
   latestIdxCount(): number {
      return this.db.total_art - this.numFinalizedIdx() * 1000
   },
   peekIdxPack(pack: number): IIdxEntry[] | undefined {
      return pack === this.idxPack ? this.articles : undefined
   },
   peekIdxEntry(chronIdx: number): IIdxEntry | undefined {
      const nf = this.numFinalizedIdx()
      const pack = Math.min(Math.floor(chronIdx / 1000), nf)
      const entries = this.peekIdxPack(pack)
      if (!entries) return undefined
      const pos = pack < nf ? chronIdx - pack * 1000 : chronIdx - nf * 1000
      return pos >= 0 && pos < entries.length ? entries[pos] : undefined
   },
   activeSubs(): ISub[] {
      return Array.from(this.db.subs_mapped.values())
         .filter((sub: ISub) => (sub.total_art ?? 0) > 0)
         .sort((a: ISub, b: ISub) => (a.title < b.title ? -1 : 1))
   },
}))

vi.mock("./data", () => data)

const tsMock = vi.hoisted(() => ({
   findCandidateIdxPacks: vi.fn().mockResolvedValue(null),
   findChronForTimestamp: vi.fn().mockResolvedValue(null),
   filteredCountBefore: vi.fn().mockResolvedValue({ count: 0, total: 0 }),
}))

vi.mock("./ts", () => tsMock)

import * as nav from "./nav"

function makeEntry(overrides: Partial<IIdxEntry> = {}): IIdxEntry {
   return { fetched_at: 0, pack_id: 1, pack_offset: 0, sub_id: 1, published: 0, title: "Test", link: "", ...overrides }
}

function makeSub(overrides: Partial<ISub> = {}): ISub {
   return { id: 1, title: "Sub1", url: "", ...overrides }
}

// Replace articles in data.articles from an array (used by mockIdxLoad helpers)
function setArticles(entries: IIdxEntry[]) {
   data.articles.length = 0
   data.articles.push(...entries)
}

function mockIdxLoad(entries: IIdxEntry[]) {
   data.loadIdxPack.mockImplementation(async (pack: number) => {
      data.idxPack = pack
      setArticles(entries)
   })
}

function mockIdxLoadOnce(entries: IIdxEntry[]) {
   data.loadIdxPack.mockImplementationOnce(async (pack: number) => {
      data.idxPack = pack
      setArticles(entries)
   })
}

beforeEach(() => {
   vi.useFakeTimers()
   data.idxPack = -1
   data.db.total_art = 3
   data.db.data_tog = true
   data.db.subscriptions = []
   data.db.subs_mapped = new Map()
   data.articles.length = 0
   data.loadIdxPack.mockImplementation(async (pack: number) => {
      data.idxPack = pack
   })
   tsMock.findCandidateIdxPacks.mockResolvedValue(null)
   nav.setFilterSubs(undefined)
   nav.setFloorChron(0)
})

afterEach(() => {
   vi.useRealTimers()
})

describe("load", () => {
   it("clamps position to last article when out of bounds", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      const result = await nav.load(999)
      expect(result.article.title).toBe("C")
   })

   it("loads the specified position", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      const result = await nav.load(1)
      expect(result.article.title).toBe("B")
   })

   it("clamps chronIdx to total_art-1 when out of bounds", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      const result = await nav.load(999)
      // With total_art=3, chronIdx clamped to 2, pack 0, pos 2
      // But only 1 article loaded, so pos clamped to 0
      expect(result.article.title).toBe("A")
   })

   it("handles negative chronIdx by clamping to last", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      const result = await nav.load(-5)
      expect(result.article.title).toBe("B")
   })

   it("uses pushState by default", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.articles.push(makeEntry())
      await nav.load(0)
      vi.runAllTimers()
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#0")
      pushSpy.mockRestore()
   })

   it("loads position 0 correctly", async () => {
      data.articles.push(makeEntry({ title: "First" }), makeEntry({ title: "Second" }))
      const result = await nav.load(0)
      expect(result.article.title).toBe("First")
   })

   it("throws when total_art is 0", async () => {
      data.db.total_art = 0
      await expect(nav.load(0)).rejects.toThrow("no articles")
   })

   it("handles single article", async () => {
      data.db.total_art = 1
      data.articles.push(makeEntry({ title: "Only" }))
      const result = await nav.load(0)
      expect(result.article.title).toBe("Only")
   })
})

describe("left", () => {
   it("moves to previous article within pack", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      await nav.load(1)
      const result = await nav.left()
      expect(result.article.title).toBe("A")
   })

   it("loads previous pack at boundary", async () => {
      // 2 finalized packs (1000 each) + 3 in latest
      data.db.total_art = 2003
      data.articles.push(makeEntry({ title: "Latest-A" }))
      data.idxPack = -1
      await nav.load(2000) // latest pack, pos 0

      mockIdxLoad([makeEntry({ title: "Pack2-A" }), makeEntry({ title: "Pack2-B" })])

      const result = await nav.left()
      expect(result.article.title).toBe("Pack2-B")
      expect(data.loadIdxPack).toHaveBeenCalledWith(1)
   })

   it("stays at start when at first pack first article", async () => {
      // All in latest pack, at position 0
      data.articles.push(makeEntry({ title: "First" }))
      await nav.load(0)

      data.loadIdxPack.mockClear()

      const result = await nav.left()
      expect(result.article.title).toBe("First")
   })

   it("stays put in filter mode when no matching entry exists", async () => {
      data.articles.push(makeEntry({ sub_id: 2, title: "Other" }), makeEntry({ sub_id: 1, title: "Only" }))
      await nav.fromHash("1!1")

      data.loadIdxPack.mockClear()

      const result = await nav.left()
      expect(result.article.title).toBe("Only")
   })

   it("decrements chronIdx by 1 in normal mode", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      await nav.load(2)
      const r1 = await nav.left()
      expect(r1.article.title).toBe("B")
      const r2 = await nav.left()
      expect(r2.article.title).toBe("A")
   })

   it("crosses pack boundaries in normal mode", async () => {
      data.db.total_art = 2003
      // Start at latest pack (chronIdx 2000)
      data.articles.push(makeEntry({ title: "Latest-A" }))
      data.idxPack = -1
      await nav.load(2000)

      mockIdxLoadOnce([makeEntry({ title: "Pack2-A" }), makeEntry({ title: "Pack2-B" })])
      const r1 = await nav.left()
      expect(r1.article.title).toBe("Pack2-B")
      expect(data.loadIdxPack).toHaveBeenCalledWith(1)

      const r2 = await nav.left()
      expect(r2.article.title).toBe("Pack2-A")

      mockIdxLoadOnce([makeEntry({ title: "Pack1-A" })])
      const r3 = await nav.left()
      expect(r3.article.title).toBe("Pack1-A")
      expect(data.loadIdxPack).toHaveBeenCalledWith(0)
   })

   it("filter mode skips non-matching entries in same pack", async () => {
      data.articles.push(
         makeEntry({ sub_id: 1, title: "S1-A" }),
         makeEntry({ sub_id: 2, title: "S2-A" }),
         makeEntry({ sub_id: 3, title: "S3-A" }),
         makeEntry({ sub_id: 1, title: "S1-B" }),
      )
      data.db.total_art = 4
      await nav.fromHash("3!1")
      const result = await nav.left()
      expect(result.article.title).toBe("S1-A")
   })

   it("filter mode cross-pack scans backward", async () => {
      data.db.total_art = 2003
      // Start in latest pack
      data.articles.push(makeEntry({ sub_id: 1, title: "Latest-Feed" }))
      data.idxPack = -1
      await nav.fromHash("2000!1")

      mockIdxLoadOnce([
         makeEntry({ sub_id: 2, title: "Other" }),
         makeEntry({ sub_id: 1, title: "Pack2-Target" }),
         makeEntry({ sub_id: 2, title: "Other2" }),
      ])

      const result = await nav.left()
      expect(result.article.title).toBe("Pack2-Target")
   })

   it("filter mode stays put when no match in any pack", async () => {
      data.db.total_art = 2001
      data.articles.push(makeEntry({ sub_id: 1, title: "Latest-Only" }))
      data.idxPack = -1
      await nav.fromHash("2000!1")

      // Pack 2 has no matching sub
      mockIdxLoadOnce([makeEntry({ sub_id: 2, title: "Wrong-Sub" })])
      // Pack 1 also has no matching sub
      mockIdxLoadOnce([makeEntry({ sub_id: 3, title: "Wrong-Sub2" })])
      // Restoration: reload original pack (simulates cache hit)
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "Latest-Only" })])

      const result = await nav.left()
      expect(result.article.title).toBe("Latest-Only")
      expect(result.article.sub_id).toBe(1)
   })

   it("finds last matching entry searching backward", async () => {
      data.db.total_art = 4
      data.articles.push(
         makeEntry({ sub_id: 1, title: "First" }),
         makeEntry({ sub_id: 1, title: "Second" }),
         makeEntry({ sub_id: 2, title: "Other" }),
         makeEntry({ sub_id: 1, title: "Third" }),
      )
      await nav.fromHash("3!1")
      const result = await nav.left()
      expect(result.article.title).toBe("Second")
   })

   it("returns first matching entry when it is at index 0", async () => {
      data.db.total_art = 4
      data.articles.push(
         makeEntry({ sub_id: 1, title: "Target" }),
         makeEntry({ sub_id: 2, title: "Other1" }),
         makeEntry({ sub_id: 2, title: "Other2" }),
         makeEntry({ sub_id: 1, title: "Current" }),
      )
      await nav.fromHash("3!1")
      const r1 = await nav.left()
      expect(r1.article.title).toBe("Target")
      expect(r1.has_left).toBe(false)
   })
})

describe("right", () => {
   it("moves to next article within pack", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      await nav.load(0)
      const result = await nav.right()
      expect(result.article.title).toBe("B")
   })

   it("stays at end when at last article", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      await nav.load(2)

      data.loadIdxPack.mockClear()

      const result = await nav.right()
      expect(result.article.title).toBe("C")
   })

   it("increments chronIdx by 1 in normal mode", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      await nav.load(0)
      const r1 = await nav.right()
      expect(r1.article.title).toBe("B")
      const r2 = await nav.right()
      expect(r2.article.title).toBe("C")
   })

   it("crosses pack boundaries in normal mode", async () => {
      data.db.total_art = 2003
      // Start at pack 1, pos 999
      mockIdxLoadOnce([makeEntry({ title: "Pack1-Last" })])
      await nav.load(999)

      mockIdxLoadOnce([makeEntry({ title: "Pack2-A" }), makeEntry({ title: "Pack2-B" })])
      const r1 = await nav.right()
      expect(r1.article.title).toBe("Pack2-A")
      expect(data.loadIdxPack).toHaveBeenCalledWith(1)

      const r2 = await nav.right()
      expect(r2.article.title).toBe("Pack2-B")
   })

   it("crosses from last finalized to latest pack", async () => {
      data.db.total_art = 2003
      // Start at pack 1, last position
      mockIdxLoadOnce([makeEntry({ title: "Pack2-Last" })])
      await nav.load(1999)

      mockIdxLoadOnce([makeEntry({ title: "Latest-A" }), makeEntry({ title: "Latest-B" })])
      const result = await nav.right()
      expect(result.article.title).toBe("Latest-A")
      expect(data.loadIdxPack).toHaveBeenCalledWith(2)
   })

   it("crosses pack 0 to pack 1 to latest", async () => {
      data.db.total_art = 2003
      // Start at end of pack 0
      mockIdxLoadOnce([makeEntry({ title: "Pack1-Last" })])
      await nav.load(999)

      mockIdxLoadOnce([makeEntry({ title: "Pack2-Only" })])
      const r1 = await nav.right()
      expect(r1.article.title).toBe("Pack2-Only")

      mockIdxLoadOnce([makeEntry({ title: "Latest-A" })])
      const r2 = await nav.right()
      expect(r2.article.title).toBe("Latest-A")
      expect(data.loadIdxPack).toHaveBeenCalledWith(2)
   })

   it("filter mode skips non-matching entries in same pack", async () => {
      data.db.total_art = 4
      data.articles.push(
         makeEntry({ sub_id: 1, title: "S1-A" }),
         makeEntry({ sub_id: 2, title: "S2-A" }),
         makeEntry({ sub_id: 3, title: "S3-A" }),
         makeEntry({ sub_id: 1, title: "S1-B" }),
      )
      await nav.fromHash("0!1")
      const result = await nav.right()
      expect(result.article.title).toBe("S1-B")
   })

   it("filter mode cross-pack scans forward", async () => {
      data.db.total_art = 2003
      // Start in pack 1
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "Pack1-Feed" })])
      await nav.fromHash("0!1")

      // Pack 2 has a matching entry
      mockIdxLoadOnce([
         makeEntry({ sub_id: 2, title: "Other" }),
         makeEntry({ sub_id: 1, title: "Pack2-Target" }),
         makeEntry({ sub_id: 2, title: "Other2" }),
      ])

      const result = await nav.right()
      expect(result.article.title).toBe("Pack2-Target")
   })

   it("filter mode stays put when no match in any pack", async () => {
      data.db.total_art = 2001
      // Start in pack 1
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "Pack1-Only" }), makeEntry({ sub_id: 2, title: "Pack1-Other" })])
      await nav.fromHash("0!1")

      // Pack 2 has no matching sub
      mockIdxLoadOnce([makeEntry({ sub_id: 2, title: "Wrong-Sub" })])
      // Latest pack has no matching sub
      mockIdxLoadOnce([makeEntry({ sub_id: 3, title: "Wrong-Sub2" })])
      // Restoration: reload original pack
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "Pack1-Only" }), makeEntry({ sub_id: 2, title: "Pack1-Other" })])

      const result = await nav.right()
      expect(result.article.title).toBe("Pack1-Only")
      expect(result.article.sub_id).toBe(1)
   })

   it("filter mode skips pack with no matches and finds in later pack", async () => {
      data.db.total_art = 3001
      // Start in pack 1
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "Pack1-Feed" })])
      await nav.fromHash("0!1")

      // Pack 2 has no match
      mockIdxLoadOnce([makeEntry({ sub_id: 2, title: "Pack2-Other" })])
      // Pack 3 has no match
      mockIdxLoadOnce([makeEntry({ sub_id: 3, title: "Pack3-Other" })])
      // Latest pack has match
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "Latest-Target" })])

      const result = await nav.right()
      expect(result.article.title).toBe("Latest-Target")
   })

   it("updates hash after right navigation", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      await nav.load(0)
      pushSpy.mockClear()
      await nav.right()
      vi.runAllTimers()
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#1")
      pushSpy.mockRestore()
   })

   it("multi-sub filter matches any sub in filter set going right", async () => {
      data.db.total_art = 4
      data.articles.push(
         makeEntry({ sub_id: 1, title: "S1" }),
         makeEntry({ sub_id: 2, title: "S2" }),
         makeEntry({ sub_id: 3, title: "S3" }),
         makeEntry({ sub_id: 1, title: "S1-B" }),
      )
      await nav.fromHash("0!1+3")
      const r1 = await nav.right()
      expect(r1.article.title).toBe("S3")
      const r2 = await nav.right()
      expect(r2.article.title).toBe("S1-B")
   })
})

describe("toggleFilter", () => {
   it("toggles filter mode on and off", async () => {
      data.articles.push(makeEntry())
      await nav.load(0)

      let result = await nav.toggleFilter()
      expect(result.filtered).toBe(true)

      result = await nav.toggleFilter()
      expect(result.filtered).toBe(false)
   })

   it("updates hash with filter marker when toggled on", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.articles.push(makeEntry())
      await nav.load(0)
      pushSpy.mockClear()
      await nav.toggleFilter()
      vi.runAllTimers()
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#0!1")
      pushSpy.mockRestore()
   })

   it("updates hash without filter marker when toggled off", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.articles.push(makeEntry())
      await nav.load(0)
      await nav.toggleFilter()
      pushSpy.mockClear()
      await nav.toggleFilter()
      vi.runAllTimers()
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#0")
      pushSpy.mockRestore()
   })

   it("toggle on then off stays on same article", async () => {
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
      )
      await nav.load(2)
      await nav.toggleFilter()
      const result = await nav.toggleFilter()
      expect(result.filtered).toBe(false)
      expect(result.article.title).toBe("C")
   })

   it("returns correct article and sub after toggle", async () => {
      const sub = makeSub({ title: "MySub" })
      data.db.subs_mapped.set(1, sub)
      data.articles.push(makeEntry({ sub_id: 1 }))
      await nav.load(0)
      const result = await nav.toggleFilter()
      expect(result.article.sub_id).toBe(1)
      expect(result.sub).toBe(sub)
   })
})

describe("fromHash", () => {
   it("parses hash without filter", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      const result = await nav.fromHash("1")
      expect(result.article.title).toBe("B")
      expect(result.filtered).toBe(false)
   })

   it("parses hash with filter", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      const result = await nav.fromHash("1!1")
      expect(result.article.title).toBe("B")
      expect(result.filtered).toBe(true)
   })

   it("bare ! treated as no filter", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      const result = await nav.fromHash("1!")
      expect(result.article.title).toBe("B")
      expect(result.filtered).toBe(false)
   })

   it("parses multi-sub filter from hash", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      const result = await nav.fromHash("1!1+3")
      expect(result.filtered).toBe(true)
   })

   it("ignores unresolved tag tokens from hash", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      const result = await nav.fromHash("0!1+abc+3")
      expect(result.filtered).toBe(true)
   })

   it("handles empty hash gracefully", async () => {
      data.articles.push(makeEntry({ title: "Fallback" }))
      const result = await nav.fromHash("")
      expect(result.article.title).toBe("Fallback")
   })

   it("handles non-numeric hash values", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      const result = await nav.fromHash("abc")
      expect(result.article.title).toBe("A")
   })

   it.each(["0~-5", "0~abc"])("parses invalid floor %s as 0", async (hash) => {
      data.articles.push(makeEntry())
      const result = await nav.fromHash(hash)
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("parses hash with floor and filter combined", async () => {
      const replaceSpy = vi.spyOn(history, "replaceState")
      data.articles.push(makeEntry({ title: "A" }))
      const result = await nav.fromHash("0~2!1")
      expect(result.floor).toBe(true)
      expect(result.filtered).toBe(true)
      expect(nav.floorChron).toBe(2)
      vi.runAllTimers()
      expect(replaceSpy).toHaveBeenCalledWith(null, "", "#0~2!1")
      replaceSpy.mockRestore()
   })

   it("parses floor value correctly from tilde segment", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      await nav.fromHash("0~5")
      expect(nav.floorChron).toBe(5)
   })

   it("floor 0 from hash means no floor", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      const result = await nav.fromHash("0~0")
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("uses replaceState for hash updates", async () => {
      const replaceSpy = vi.spyOn(history, "replaceState")
      data.articles.push(makeEntry({ title: "A" }))
      await nav.fromHash("0")
      vi.runAllTimers()
      expect(replaceSpy).toHaveBeenCalled()
      replaceSpy.mockRestore()
   })
})

describe("last", () => {
   it("navigates to last article of specified subscription", async () => {
      data.db.subs_mapped.set(1, makeSub())
      data.articles.push(makeEntry({ title: "A" }))
      await nav.load(0)

      // Mock latest pack with target sub
      mockIdxLoad([
         makeEntry({ sub_id: 2, title: "Other" }),
         makeEntry({ sub_id: 1, title: "Target" }),
         makeEntry({ sub_id: 2, title: "Other2" }),
      ])

      const result = await nav.last("1")
      expect(result.article.title).toBe("Target")
      expect(result.filtered).toBe(true)
   })

   it("goes to latest article when subId not found in subs_mapped", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      await nav.load(0)

      mockIdxLoad([makeEntry({ title: "Latest" })])

      const result = await nav.last("999")
      expect(result.filtered).toBe(false)
   })

   it("uses current article subId when in filter mode and subId undefined", async () => {
      data.db.subs_mapped.set(1, makeSub())
      data.articles.push(makeEntry({ sub_id: 1, title: "A" }), makeEntry({ sub_id: 2, title: "B" }))
      data.db.total_art = 2
      await nav.fromHash("0!1")

      const result = await nav.last()
      expect(result.article.title).toBe("A")
      expect(result.filtered).toBe(true)
   })

   it("goes to latest article when subId undefined and not in filter mode", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      await nav.load(0)

      mockIdxLoad([makeEntry({ title: "Latest" })])

      const result = await nav.last()
      expect(result.filtered).toBe(false)
   })

   it("falls back to latest unfiltered when sub not found in any pack", async () => {
      data.db.subs_mapped.set(5, makeSub({ id: 5 }))
      data.articles.push(makeEntry({ title: "A" }))
      await nav.load(0)

      mockIdxLoad([makeEntry({ sub_id: 3, title: "X" }), makeEntry({ sub_id: 4, title: "Y" })])

      const result = await nav.last("5")
      expect(result.article.title).toBe("Y")
      expect(result.filtered).toBe(false)
   })

   it("last with empty string subId clears filter and goes to latest", async () => {
      data.articles.push(makeEntry({ title: "Current" }))
      await nav.load(0)

      mockIdxLoad([makeEntry({ title: "Latest-A" }), makeEntry({ title: "Latest-B" })])

      const result = await nav.last("")
      expect(result.filtered).toBe(false)
      expect(result.article.title).toBe("Latest-B")
   })

   it("last with NaN subId goes to latest unfiltered", async () => {
      data.articles.push(makeEntry({ title: "Current" }))
      await nav.load(0)

      mockIdxLoad([makeEntry({ title: "Latest" })])

      const result = await nav.last("abc")
      expect(result.filtered).toBe(false)
   })

   it("scans backward through finalized packs to find sub", async () => {
      data.db.total_art = 2001
      data.db.subs_mapped.set(1, makeSub())
      data.articles.push(makeEntry({ title: "Current" }))
      await nav.load(0)

      // Latest pack has no matching sub
      mockIdxLoadOnce([makeEntry({ sub_id: 2, title: "LatestOther" })])
      // Pack 2 has no matching sub
      mockIdxLoadOnce([makeEntry({ sub_id: 3, title: "Pack2Other" })])
      // Pack 1 has the target
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "Pack1-Target" }), makeEntry({ sub_id: 2, title: "Pack1-Other" })])

      const result = await nav.last("1")
      expect(result.article.title).toBe("Pack1-Target")
   })
})

describe("showFeed", () => {
   describe("has_left", () => {
      it("false when single article at chronIdx 0", async () => {
         data.db.total_art = 1
         data.articles.push(makeEntry())
         const result = await nav.load(0)
         expect(result.has_left).toBe(false)
      })

      it("true in filter mode with earlier in-pack entries of same sub", async () => {
         data.articles.push(makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 1 }))
         const result = await nav.fromHash("2!1")
         expect(result.has_left).toBe(true)
      })

      it("false in filter mode with no earlier same-sub entries and no prev pack", async () => {
         data.db.total_art = 2
         data.articles.push(makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 1 }))
         const result = await nav.fromHash("1!1")
         expect(result.has_left).toBe(false)
      })

      it("true in filter mode when earlier packs have matching articles", async () => {
         data.db.total_art = 1001
         data.articles.push(makeEntry({ sub_id: 1 }))
         data.idxPack = -1
         tsMock.filteredCountBefore.mockResolvedValueOnce({ count: 5, total: 1000 })
         const result = await nav.fromHash("1000!1")
         expect(result.has_left).toBe(true)
      })

      it("true in normal mode at chronIdx > 0", async () => {
         data.articles.push(makeEntry(), makeEntry())
         const result = await nav.load(1)
         expect(result.has_left).toBe(true)
      })

      it("true in normal mode at pos > 0 in single pack", async () => {
         data.db.total_art = 2
         data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
         const result = await nav.load(1)
         expect(result.has_left).toBe(true)
      })
   })

   describe("has_right", () => {
      it("false when single article at last chronIdx", async () => {
         data.db.total_art = 1
         data.articles.push(makeEntry())
         const result = await nav.load(0)
         expect(result.has_right).toBe(false)
      })

      it("true in normal mode when not at last article", async () => {
         data.articles.push(makeEntry(), makeEntry())
         const result = await nav.load(0)
         expect(result.has_right).toBe(true)
      })

      it("false in normal mode at last article", async () => {
         data.articles.push(makeEntry(), makeEntry(), makeEntry())
         const result = await nav.load(2)
         expect(result.has_right).toBe(false)
      })

      it("true in filter mode with later in-pack entries of same sub", async () => {
         data.db.subscriptions = [makeSub({ id: 1, total_art: 2 }), makeSub({ id: 2, total_art: 1 })]
         data.articles.push(makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 1 }))
         const result = await nav.fromHash("0!1")
         expect(result.has_right).toBe(true)
      })

      it("false in filter mode with no later same-sub entries and no next pack", async () => {
         data.db.total_art = 2
         data.articles.push(makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 2 }))
         const result = await nav.fromHash("0!1")
         expect(result.has_right).toBe(false)
      })

      it("true in filter mode when later packs exist", async () => {
         data.db.total_art = 1001
         data.db.subscriptions = [makeSub({ id: 1, total_art: 2 })]
         mockIdxLoadOnce([makeEntry({ sub_id: 1 })])
         const result = await nav.fromHash("0!1")
         expect(result.has_right).toBe(true)
      })

      it("true in filter mode when next pack exists even if no match in current pack", async () => {
         data.db.total_art = 1001
         data.db.subscriptions = [makeSub({ id: 1, total_art: 2 })]
         mockIdxLoadOnce([makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 2 })])
         const result = await nav.fromHash("0!1")
         expect(result.has_right).toBe(true)
      })

      it("false in latest pack with no later same-sub entries", async () => {
         data.db.total_art = 3
         data.articles.push(makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 2 }))
         const result = await nav.fromHash("0!1")
         expect(result.has_right).toBe(false)
      })
   })

   describe("fields", () => {
      it("includes sub from subs_mapped", async () => {
         const sub = makeSub({ title: "MySub", url: "http://sub.com" })
         data.db.subs_mapped.set(1, sub)
         data.articles.push(makeEntry({ sub_id: 1 }))
         const result = await nav.load(0)
         expect(result.sub).toBe(sub)
      })

      it("sub is undefined when not in subs_mapped", async () => {
         data.articles.push(makeEntry({ sub_id: 99 }))
         const result = await nav.load(0)
         expect(result.sub).toBeUndefined()
      })
   })

   describe("hash", () => {
      it("includes filter marker when filtered", async () => {
         const replaceSpy = vi.spyOn(history, "replaceState")
         data.articles.push(makeEntry())
         await nav.fromHash("0!1")
         vi.runAllTimers()
         expect(replaceSpy).toHaveBeenCalledWith(null, "", "#0!1")
         replaceSpy.mockRestore()
      })

      it("includes floor in hash", async () => {
         const replaceSpy = vi.spyOn(history, "replaceState")
         data.articles.push(makeEntry())
         await nav.fromHash("0~2")
         vi.runAllTimers()
         expect(replaceSpy).toHaveBeenCalledWith(null, "", "#0~2")
         replaceSpy.mockRestore()
      })

      it("includes floor and filter in hash", async () => {
         const replaceSpy = vi.spyOn(history, "replaceState")
         data.articles.push(makeEntry())
         await nav.fromHash("0~2!1")
         vi.runAllTimers()
         expect(replaceSpy).toHaveBeenCalledWith(null, "", "#0~2!1")
         replaceSpy.mockRestore()
      })

      it("hash includes chronIdx", async () => {
         const pushSpy = vi.spyOn(history, "pushState")
         data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
         await nav.load(1)
         vi.runAllTimers()
         expect(pushSpy).toHaveBeenCalledWith(null, "", "#1")
         pushSpy.mockRestore()
      })

      it("hash after left navigation updates chronIdx", async () => {
         const pushSpy = vi.spyOn(history, "pushState")
         data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
         await nav.load(2)
         pushSpy.mockClear()
         await nav.left()
         vi.runAllTimers()
         expect(pushSpy).toHaveBeenCalledWith(null, "", "#1")
         pushSpy.mockRestore()
      })
   })
})

describe("floor", () => {
   it("has_left false at floor chronIdx (normal mode)", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      nav.setFloorChron(1)
      const result = await nav.load(1)
      expect(result.has_left).toBe(false)
      expect(result.floor).toBe(true)
   })

   it("has_left true above floor chronIdx (normal mode)", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      nav.setFloorChron(0)
      const result = await nav.load(2)
      expect(result.has_left).toBe(true)
   })

   it("left() navigates within floor but not past it", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      nav.setFloorChron(1)
      await nav.load(2)
      const r1 = await nav.left()
      expect(r1.article.title).toBe("B")
      expect(r1.has_left).toBe(false)
   })

   it("left() does not go below floor chronIdx (normal mode)", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      nav.setFloorChron(1)
      await nav.load(1)

      data.loadIdxPack.mockClear()

      const result = await nav.left()
      expect(result.article.title).toBe("B")
   })

   it("setFloorHere sets floor to current chronIdx", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      await nav.load(1)
      const pushSpy = vi.spyOn(history, "pushState")
      const result = nav.setFloorHere()
      vi.runAllTimers()
      expect(result.floor).toBe(true)
      expect(nav.floorChron).toBe(1)
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#1~1")
      pushSpy.mockRestore()
   })

   it("clearFloor removes floor", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      nav.setFloorChron(1)
      await nav.load(1)
      const result = nav.clearFloor()
      expect(result.floor).toBe(false)
      expect(result.has_left).toBe(true)
   })

   it("fromHash parses floor from hash", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      const result = await nav.fromHash("1~2")
      expect(result.floor).toBe(true)
   })

   it("fromHash clears floor when no ~ segment", async () => {
      nav.setFloorChron(2)
      data.articles.push(makeEntry({ title: "A" }))
      const result = await nav.fromHash("0")
      expect(result.floor).toBe(false)
   })

   it("load does not block navigation below floor (soft floor)", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      nav.setFloorChron(5)
      const result = await nav.load(0)
      expect(result.article.title).toBe("A")
   })

   it("floorIdx export reflects setFloor changes", () => {
      expect(nav.floorChron).toBe(0)
      nav.setFloorChron(5)
      expect(nav.floorChron).toBe(5)
      nav.setFloorChron(0)
      expect(nav.floorChron).toBe(0)
   })

   it("has_left true in normal mode above floor", async () => {
      data.db.total_art = 2003
      data.articles.push(makeEntry({ title: "A" }))
      data.idxPack = -1
      nav.setFloorChron(1000)
      await nav.load(2000)
      await nav.left()
      expect(data.loadIdxPack).toHaveBeenCalledWith(1)
   })

   it("clearFloor resets floorIdx to 0", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      await nav.load(1)
      nav.setFloorHere()
      expect(nav.floorChron).toBe(1)
      nav.clearFloor()
      expect(nav.floorChron).toBe(0)
   })

   it("filter mode left blocked by floor", async () => {
      data.db.total_art = 4
      data.articles.push(
         makeEntry({ sub_id: 1, title: "S1-A" }),
         makeEntry({ sub_id: 2, title: "S2-A" }),
         makeEntry({ sub_id: 1, title: "S1-B" }),
         makeEntry({ sub_id: 1, title: "S1-C" }),
      )
      nav.setFloorChron(2)
      await nav.fromHash("3~2!1")
      const r1 = await nav.left()
      expect(r1.article.title).toBe("S1-B")
      expect(r1.has_left).toBe(false)
   })

   it("floor blocks cross-pack chain in filter mode", async () => {
      data.db.total_art = 2001
      data.articles.push(makeEntry({ sub_id: 1, title: "Latest-Feed" }))
      data.idxPack = -1
      nav.setFloorChron(2000)
      await nav.fromHash("2000~2000!1")
      const result = await nav.left()
      expect(result.article.title).toBe("Latest-Feed")
   })
})

describe("countLeft", () => {
   describe("unfiltered, no floor", () => {
      it("returns 0 at chronIdx 0", async () => {
         data.db.total_art = 2
         data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
         const r = await nav.load(0)
         expect(r.countLeft).toBe(0)
      })

      it("returns chronIdx value", async () => {
         data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
         const r = await nav.load(2)
         expect(r.countLeft).toBe(2)
      })
   })

   describe("unfiltered, with floor", () => {
      it("subtracts floor chronIdx", async () => {
         data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
         await nav.load(1)
         nav.setFloorHere()
         const r = await nav.load(2)
         expect(r.countLeft).toBe(1)
      })
   })

   describe("filtered, no floor", () => {
      it("counts only matching sub articles in current pack", async () => {
         data.db.total_art = 4
         data.articles.push(
            makeEntry({ sub_id: 1 }),
            makeEntry({ sub_id: 2 }),
            makeEntry({ sub_id: 1 }),
            makeEntry({ sub_id: 1 }),
         )
         data.db.subs_mapped.set(1, makeSub({ id: 1 }))
         nav.setFilterSubs(new Set([1]))
         const r = await nav.load(3)
         expect(r.countLeft).toBe(2)
      })

      it("returns 0 at the first article of a sub in pack", async () => {
         data.db.total_art = 2
         data.articles.push(makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 1 }))
         data.db.subs_mapped.set(1, makeSub({ id: 1 }))
         nav.setFilterSubs(new Set([1]))
         const r = await nav.load(1)
         expect(r.countLeft).toBe(0)
      })
   })

   describe("filtered, with floor", () => {
      it("counts sub articles from floor when floor is in current pack", async () => {
         data.db.total_art = 4
         data.articles.push(
            makeEntry({ sub_id: 2 }),
            makeEntry({ sub_id: 1 }),
            makeEntry({ sub_id: 1 }),
            makeEntry({ sub_id: 1 }),
         )
         data.db.subs_mapped.set(1, makeSub({ id: 1 }))
         nav.setFilterSubs(new Set([1]))
         nav.setFloorChron(1)
         const r = await nav.load(3)
         expect(r.countLeft).toBe(2)
      })
   })

   describe("filtered, cross-pack", () => {
      it("returns null when filteredCountBefore returns null", async () => {
         data.db.total_art = 2003
         data.articles.push(makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 1 }))
         data.db.subs_mapped.set(1, makeSub({ id: 1 }))
         nav.setFilterSubs(new Set([1]))
         tsMock.filteredCountBefore.mockResolvedValueOnce(null)
         mockIdxLoad([makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 1 })])
         const r = await nav.load(2002)
         expect(r.countLeft).toBeNull()
      })

      it("uses ts count + remainder from idx pack", async () => {
         data.db.total_art = 2003
         data.articles.push(makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 1 }))
         data.db.subs_mapped.set(1, makeSub({ id: 1 }))
         nav.setFilterSubs(new Set([1]))
         // ts covers up to total=2001 (chronIdx 0-2000), with 10 matching articles for sub 1
         tsMock.filteredCountBefore.mockResolvedValueOnce({ count: 10, total: 2001 })
         mockIdxLoad([makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 1 }), makeEntry({ sub_id: 1 })])
         const r = await nav.load(2002)
         // 10 from ts + 1 matching at pos 1 (chronIdx 2001, between total and packPos)
         expect(r.countLeft).toBe(11)
      })
   })

   describe("multi-sub filtered", () => {
      it("counts articles matching any sub in filter set", async () => {
         data.db.total_art = 5
         data.articles.push(
            makeEntry({ sub_id: 1 }),
            makeEntry({ sub_id: 2 }),
            makeEntry({ sub_id: 3 }),
            makeEntry({ sub_id: 1 }),
            makeEntry({ sub_id: 3 }),
         )
         nav.setFilterSubs(new Set([1, 3]))
         const r = await nav.load(4)
         expect(r.countLeft).toBe(3)
      })
   })
})

describe("multi-sub filter", () => {
   it("hash serializes sorted sub IDs", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.articles.push(makeEntry({ sub_id: 3 }))
      nav.setFilterSubs(new Set([3, 1]))
      await nav.load(0)
      vi.runAllTimers()
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#0!1+3")
      pushSpy.mockRestore()
   })

   it("left matches any sub in filter set", async () => {
      data.db.total_art = 4
      data.articles.push(
         makeEntry({ sub_id: 1, title: "S1" }),
         makeEntry({ sub_id: 2, title: "S2" }),
         makeEntry({ sub_id: 3, title: "S3" }),
         makeEntry({ sub_id: 1, title: "S1-B" }),
      )
      await nav.fromHash("3!1+3")
      const r1 = await nav.left()
      expect(r1.article.title).toBe("S3")
      const r2 = await nav.left()
      expect(r2.article.title).toBe("S1")
   })

   it("has_left true when earlier multi-sub match exists", async () => {
      data.db.total_art = 3
      data.articles.push(
         makeEntry({ sub_id: 3, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
      )
      const result = await nav.fromHash("2!1+3")
      expect(result.has_left).toBe(true)
   })

   it("last preserves multi-sub set when called with no arg", async () => {
      data.db.total_art = 3
      data.db.subs_mapped.set(1, makeSub({ id: 1 }))
      data.db.subs_mapped.set(3, makeSub({ id: 3 }))
      data.articles.push(
         makeEntry({ sub_id: 1, title: "S1" }),
         makeEntry({ sub_id: 2, title: "S2" }),
         makeEntry({ sub_id: 3, title: "S3" }),
      )
      await nav.fromHash("0!1+3")
      const result = await nav.last()
      expect(result.article.title).toBe("S3")
      expect(result.filtered).toBe(true)
   })
})

describe("tag tokens", () => {
   it("fromHash resolves tag token to sub IDs", async () => {
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech" }), makeSub({ id: 2, tag: "tech" }), makeSub({ id: 3 })]
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 3, title: "C" }),
      )
      const result = await nav.fromHash("1!tech")
      expect(result.filtered).toBe(true)
      expect(result.article.title).toBe("B")
   })

   it("hash preserves tag token instead of expanding to sub IDs", async () => {
      const replaceSpy = vi.spyOn(history, "replaceState")
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech" }), makeSub({ id: 2, tag: "tech" })]
      data.articles.push(makeEntry({ sub_id: 1 }))
      await nav.fromHash("0!tech")
      vi.runAllTimers()
      expect(replaceSpy).toHaveBeenCalledWith(null, "", "#0!tech")
      replaceSpy.mockRestore()
   })

   it("setFilterTokens resolves tag and sets filter", async () => {
      data.db.subscriptions = [makeSub({ id: 5, tag: "news" }), makeSub({ id: 6, tag: "news" })]
      data.articles.push(makeEntry({ sub_id: 5, title: "N1" }), makeEntry({ sub_id: 6, title: "N2" }))
      nav.setFilterTokens(["news"])
      const result = await nav.load(1)
      expect(result.filtered).toBe(true)
   })

   it("tag with no matching subs clears filter", async () => {
      data.db.subscriptions = []
      data.articles.push(makeEntry({ title: "A" }))
      const result = await nav.fromHash("0!nonexistent")
      expect(result.filtered).toBe(false)
   })

   it("last() preserves tag token in hash", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech", total_art: 1 })]
      data.db.subs_mapped.set(1, data.db.subscriptions[0])
      data.articles.push(makeEntry({ sub_id: 1, title: "T1" }))
      nav.setFilterTokens(["tech"])
      const result = await nav.last()
      vi.runAllTimers()
      expect(result.filtered).toBe(true)
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#0!tech")
      pushSpy.mockRestore()
   })

   it("toggleFilter produces numeric token", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.articles.push(makeEntry({ sub_id: 7 }))
      await nav.load(0)
      pushSpy.mockClear()
      await nav.toggleFilter()
      vi.runAllTimers()
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#0!7")
      pushSpy.mockRestore()
   })

   it("mixed tag and sub ID tokens in hash", async () => {
      const replaceSpy = vi.spyOn(history, "replaceState")
      data.db.subscriptions = [makeSub({ id: 1, tag: "tech" }), makeSub({ id: 2 })]
      data.articles.push(makeEntry({ sub_id: 1, title: "A" }), makeEntry({ sub_id: 2, title: "B" }))
      await nav.fromHash("1!tech+2")
      vi.runAllTimers()
      expect(replaceSpy).toHaveBeenCalledWith(null, "", "#1!tech+2")
      replaceSpy.mockRestore()
   })
})

describe("filtered navigation with ts data", () => {
   it("left() uses candidate packs from ts data", async () => {
      data.db.total_art = 4003
      data.articles.push(makeEntry({ sub_id: 1, title: "Latest" }), makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 2 }))
      data.idxPack = -1
      await nav.fromHash("4000!1")

      // ts says: try pack 1 (skipping 3, 2)
      tsMock.findCandidateIdxPacks.mockResolvedValue([1])
      mockIdxLoadOnce([makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 1, title: "P1-Target" })])

      data.loadIdxPack.mockClear()
      const result = await nav.left()
      expect(result.article.title).toBe("P1-Target")
      const calls = data.loadIdxPack.mock.calls.map((c: number[]) => c[0])
      expect(calls).toContain(1)
      expect(calls).not.toContain(3)
      expect(calls).not.toContain(2)
   })

   it("right() uses candidate packs from ts data", async () => {
      data.db.total_art = 5003
      data.articles.push(makeEntry({ sub_id: 1, title: "Pack0" }))
      data.idxPack = -1
      await nav.fromHash("0!1")

      // ts says: try pack 3 (skipping 1, 2)
      tsMock.findCandidateIdxPacks.mockResolvedValue([3])
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "P3-Target" })])

      data.loadIdxPack.mockClear()
      const result = await nav.right()
      expect(result.article.title).toBe("P3-Target")
      const calls = data.loadIdxPack.mock.calls.map((c: number[]) => c[0])
      expect(calls).toContain(3)
      expect(calls).not.toContain(1)
      expect(calls).not.toContain(2)
   })

   it("last() uses candidate packs from ts data", async () => {
      data.db.total_art = 4003
      data.db.subs_mapped = new Map([[1, makeSub({ id: 1, total_art: 5 })]])
      data.articles.push(makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 2 }))
      data.idxPack = -1

      // ts says: try pack 1 (skipping 3, 2, 0)
      tsMock.findCandidateIdxPacks.mockResolvedValue([1])

      // latest pack (4) has no match, then scan candidates
      mockIdxLoadOnce([makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 2 })])
      // pack 1 has a match
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "P1-Last" })])

      data.loadIdxPack.mockClear()
      const result = await nav.last("1")
      expect(result.article.title).toBe("P1-Last")
      const calls = data.loadIdxPack.mock.calls.map((c: number[]) => c[0])
      expect(calls).not.toContain(3)
      expect(calls).not.toContain(2)
      expect(calls).not.toContain(0)
   })

   it("falls back to sequential when findCandidateIdxPacks returns null", async () => {
      data.db.total_art = 3003
      data.articles.push(makeEntry({ sub_id: 1, title: "Latest" }), makeEntry({ sub_id: 2 }), makeEntry({ sub_id: 2 }))
      data.idxPack = -1
      await nav.fromHash("3000!1")

      tsMock.findCandidateIdxPacks.mockResolvedValue(null)
      // pack 2 has no match, pack 1 has match
      mockIdxLoadOnce([makeEntry({ sub_id: 2 })])
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "P1-Fallback" })])

      data.loadIdxPack.mockClear()
      const result = await nav.left()
      expect(result.article.title).toBe("P1-Fallback")
      const calls = data.loadIdxPack.mock.calls.map((c: number[]) => c[0])
      expect(calls).toContain(2)
      expect(calls).toContain(1)
   })

   it("candidate list order is respected", async () => {
      data.db.total_art = 5003
      data.articles.push(makeEntry({ sub_id: 1, title: "Pack0" }))
      data.idxPack = -1
      await nav.fromHash("0!1")

      // ts says: try pack 2 first, then pack 4 (latest)
      tsMock.findCandidateIdxPacks.mockResolvedValue([2, 4])
      mockIdxLoadOnce([makeEntry({ sub_id: 2 })]) // pack 2 no match
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "Latest-Target" })]) // pack 4 match

      data.loadIdxPack.mockClear()
      const result = await nav.right()
      expect(result.article.title).toBe("Latest-Target")
      const calls = data.loadIdxPack.mock.calls.map((c: number[]) => c[0])
      expect(calls[0]).toBe(2)
      expect(calls[1]).toBe(4)
      expect(calls).not.toContain(1)
      expect(calls).not.toContain(3)
   })
})

describe("load snap-to-filter", () => {
   it("snaps to earlier matching article in same pack", async () => {
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
         makeEntry({ sub_id: 2, title: "D" }),
      )
      data.db.total_art = 4
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(3)
      expect(result.article.title).toBe("C")
   })

   it("snaps to later matching article if none earlier", async () => {
      data.articles.push(
         makeEntry({ sub_id: 2, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
      )
      data.db.total_art = 3
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(0)
      expect(result.article.title).toBe("C")
   })

   it("does not snap when current article matches filter", async () => {
      data.articles.push(makeEntry({ sub_id: 1, title: "A" }), makeEntry({ sub_id: 2, title: "B" }))
      data.db.total_art = 2
      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(0)
      expect(result.article.title).toBe("A")
   })

   it("does not snap when no filter is active", async () => {
      data.articles.push(makeEntry({ sub_id: 1, title: "A" }), makeEntry({ sub_id: 2, title: "B" }))
      data.db.total_art = 2
      const result = await nav.load(1)
      expect(result.article.title).toBe("B")
   })

   it("snaps across packs when no match in current pack", async () => {
      data.db.total_art = 2003

      // Load latest pack (pack 2) with no matching articles
      mockIdxLoadOnce([
         makeEntry({ sub_id: 2, title: "L1" }),
         makeEntry({ sub_id: 2, title: "L2" }),
         makeEntry({ sub_id: 2, title: "L3" }),
      ])
      // Search left: pack 1 has a match
      mockIdxLoadOnce([makeEntry({ sub_id: 1, title: "P1-Match" })])

      nav.setFilterSubs(new Set([1]))
      const result = await nav.load(2002)
      expect(result.article.title).toBe("P1-Match")
   })

   it("fromHash snaps to matching article", async () => {
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
      )
      data.db.total_art = 3
      const result = await nav.fromHash("1!1")
      expect(result.article.title).toBe("A")
   })

   it("respects floor when snapping left", async () => {
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 2, title: "C" }),
         makeEntry({ sub_id: 1, title: "D" }),
      )
      data.db.total_art = 4
      nav.setFilterSubs(new Set([1]))
      nav.setFloorChron(1)
      const result = await nav.load(2)
      // Should skip "A" (chronIdx 0 < floor 1) and find "D" to the right
      expect(result.article.title).toBe("D")
   })
})

describe("applyFilter snap", () => {
   it("snaps to matching article when filter excludes current", async () => {
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
      )
      data.db.total_art = 3
      await nav.load(1) // on "B" (sub_id 2)
      const result = await nav.applyFilter(["1"])
      expect(result.article.title).toBe("A")
   })

   it("stays on current article when it matches new filter", async () => {
      data.articles.push(makeEntry({ sub_id: 1, title: "A" }), makeEntry({ sub_id: 2, title: "B" }))
      data.db.total_art = 2
      await nav.load(0) // on "A" (sub_id 1)
      const result = await nav.applyFilter(["1"])
      expect(result.article.title).toBe("A")
   })

   it("clears filter and stays on current article", async () => {
      data.articles.push(makeEntry({ sub_id: 1, title: "A" }), makeEntry({ sub_id: 2, title: "B" }))
      data.db.total_art = 2
      nav.setFilterSubs(new Set([1]))
      await nav.load(0)
      const result = await nav.applyFilter(undefined)
      expect(result.article.title).toBe("A")
      expect(result.filtered).toBe(false)
   })
})

describe("jumpToEnd", () => {
   it("navigates to last article", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      await nav.load(0)
      const result = await nav.jumpToEnd()
      expect(result.article.title).toBe("C")
   })

   it("returns last article when already at end", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      data.db.total_art = 1
      await nav.load(0)
      const result = await nav.jumpToEnd()
      expect(result.article.title).toBe("A")
   })
})

describe("first", () => {
   it("returns current article when floor is 0", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      await nav.load(1)
      const result = await nav.first()
      expect(result.article.title).toBe("B")
   })

   it("navigates to floor chronIdx when floor is set", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      await nav.load(2)
      nav.setFloorChron(1)
      const result = await nav.first()
      expect(result.article.title).toBe("B")
   })
})

describe("getFilterEntries", () => {
   it("returns only empty string when no active subs", async () => {
      data.articles.push(makeEntry())
      await nav.load(0)
      const entries = nav.getFilterEntries()
      expect(entries).toEqual([""])
   })

   it("returns tags sorted then untagged sub IDs", async () => {
      const sub1 = makeSub({ id: 1, title: "Z-Sub", total_art: 5, tag: "beta" })
      const sub2 = makeSub({ id: 2, title: "A-Sub", total_art: 3, tag: "alpha" })
      const sub3 = makeSub({ id: 3, title: "B-Sub", total_art: 2 })
      data.db.subs_mapped = new Map([
         [1, sub1],
         [2, sub2],
         [3, sub3],
      ])
      data.db.subscriptions = [sub1, sub2, sub3]
      data.articles.push(makeEntry())
      await nav.load(0)
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "tag:alpha", "tag:beta", "3"])
   })

   it("excludes subs with zero articles", async () => {
      const sub1 = makeSub({ id: 1, title: "Active", total_art: 5 })
      const sub2 = makeSub({ id: 2, title: "Empty", total_art: 0 })
      data.db.subs_mapped = new Map([
         [1, sub1],
         [2, sub2],
      ])
      data.db.subscriptions = [sub1, sub2]
      data.articles.push(makeEntry())
      await nav.load(0)
      const entries = nav.getFilterEntries()
      expect(entries).toEqual(["", "1"])
   })
})

describe("getCurrentFilterKey", () => {
   it("returns empty string when no filter", async () => {
      data.articles.push(makeEntry())
      await nav.load(0)
      expect(nav.getCurrentFilterKey()).toBe("")
   })

   it("returns sub ID for numeric filter", async () => {
      data.articles.push(makeEntry({ sub_id: 5 }))
      nav.setFilterTokens(["5"])
      expect(nav.getCurrentFilterKey()).toBe("5")
   })

   it("returns tag:name for tag filter", async () => {
      const sub1 = makeSub({ id: 1, title: "Sub1", tag: "news" })
      data.db.subs_mapped = new Map([[1, sub1]])
      data.db.subscriptions = [sub1]
      data.articles.push(makeEntry({ sub_id: 1 }))
      nav.setFilterTokens(["news"])
      expect(nav.getCurrentFilterKey()).toBe("tag:news")
   })

   it("returns tag for multi-ID filter matching a tag group", async () => {
      const sub1 = makeSub({ id: 1, title: "Sub1", tag: "tech" })
      const sub2 = makeSub({ id: 2, title: "Sub2", tag: "tech" })
      data.db.subs_mapped = new Map([
         [1, sub1],
         [2, sub2],
      ])
      data.db.subscriptions = [sub1, sub2]
      data.articles.push(makeEntry({ sub_id: 1 }))
      nav.setFilterSubs(new Set([1, 2]))
      expect(nav.getCurrentFilterKey()).toBe("tag:tech")
   })

   it("returns empty string for multi-ID filter not matching any tag", async () => {
      const sub1 = makeSub({ id: 1, title: "Sub1" })
      const sub2 = makeSub({ id: 2, title: "Sub2" })
      data.db.subs_mapped = new Map([
         [1, sub1],
         [2, sub2],
      ])
      data.db.subscriptions = [sub1, sub2]
      data.articles.push(makeEntry({ sub_id: 1 }))
      nav.setFilterSubs(new Set([1, 2]))
      expect(nav.getCurrentFilterKey()).toBe("")
   })
})

describe("first() with floor+filter", () => {
   it("navigates to floor chronIdx in filter mode", async () => {
      data.db.total_art = 4
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
         makeEntry({ sub_id: 1, title: "D" }),
      )
      nav.setFilterSubs(new Set([1]))
      nav.setFloorChron(2)
      await nav.load(3)
      const result = await nav.first()
      expect(result.article.title).toBe("C")
   })

   it("returns current article when floor is 0 in filter mode", async () => {
      data.db.total_art = 3
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
      )
      nav.setFilterSubs(new Set([1]))
      await nav.load(2)
      const result = await nav.first()
      expect(result.article.title).toBe("C")
   })
})

describe("jumpToEnd with filter", () => {
   it("jumps to last article and snaps to filter", async () => {
      data.db.total_art = 3
      data.articles.push(
         makeEntry({ sub_id: 1, title: "A" }),
         makeEntry({ sub_id: 1, title: "B" }),
         makeEntry({ sub_id: 2, title: "C" }),
      )
      nav.setFilterSubs(new Set([1]))
      await nav.load(0)
      const result = await nav.jumpToEnd()
      expect(result.article.title).toBe("B")
   })
})

describe("load with NaN/Infinity", () => {
   it("clamps NaN to last article", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      const result = await nav.load(NaN)
      expect(result.article.title).toBe("B")
   })

   it("clamps Infinity to last article", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      const result = await nav.load(Infinity)
      expect(result.article.title).toBe("B")
   })
})

describe("setFloorAt", () => {
   it("sets floor and returns showFeed", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      await nav.load(1)
      pushSpy.mockClear()
      const result = await nav.setFloorAt(0)
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
      pushSpy.mockRestore()
   })

   it("sets nonzero floor correctly", async () => {
      const pushSpy = vi.spyOn(history, "pushState")
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      await nav.load(1)
      pushSpy.mockClear()
      const result = await nav.setFloorAt(1)
      vi.runAllTimers()
      expect(result.floor).toBe(true)
      expect(nav.floorChron).toBe(1)
      expect(pushSpy).toHaveBeenCalledWith(null, "", "#1~1")
      pushSpy.mockRestore()
   })
})

describe("countLeft edge cases", () => {
   it("filtered: returns 0 when current is the only match in pack", async () => {
      data.db.total_art = 3
      data.articles.push(
         makeEntry({ sub_id: 2, title: "A" }),
         makeEntry({ sub_id: 2, title: "B" }),
         makeEntry({ sub_id: 1, title: "C" }),
      )
      nav.setFilterSubs(new Set([1]))
      const r = await nav.load(2)
      expect(r.countLeft).toBe(0)
   })

   it("unfiltered with floor at same position: returns 0", async () => {
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }))
      nav.setFloorChron(1)
      const r = await nav.load(1)
      expect(r.countLeft).toBe(0)
   })
})

describe("fromHash edge cases", () => {
   it("hash with ! before ~ ignores tilde in filter portion", async () => {
      data.articles.push(makeEntry({ sub_id: 1, title: "A" }))
      const result = await nav.fromHash("0!1~5")
      expect(result.floor).toBe(false)
      expect(nav.floorChron).toBe(0)
   })

   it("hash with only tilde", async () => {
      data.articles.push(makeEntry({ title: "A" }))
      const result = await nav.fromHash("~")
      expect(result.floor).toBe(false)
   })

   it("hash with empty tokens between plus signs", async () => {
      data.articles.push(makeEntry({ sub_id: 1, title: "A" }))
      const result = await nav.fromHash("0!1++3")
      expect(result.filtered).toBe(true)
   })
})

describe("resolveTokens via fromHash", () => {
   it("resolves token '0' as sub ID 0", async () => {
      data.db.subscriptions = [makeSub({ id: 0, title: "Zero" })]
      data.db.subs_mapped.set(0, data.db.subscriptions[0])
      data.articles.push(makeEntry({ sub_id: 0, title: "A" }))
      const result = await nav.fromHash("0!0")
      expect(result.filtered).toBe(true)
   })
})

describe("nextIdxPack edge cases", () => {
   it("right does not cross pack boundary when no next pack exists", async () => {
      data.db.total_art = 3
      data.articles.push(makeEntry({ title: "A" }), makeEntry({ title: "B" }), makeEntry({ title: "C" }))
      await nav.load(2)
      data.loadIdxPack.mockClear()
      const result = await nav.right()
      expect(result.article.title).toBe("C")
      expect(result.has_right).toBe(false)
      expect(data.loadIdxPack).not.toHaveBeenCalled()
   })
})
