import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Another tab's seen writes reach this tab as `storage` events, and every
// republish of model.seen re-runs the unread tally, the reader-chrome probe and
// the list's row pass. A hidden tab paints none of that, so it republishes once
// when it becomes visible instead of once per event; a visible tab keeps
// following each write as it lands.
vi.mock("./data", () => ({ activeStore: () => ({ mid: "0" }), db: { feeds: {} } }))
vi.mock("./sync", () => ({ pushSoon: vi.fn() }))

let hidden = false
const stops: Array<() => void> = []
let model: typeof import("./model")
let publishes = 0

const write = (seen: Record<string, number>) => {
   localStorage.setItem("srr-seen", JSON.stringify(seen))
   window.dispatchEvent(new StorageEvent("storage", { key: "srr-seen" }))
}
const setHidden = (v: boolean) => {
   hidden = v
   document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(async () => {
   localStorage.clear()
   hidden = false
   Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
   vi.resetModules()
   model = await import("./model")
   const signals = await import("./signals")
   await import("./seen")
   publishes = 0
   stops.push(
      signals.onChange(
         () => model.seen(),
         () => void publishes++,
      ),
   )
})
afterEach(() => {
   for (const stop of stops.splice(0)) stop()
})

describe("seen map — another tab's writes", () => {
   it("republish at once while this tab is visible", () => {
      write({ "feed:1": 1 })
      write({ "feed:1": 2 })
      expect(publishes).toBe(2)
      expect(model.seen()).toEqual({ "feed:1": 2 })
   })

   it("wait while this tab is hidden, then republish once on becoming visible", () => {
      setHidden(true)
      for (let i = 1; i <= 10; i++) write({ "feed:1": i })
      expect(publishes).toBe(0)
      setHidden(false)
      expect(publishes).toBe(1)
      expect(model.seen()).toEqual({ "feed:1": 10 })
   })

   it("a hidden tab that saw no write republishes nothing on becoming visible", () => {
      setHidden(true)
      setHidden(false)
      expect(publishes).toBe(0)
   })

   it("a write for another store's key is not this store's", () => {
      localStorage.setItem("srr-seen@s7", JSON.stringify({ "feed:1": 4 }))
      window.dispatchEvent(new StorageEvent("storage", { key: "srr-seen@s7" }))
      setHidden(true)
      setHidden(false)
      expect(publishes).toBe(0)
   })
})
