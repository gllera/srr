import { beforeEach, describe, expect, it, vi } from "vitest"

// effects.ts registers the REAL derived-paint table against injected surfaces,
// so this suite drives it with fakes and counts. A fresh module registry per
// case: the model, the layout record and the effects must share one instance
// (docs/superpowers/plans/2026-09-15-frontend-architecture-trio-index.md §2).
let model: typeof import("./model")
let signals: typeof import("./signals")
let effects: typeof import("./effects")

const tick = () => new Promise((r) => setTimeout(r))

const PROBED = {
   article: { f: 1, a: 0, p: 0, t: "T", l: "", c: "" },
   has_left: true,
   has_right: true,
   right_count: 2,
} as IShowFeed

function fakes() {
   return {
      unreadTotal: vi.fn(async () => 3),
      setListTitle: vi.fn(),
      applyUnreadTotal: vi.fn(),
      refreshSettingsStatus: vi.fn(),
      probeChrome: vi.fn(async (): Promise<IShowFeed | null> => PROBED),
      applyChrome: vi.fn(),
      paintSaveButton: vi.fn(),
      paintFeedLabel: vi.fn(),
      restingState: vi.fn(async (): Promise<IShowFeed | null> => null),
      renderResting: vi.fn(),
      reconcileList: vi.fn<(mounted: boolean) => Promise<void> | null>(() => null),
      afterListBuild: vi.fn(),
      onListError: vi.fn(),
      refreshListRows: vi.fn(),
      followListCursor: vi.fn(),
      listGrown: vi.fn(),
      pickerOpen: vi.fn(() => false),
      renderPicker: vi.fn(),
      onPaintError: vi.fn(),
   }
}

beforeEach(async () => {
   vi.resetModules()
   model = await import("./model")
   signals = await import("./signals")
   effects = await import("./effects")
})

describe("titleAndBadge", () => {
   it("tallies once on registration and applies the total", async () => {
      const s = fakes()
      effects.registerEffects(s)
      await tick()
      expect(s.unreadTotal).toHaveBeenCalledTimes(1)
      expect(s.applyUnreadTotal).toHaveBeenCalledWith(3)
   })

   it("re-tallies when the seen map, the snapshot or the active store moves — not on a cursor move", async () => {
      const s = fakes()
      effects.registerEffects(s)
      await tick()
      model.cursor.set({ chron: 4, feedId: 1 })
      await tick()
      expect(s.unreadTotal).toHaveBeenCalledTimes(1)
      model.seen.set({ "feed:1": 4 })
      await tick()
      expect(s.unreadTotal).toHaveBeenCalledTimes(2)
      model.snapshot.update((n) => n + 1)
      await tick()
      expect(s.unreadTotal).toHaveBeenCalledTimes(3)
      model.activeMid.set("s7")
      await tick()
      expect(s.unreadTotal).toHaveBeenCalledTimes(4)
   })

   it("a burst writes only the newest tally (the old burst-collapse, by token)", async () => {
      const lands: Array<(v: number) => void> = []
      const s = fakes()
      s.unreadTotal.mockImplementation(() => new Promise<number>((res) => lands.push(res)))
      effects.registerEffects(s)
      model.seen.set({ a: 1 })
      model.seen.set({ a: 2 })
      lands[2](30)
      await tick()
      lands[0](10)
      lands[1](20)
      await tick()
      expect(s.applyUnreadTotal.mock.calls).toEqual([[30]])
   })

   it("a failed tally writes nothing", async () => {
      const s = fakes()
      s.unreadTotal.mockRejectedValue(new Error("blip"))
      effects.registerEffects(s)
      await tick()
      expect(s.applyUnreadTotal).not.toHaveBeenCalled()
   })

   it("sets the list's title while the list holds focus, and again when what it names moves", () => {
      const s = fakes()
      effects.registerEffects(s)
      expect(s.setListTitle).toHaveBeenCalledTimes(1)
      model.laneTokens.set(["news"])
      expect(s.setListTitle).toHaveBeenCalledTimes(2)
      model.focus.set("reader") // the reader names its own article on render
      model.laneTokens.set(["tech"])
      expect(s.setListTitle).toHaveBeenCalledTimes(2)
      model.focus.set("list")
      expect(s.setListTitle).toHaveBeenCalledTimes(3)
   })
})

describe("pickerStatus", () => {
   it("refills the settings footer when the sync status, the refresh error or the snapshot moves", () => {
      const s = fakes()
      effects.registerEffects(s)
      s.refreshSettingsStatus.mockClear()
      model.syncStatus.set({ on: true, okAt: 1, error: "" })
      expect(s.refreshSettingsStatus).toHaveBeenCalledTimes(1)
      model.syncStatus.set({ on: true, okAt: 1, error: "" }) // equal record: nothing to refill
      expect(s.refreshSettingsStatus).toHaveBeenCalledTimes(1)
      model.refreshError.set("boom")
      expect(s.refreshSettingsStatus).toHaveBeenCalledTimes(2)
      model.snapshot.update((n) => n + 1)
      expect(s.refreshSettingsStatus).toHaveBeenCalledTimes(3)
      model.cursor.set({ chron: 1, feedId: 1 })
      expect(s.refreshSettingsStatus).toHaveBeenCalledTimes(3)
   })
})

describe("readerChrome (D3)", () => {
   const goLive = () =>
      signals.batch(() => {
         model.split.set(true)
         model.readerPainted.set(true)
         model.cursor.set({ chron: 5, feedId: 1 })
      })

   it("probes when an input moves without a render, and applies the result", async () => {
      const s = fakes()
      effects.registerEffects(s)
      goLive()
      await tick()
      s.probeChrome.mockClear()
      s.applyChrome.mockClear()
      model.seen.set({ "feed:1": 5 }) // a row swipe, a merge — no render
      await tick()
      expect(s.probeChrome).toHaveBeenCalledTimes(1)
      expect(s.applyChrome).toHaveBeenCalledWith(PROBED, false)
   })

   it("starts nothing for the inputs a render just painted", async () => {
      const s = fakes()
      const fx = effects.registerEffects(s)
      model.rendering.set(true) // guard() holds it across fn() + render
      signals.batch(() => {
         model.split.set(true)
         model.readerPainted.set(true)
         model.cursor.set({ chron: 5, feedId: 1 })
         model.seen.set({ "feed:1": 5 })
      })
      fx.markChromePainted()
      model.rendering.set(false)
      await tick()
      expect(s.probeChrome).not.toHaveBeenCalled()
   })

   it("a write that lands while the landing's probes are awaited still gets its probe", async () => {
      const s = fakes()
      const fx = effects.registerEffects(s)
      model.rendering.set(true) // guard() holds it across fn() + render
      signals.batch(() => {
         model.split.set(true)
         model.readerPainted.set(true)
         model.cursor.set({ chron: 5, feedId: 1 }) // resolve()'s commit…
         model.seen.set({ "feed:1": 5 })
      })
      model.seen.set({ "feed:1": 5, "feed:2": 9 }) // …a sync merge while showFeed awaits
      fx.markChromePainted() // reader.render painted the counts from BEFORE the merge
      model.rendering.set(false)
      await tick()
      expect(s.probeChrome).toHaveBeenCalledTimes(1)
   })

   it("a failed probe applies nothing, and the next input change probes again", async () => {
      const s = fakes()
      effects.registerEffects(s)
      goLive()
      await tick()
      s.applyChrome.mockClear()
      s.probeChrome.mockRejectedValueOnce(new Error("offline"))
      model.seen.set({ "feed:1": 5 })
      await tick()
      expect(s.applyChrome).not.toHaveBeenCalled() // the previous probe's result is not re-applied
      model.seen.set({ "feed:1": 6 })
      await tick()
      expect(s.probeChrome).toHaveBeenCalledTimes(3)
      expect(s.applyChrome).toHaveBeenCalledTimes(1)
   })

   it("does not probe while the reader is not live", async () => {
      const s = fakes()
      effects.registerEffects(s)
      model.seen.set({ "feed:1": 1 })
      model.snapshot.update((n) => n + 1)
      await tick()
      expect(s.probeChrome).not.toHaveBeenCalled()
   })

   it("pulses only when articles arrived, never for a frontier move", async () => {
      const s = fakes()
      effects.registerEffects(s)
      goLive()
      await tick()
      s.applyChrome.mockClear()
      signals.batch(() => {
         model.snapshot.update((n) => n + 1)
         model.storeGrown.update((n) => n + 1)
      })
      await tick()
      expect(s.applyChrome).toHaveBeenLastCalledWith(PROBED, true)
      model.frontierEpoch.update((n) => n + 1)
      await tick()
      expect(s.applyChrome).toHaveBeenLastCalledWith(PROBED, false)
   })

   it("a layout move that leaves the chrome inputs alone starts no probe", async () => {
      const s = fakes()
      effects.registerEffects(s)
      goLive()
      await tick()
      expect(s.probeChrome).toHaveBeenCalledTimes(1) // the initial probe+apply, which stamps paintedKey
      s.probeChrome.mockClear()
      // A pane hide/show moves layout()'s identity without touching readerLive or
      // any chrome input: the resource's keyEquals absorbs it. (The paintedKey
      // dedup itself is pinned by "starts nothing for the inputs a render just
      // painted".)
      model.paneHidden.set(true)
      await tick()
      expect(s.probeChrome).not.toHaveBeenCalled()
   })

   it("drops a probe superseded by a newer input", async () => {
      const lands: Array<(o: IShowFeed) => void> = []
      const s = fakes()
      s.probeChrome.mockImplementation(() => new Promise<IShowFeed>((res) => lands.push(res)))
      effects.registerEffects(s)
      goLive()
      model.cursor.set({ chron: 6, feedId: 1 })
      const newer = { ...PROBED, right_count: 1 }
      lands[1](newer)
      await tick()
      lands[0](PROBED)
      await tick()
      expect(s.applyChrome.mock.calls).toEqual([[newer, false]])
   })
})

describe("saveButton", () => {
   it("paints enablement and the star from the cursor, the saved set and the paint", () => {
      const s = fakes()
      effects.registerEffects(s)
      expect(s.paintSaveButton).toHaveBeenLastCalledWith(false, false) // nothing painted
      signals.batch(() => {
         model.readerPainted.set(true)
         model.cursor.set({ chron: 3, feedId: 1 })
      })
      expect(s.paintSaveButton).toHaveBeenLastCalledWith(true, false)
      model.saved.set([3]) // the article on screen was saved
      expect(s.paintSaveButton).toHaveBeenLastCalledWith(true, true)
      model.saved.set([1]) // …and un-saved again
      model.readerPainted.set(false) // a placeholder replaced the article
      expect(s.paintSaveButton).toHaveBeenLastCalledWith(false, false)
   })
})

describe("feedLabel", () => {
   it("repaints the readout when the lane, the store or the mount table moves", () => {
      const s = fakes()
      effects.registerEffects(s)
      expect(s.paintFeedLabel).toHaveBeenCalledTimes(1)
      model.laneTokens.set(["news"])
      model.activeMid.set("s7")
      model.mountsRev.update((n) => n + 1)
      expect(s.paintFeedLabel).toHaveBeenCalledTimes(4)
      model.cursor.set({ chron: 9, feedId: 2 })
      expect(s.paintFeedLabel).toHaveBeenCalledTimes(4)
   })
})

describe("restingPane (D4)", () => {
   const PANEL = { ...PROBED, placeholder: true } as IShowFeed
   const splitList = () =>
      signals.batch(() => {
         model.split.set(true)
         model.focus.set("list")
      })

   it("paints the panel for a split pane with no live article, and not otherwise", async () => {
      const s = fakes()
      s.restingState.mockResolvedValue(PANEL)
      effects.registerEffects(s)
      await tick()
      expect(s.restingState).not.toHaveBeenCalled() // narrow: there is no pane
      splitList()
      await tick()
      expect(s.renderResting).toHaveBeenCalledExactlyOnceWith(PANEL)
   })

   it("repaints when what the panel counts moves — not on a cursor step, a pane toggle or an idle command", async () => {
      const s = fakes()
      s.restingState.mockResolvedValue(PANEL)
      effects.registerEffects(s)
      splitList()
      await tick()
      s.restingState.mockClear()
      model.cursor.set({ chron: 4, feedId: 1 }) // the list's row step
      model.paneHidden.set(true)
      model.rendering.set(true)
      model.rendering.set(false)
      await tick()
      expect(s.restingState).not.toHaveBeenCalled()
      model.laneTokens.set(["news"])
      await tick()
      expect(s.restingState).toHaveBeenCalledTimes(1)
   })

   it("drops a probe that lands after an article opened", async () => {
      const lands: Array<(o: IShowFeed) => void> = []
      const s = fakes()
      s.restingState.mockImplementation(() => new Promise<IShowFeed>((r) => lands.push(r)))
      effects.registerEffects(s)
      splitList()
      signals.batch(() => {
         model.readerPainted.set(true)
         model.cursor.set({ chron: 2, feedId: 1 })
      })
      lands[0](PANEL)
      await tick()
      expect(s.renderResting).not.toHaveBeenCalled()
   })

   it("waits out the boot hold and paints once over the state the first route left", async () => {
      const s = fakes()
      s.restingState.mockResolvedValue(PANEL)
      model.rendering.set(true) // app.ts's boot hold
      effects.registerEffects(s)
      splitList()
      model.laneTokens.set(["news"]) // route()'s lane write
      await tick()
      expect(s.restingState).not.toHaveBeenCalled()
      model.rendering.set(false)
      await tick()
      expect(s.restingState).toHaveBeenCalledTimes(1)
   })
})

describe("listSurface", () => {
   it("reconciles the list when its membership inputs move, with the mounted flag", () => {
      const s = fakes()
      effects.registerEffects(s)
      s.reconcileList.mockClear()
      model.unreadOnly.set(true)
      expect(s.reconcileList).toHaveBeenLastCalledWith(true) // focus list → mounted
      model.focus.set("reader") // single-surface reader: the list is not mounted
      model.frontierEpoch.update((n) => n + 1)
      expect(s.reconcileList).toHaveBeenLastCalledWith(false)
   })

   it("waits out a command, then runs once over the state it left (S16)", () => {
      const s = fakes()
      effects.registerEffects(s)
      s.reconcileList.mockClear()
      model.rendering.set(true)
      model.laneTokens.set(["news"])
      model.laneTokens.set(["tech"])
      expect(s.reconcileList).not.toHaveBeenCalled()
      model.rendering.set(false)
      expect(s.reconcileList).toHaveBeenCalledTimes(1)
   })

   it("chains the search bar's re-sync after a rebuild, and reports a failed one", async () => {
      const s = fakes()
      effects.registerEffects(s)
      s.reconcileList.mockReturnValueOnce(Promise.resolve())
      model.laneTokens.set(["q:x"])
      await tick()
      expect(s.afterListBuild).toHaveBeenCalledTimes(1)
      const boom = new Error("pack 404")
      s.reconcileList.mockReturnValueOnce(Promise.reject(boom))
      model.laneTokens.set(["q:xy"])
      await tick()
      expect(s.onListError).toHaveBeenCalledWith(boom)
   })
})

describe("listRows", () => {
   const splitLive = () =>
      signals.batch(() => {
         model.split.set(true)
         model.readerPainted.set(true)
         model.cursor.set({ chron: 1, feedId: 1 })
      })

   it("re-derives the rows of a mounted list when seen or saved moves", () => {
      const s = fakes()
      effects.registerEffects(s)
      s.refreshListRows.mockClear()
      model.seen.set({ "feed:1": 2 })
      model.saved.set([4])
      expect(s.refreshListRows).toHaveBeenCalledTimes(2)
      model.focus.set("reader") // hidden behind the single-surface reader
      model.seen.set({ "feed:1": 3 })
      expect(s.refreshListRows).toHaveBeenCalledTimes(2)
   })

   it("brings the split pane's cursor row along after a reader-side step, once", () => {
      const s = fakes()
      effects.registerEffects(s)
      splitLive()
      s.followListCursor.mockClear()
      s.refreshListRows.mockClear()
      model.rendering.set(true)
      model.cursor.set({ chron: 2, feedId: 1 })
      model.seen.set({ "feed:1": 2 })
      model.rendering.set(false)
      expect(s.followListCursor).toHaveBeenCalledTimes(1)
      expect(s.refreshListRows).not.toHaveBeenCalled()
   })

   // Discriminates deferred()'s rewrite (D4/task-9): registration itself now
   // happens under app.ts's boot hold, so this effect's very first run sees
   // model.rendering() already true and must freeze its PRE-hold baseline
   // (cursor -1, not live) rather than treat the held state as unprimed. A
   // version that reverted to signals.ts's plain diffedForEffects (whose skip
   // bails before ever touching `last`) would hand this body `prev: null` on
   // release, read that as "nothing moved", and call refreshListRows instead —
   // silently leaving the split pane unbuilt for a #pos deep link that lands
   // entirely inside a held boot (see split.e2e.test.ts's "builds the list pane
   // beside a #pos deep link", the regression this pins at the unit level).
   // model.split is set BEFORE the hold, mirroring app.ts's real order
   // (initSplit() resolves the breakpoint before registerEffects' boot hold
   // begins) — task 10's split-consistency check (prev[1] === split) means a
   // hold that also flips split reads as a crossing, not a #pos landing, and
   // takes the refreshListRows branch, which relayoutPane's own follow covers.
   it("keeps its PRE-hold baseline across a boot hold, so a landing that starts and ends held still reads as moved", () => {
      const s = fakes()
      model.split.set(true) // resolved before the boot hold, as app.ts's init() does
      model.rendering.set(true) // app.ts's boot hold, held before the table registers
      effects.registerEffects(s)
      signals.batch(() => {
         model.readerPainted.set(true)
         model.cursor.set({ chron: 1, feedId: 1 })
      }) // the #pos landing's own writes — still inside the same hold
      model.rendering.set(false) // the boot hold releases once the landing settles
      expect(s.followListCursor).toHaveBeenCalledTimes(1)
      expect(s.refreshListRows).not.toHaveBeenCalled()
   })

   it("a cursor the list itself moved repaints nothing (selectRow already did)", () => {
      const s = fakes()
      effects.registerEffects(s)
      s.refreshListRows.mockClear()
      model.cursor.set({ chron: 4, feedId: 1 }) // list focus, no live reader
      expect(s.refreshListRows).not.toHaveBeenCalled()
      expect(s.followListCursor).not.toHaveBeenCalled()
   })

   it("a crossing into split refreshes the rows and leaves the follow to the re-layout tail", () => {
      const s = fakes()
      effects.registerEffects(s)
      signals.batch(() => {
         model.readerPainted.set(true)
         model.cursor.set({ chron: 2, feedId: 1 })
      })
      s.refreshListRows.mockClear()
      model.split.set(true) // readerLive turns true on the crossing itself
      expect(s.followListCursor).not.toHaveBeenCalled()
      expect(s.refreshListRows).toHaveBeenCalledTimes(1)
   })
})

describe("listGrowth", () => {
   it("reopens a mounted list's top once per adopted snapshot", () => {
      const s = fakes()
      effects.registerEffects(s)
      expect(s.listGrown).not.toHaveBeenCalled() // registration is not a refresh
      model.snapshot.update((n) => n + 1)
      expect(s.listGrown).toHaveBeenCalledTimes(1)
      model.focus.set("reader") // a layout change is not a new snapshot
      model.focus.set("list")
      expect(s.listGrown).toHaveBeenCalledTimes(1)
   })
})

describe("pickerRows", () => {
   it("repaints an OPEN picker when anything its rows count moves", () => {
      const s = fakes()
      effects.registerEffects(s)
      model.seen.set({ "feed:1": 1 })
      expect(s.renderPicker).not.toHaveBeenCalled() // closed
      s.pickerOpen.mockReturnValue(true)
      model.unreadOnly.set(true)
      model.mountsRev.update((n) => n + 1)
      expect(s.renderPicker).toHaveBeenCalledTimes(2)
      model.cursor.set({ chron: 3, feedId: 1 })
      expect(s.renderPicker).toHaveBeenCalledTimes(2)
   })
})

// The spec's regression guard: one batched navigation write costs each effect
// that depends on it exactly one run, and every other effect none. A future
// effect that reads a signal it should not shows up here as a count.
describe("one landing, one run each", () => {
   it("a guarded landing runs exactly the effects its writes feed, once each", async () => {
      const s = fakes()
      const fx = effects.registerEffects(s)
      s.pickerOpen.mockReturnValue(true)
      signals.batch(() => {
         model.split.set(true)
         model.focus.set("reader")
         model.readerPainted.set(true)
         model.cursor.set({ chron: 1, feedId: 1 })
         model.laneTokens.set(["news"])
      })
      await tick()
      for (const fake of Object.values(s)) fake.mockClear()

      // What nav.resolve + guard() do for one landing (D3).
      model.rendering.set(true)
      signals.batch(() => {
         model.cursor.set({ chron: 2, feedId: 1 })
         model.seen.set({ "feed:1": 2 })
      })
      fx.markChromePainted()
      model.rendering.set(false)
      await tick()

      expect(s.unreadTotal).toHaveBeenCalledTimes(1) // seen moved
      expect(s.paintSaveButton).toHaveBeenCalledTimes(1) // cursor moved
      expect(s.followListCursor).toHaveBeenCalledTimes(1) // split + live + moved
      expect(s.renderPicker).toHaveBeenCalledTimes(1) // seen moved, picker open
      expect(s.probeChrome).not.toHaveBeenCalled() // render painted it
      expect(s.applyChrome).not.toHaveBeenCalled()
      expect(s.refreshListRows).not.toHaveBeenCalled()
      expect(s.reconcileList).not.toHaveBeenCalled()
      expect(s.listGrown).not.toHaveBeenCalled()
      expect(s.setListTitle).not.toHaveBeenCalled()
      expect(s.paintFeedLabel).not.toHaveBeenCalled()
      expect(s.restingState).not.toHaveBeenCalled()
      expect(s.refreshSettingsStatus).not.toHaveBeenCalled()
      expect(s.applyUnreadTotal).not.toHaveBeenCalled() // the tally came back equal
   })
})

describe("a surface that throws", () => {
   it("is reported, and neither the flush nor the writer sees the error", () => {
      const s = fakes()
      s.paintFeedLabel.mockImplementation(() => {
         throw new Error("paint broke")
      })
      effects.registerEffects(s) // the first run throws too
      s.onPaintError.mockClear()
      expect(() => model.laneTokens.set(["news"])).not.toThrow()
      expect(s.onPaintError).toHaveBeenCalledExactlyOnceWith(new Error("paint broke"))
      expect(s.reconcileList).toHaveBeenCalled() // later effects in the same flush still ran
   })
})
