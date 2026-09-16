import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The ★-Saved asset pinning (pin-ui.initSavedAssets, an effect over model.saved)
// against the REAL saved.ts: which publishes of the saved set are saves made on
// this device — and so pinned — and which only replace the set a store, a merge
// or another tab owns. Each case gets a fresh registry (model, signals, saved,
// pin-ui share one instance); the effects a case creates are disposed after it,
// because the SW controller they post to is a global.
const state = vi.hoisted(() => ({ mid: "0" }))
const base = (mid: string) => new URL(mid === "0" ? "http://localhost/" : `http://localhost/${mid}/`)
const loadArticle = vi.hoisted(() =>
   vi.fn<(chron: number) => Promise<IArticle>>(async () => ({ f: 1, a: 0, p: 0, c: "" }) as IArticle),
)
vi.mock("./data", () => ({
   activeStore: () => ({ mid: state.mid, base: base(state.mid) }),
   loadArticle,
}))
// nav.isSaved reads the ACTIVE store's set, exactly as the real re-export does.
vi.mock("./nav", async () => {
   const { readIdSet } = await import("./storage")
   const { savedKey } = await import("./keys")
   return { SAVED_TOKEN: "~saved", isSaved: (c: number) => readIdSet(savedKey(state.mid)).has(c) }
})
vi.mock("./sync", () => ({ pushSoon: vi.fn() }))
vi.mock("./mounts", () => ({ forgetStoreState: vi.fn() }))
const KEYS = ["assets/ab/0123456789abcdef.jpg", "assets/cd/fedcba9876543210.mp4"]
const extractAssetKeys = vi.hoisted(() => vi.fn<(content: string) => string[]>(() => []))
vi.mock("./fmt", () => ({ extractAssetKeys }))

const post = vi.fn()
const pins = () => post.mock.calls.filter(([m]) => m.type === "pin").map(([m]) => m)
const tick = () => new Promise((r) => setTimeout(r))
const ctx = { savedMode: false, pos: -1, onQueueChange: () => {} }
const stops: Array<() => void> = []

let model: typeof import("./model")
let signals: typeof import("./signals")
let saved: typeof import("./saved")
let pinUI: typeof import("./pin-ui")

// Boot the way app.ts does: saved.ts's module-scope subscriptions exist first,
// then whatever app.ts wires before the pin effect (`before` — menus.setup's
// mount-merge subscription is created there), the first publish lands, and the
// pin effect registers last.
async function load(active = "0", before?: () => void) {
   vi.resetModules()
   model = await import("./model")
   signals = await import("./signals")
   saved = await import("./saved")
   pinUI = await import("./pin-ui")
   state.mid = active
   model.activeMid.set(active)
   before?.()
   saved.publishSaved()
   stops.push(pinUI.initSavedAssets())
}

beforeEach(() => {
   localStorage.clear()
   state.mid = "0"
   loadArticle.mockReset()
   loadArticle.mockImplementation(async () => ({ f: 1, a: 0, p: 0, c: "" }))
   post.mockReset()
   extractAssetKeys.mockReset()
   extractAssetKeys.mockReturnValue(["assets/aa/0123456789abcdef.png"])
   Object.defineProperty(navigator, "serviceWorker", {
      value: { controller: { postMessage: post } },
      configurable: true,
   })
})
afterEach(() => {
   for (const stop of stops.splice(0)) stop()
})

describe("★-Saved asset pinning", () => {
   it("records the pinned scope under the save's store", async () => {
      extractAssetKeys.mockReturnValue(KEYS)
      await load()
      saved.toggleSaved(77, ctx)
      await tick()
      const { listPins } = await import("./pin")
      expect(listPins().get("~saved:77")?.names).toEqual(KEYS)
   })

   // The un-save path is synchronous, so a star tapped twice over a COLD pack
   // runs it to completion inside the save's await — before there is any
   // registry entry to release. Pinning anyway would leave an un-saved article's
   // media in the eviction-exempt PINNED bucket with a registry entry nothing
   // ever clears.
   it("pins nothing when the star is un-tapped while the pack is still loading", async () => {
      extractAssetKeys.mockReturnValue(KEYS)
      await load()
      let release!: () => void
      loadArticle.mockImplementationOnce(async () => {
         await new Promise<void>((r) => (release = r))
         return { f: 1, a: 0, p: 0, c: "" }
      })
      saved.toggleSaved(77, ctx)
      saved.toggleSaved(77, ctx)
      release()
      await tick()
      const { listPins } = await import("./pin")
      expect(pins()).toEqual([])
      expect(listPins().has("~saved:77")).toBe(false)
   })

   it("releases an un-saved article's assets — but only what nothing else still shows", async () => {
      localStorage.setItem("srr-saved", JSON.stringify([77, 88]))
      const { listPins, pinFilter } = await import("./pin")
      pinFilter("~saved:77", KEYS)
      pinFilter("~saved:88", [KEYS[0]]) // another saved article shares the image
      await load()
      saved.toggleSaved(77, ctx)
      await tick()
      expect(post.mock.calls.map(([m]) => m)).toEqual([{ type: "unpin", names: [KEYS[1]], base: "http://localhost/" }])
      expect(listPins().has("~saved:77")).toBe(false)
   })

   it("says nothing for an article with no self-hosted media", async () => {
      extractAssetKeys.mockReturnValue([])
      await load()
      saved.toggleSaved(77, ctx)
      await tick()
      const { listPins } = await import("./pin")
      expect(post).not.toHaveBeenCalled()
      expect(listPins().size).toBe(0)
   })

   it("is a silent no-op with no SW controller (dev / insecure context)", async () => {
      Object.defineProperty(navigator, "serviceWorker", { value: { controller: null }, configurable: true })
      extractAssetKeys.mockReturnValue(KEYS)
      await load()
      saved.toggleSaved(77, ctx)
      await tick()
      // Nothing to pin into, so nothing is claimed in the registry either.
      const { listPins } = await import("./pin")
      expect(listPins().size).toBe(0)
   })

   it("pins a save made here once", async () => {
      await load()
      saved.toggleSaved(5, ctx)
      await tick()
      expect(loadArticle.mock.calls).toEqual([[5]])
      expect(pins()).toEqual([{ type: "pin", names: ["assets/aa/0123456789abcdef.png"], base: "http://localhost/" }])
   })

   // Another tab's star taps (and its sync merges) reach this tab as a
   // storage event. They are not saves made here: the tab that made them pinned
   // them (or deliberately did not, for a merge).
   it("does not pin again what another tab saved", async () => {
      localStorage.setItem("srr-saved", JSON.stringify([1]))
      await load()
      localStorage.setItem("srr-saved", JSON.stringify(Array.from({ length: 40 }, (_, i) => i + 1)))
      window.dispatchEvent(new StorageEvent("storage", { key: "srr-saved" }))
      await tick()
      expect(model.saved()).toHaveLength(40) // the set did follow the other tab
      expect(loadArticle).not.toHaveBeenCalled()
      expect(pins()).toEqual([])
   })

   it("does not pin another tab's saves that follow a save made here", async () => {
      await load()
      saved.toggleSaved(1, ctx)
      localStorage.setItem("srr-saved", JSON.stringify([1, 2, 3]))
      window.dispatchEvent(new StorageEvent("storage", { key: "srr-saved" }))
      await tick()
      expect(loadArticle.mock.calls).toEqual([[1]])
   })

   it("still pins a local save after another tab's write", async () => {
      await load()
      localStorage.setItem("srr-saved", JSON.stringify([1, 2]))
      window.dispatchEvent(new StorageEvent("storage", { key: "srr-saved" }))
      saved.toggleSaved(7, ctx)
      await tick()
      expect(loadArticle.mock.calls).toEqual([[7]])
   })

   // A merge that unmounts the ACTIVE store switches stores in a later
   // flush pass than saved.ts's republish for the merge, so the pin effect sees
   // (new store, old store's set) and then (new store, new store's set).
   it("pins nothing when a merge drops the active store and the home set replaces it", async () => {
      localStorage.setItem("srr-saved@s7", JSON.stringify([1, 2]))
      localStorage.setItem("srr-saved", JSON.stringify([10, 20]))
      // menus.setup()'s subscription (created before the pin effect, as in
      // app.ts), as afterMountChange behaves when the merged table dropped the
      // active mount: data.setActive(home).
      await load("s7", () =>
         stops.push(
            signals.onChange(
               () => model.profileMountsRev(),
               () => {
                  state.mid = "0"
                  model.activeMid.set("0")
               },
            ),
         ),
      )
      expect(model.saved()).toEqual([1, 2])
      signals.batch(() => {
         model.profileRev.update((n) => n + 1)
         model.profileMountsRev.update((n) => n + 1)
      })
      await tick()
      expect(model.saved()).toEqual([10, 20])
      expect(loadArticle).not.toHaveBeenCalled()
      expect(pins()).toEqual([])
   })

   // The re-check after the article load asks the store the save was made in,
   // not whichever store is active by the time the load lands.
   it("still pins a save whose article loads after a store switch", async () => {
      await load()
      let release!: () => void
      loadArticle.mockImplementationOnce(async () => {
         await new Promise<void>((r) => (release = r))
         return { f: 1, a: 0, p: 0, c: "" }
      })
      saved.toggleSaved(5, ctx)
      state.mid = "s7" // nothing is saved in s7
      model.activeMid.set("s7")
      release()
      await tick()
      expect(pins()).toEqual([{ type: "pin", names: ["assets/aa/0123456789abcdef.png"], base: "http://localhost/" }])
   })

   it("does not pin a save undone before its article loaded, even where the next store saved that chron", async () => {
      localStorage.setItem("srr-saved@s7", JSON.stringify([5]))
      await load()
      let release!: () => void
      loadArticle.mockImplementationOnce(async () => {
         await new Promise<void>((r) => (release = r))
         return { f: 1, a: 0, p: 0, c: "" }
      })
      saved.toggleSaved(5, ctx) // save…
      saved.toggleSaved(5, ctx) // …and un-save while the load is out
      state.mid = "s7"
      model.activeMid.set("s7")
      release()
      await tick()
      expect(pins()).toEqual([])
   })
})
