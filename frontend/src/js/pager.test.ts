import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// pager.ts owns the DOM half of the reader pager: the lazily built masthead
// preview pane, the drag transforms on the reader <article>, and the commit
// call. The geometry (axis lock, thresholds) is gestures.ts's and is tested
// there — here the registered spec is driven directly.

const mocks = vi.hoisted(() => ({
   setPager: vi.fn(),
   currentChron: vi.fn(() => 2),
   neighborOlder: vi.fn(async () => 1),
   neighborNewer: vi.fn(async () => 3),
   loadMeta: vi.fn(async () => ({ f: 4, w: 1_700_000_000, t: "Neighbor title" })),
   feedTitle: vi.fn(() => "Feed A"),
}))
vi.mock("./gestures", () => ({ setPager: mocks.setPager }))
vi.mock("./nav", () => ({
   currentChron: mocks.currentChron,
   neighborOlder: mocks.neighborOlder,
   neighborNewer: mocks.neighborNewer,
}))
vi.mock("./data", () => ({ loadMeta: mocks.loadMeta, feedTitle: mocks.feedTitle }))

import type { Pager } from "./gestures"

let pager: typeof import("./pager")
let spec: Pager
let commit: ReturnType<typeof vi.fn>
const article = () => document.querySelector(".srr-reader") as HTMLElement
const pane = () => document.querySelector(".srr-pager-pane") as HTMLElement | null
const nextBtn = () => document.querySelector(".srr-next") as HTMLButtonElement
const flush = () => new Promise((r) => setTimeout(r))

beforeEach(async () => {
   vi.useRealTimers()
   vi.clearAllMocks()
   vi.resetModules()
   // els.ts resolves refs at module load — seed the skeleton first (the
   // dropdown.test.ts precedent).
   document.body.innerHTML =
      `<article class="srr-reader"></article>` + `<button class="srr-prev"></button><button class="srr-next"></button>`
   commit = vi.fn(async () => true)
   pager = await import("./pager")
   pager.setup({ commit })
   spec = mocks.setPager.mock.calls.at(-1)![1] as Pager
})

// The reduced-motion case patches window.matchMedia. Restore it after EVERY
// test rather than relying on that case being last: a leaked patch would run
// every later case under "reduced motion always on" — settling instantly, so
// the settle-timer cases below would pass for the wrong reason with no clue why.
// jsdom defines matchMedia on the prototype, so there is usually no own
// descriptor to put back and deleting the patch is what restores it.
const realMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia")
afterEach(() => {
   if (realMatchMedia) Object.defineProperty(window, "matchMedia", realMatchMedia)
   else Reflect.deleteProperty(window, "matchMedia")
})

describe("engage", () => {
   it("registers on the reader surface", () => {
      expect(mocks.setPager.mock.calls.at(-1)![0]).toBe(article())
   })

   it("pages toward a live neighbor, resists toward a dead one", () => {
      expect(spec.engage("next")).toBe("page")
      nextBtn().disabled = true
      expect(spec.engage("next")).toBe("resist")
   })
})

describe("page mode visuals", () => {
   it("tracks the article and slides the pane in from the correct edge", () => {
      spec.engage("next")
      spec.move(-80)
      expect(article().style.transform).toBe("translateX(-80px)")
      expect(pane()!.classList.contains("srr-pager-show")).toBe(true)
      expect(pane()!.style.transform).toBe("translateX(calc(100% + -80px))")
   })

   it("clamps travel against the engaged direction to zero", () => {
      spec.engage("next")
      spec.move(60) // wrong-direction travel
      expect(article().style.transform).toBe("translateX(0px)")
   })

   it("fills the pane masthead from the neighbor's meta card", async () => {
      spec.engage("next")
      await flush()
      expect(mocks.neighborNewer).toHaveBeenCalledWith(2)
      expect(mocks.loadMeta).toHaveBeenCalledWith(3)
      expect(pane()!.querySelector(".srr-pager-title")!.textContent).toBe("Neighbor title")
      expect(pane()!.querySelector(".srr-pager-source")!.textContent).toBe("Feed A")
      expect(pane()!.dataset.src).toBeDefined()
   })

   it("a cancelled drag orphans its in-flight fill (freshness token)", async () => {
      let release!: (v: { f: number; w: number; t: string }) => void
      mocks.loadMeta.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("next")
      spec.cancel()
      release({ f: 1, w: 1, t: "stale" })
      await flush()
      expect(document.querySelector(".srr-pager-title")?.textContent ?? "").toBe("")
   })

   it("the pane is structurally masthead-only: no media elements, ever", async () => {
      spec.engage("next")
      await flush()
      expect(pane()!.querySelector("audio,video")).toBeNull()
   })
})

describe("resist mode", () => {
   it("damps and caps the drag and never builds a pane", () => {
      nextBtn().disabled = true
      spec.engage("next")
      spec.move(-400)
      expect(article().style.transform).toBe("translateX(-64px)") // 400×0.3 capped at 64
      expect(pane()?.classList.contains("srr-pager-show") ?? false).toBe(false)
   })
})

// Every branch above is the "next" half of a ternary. The prev half is its
// mirror and is currently correct — these cover it so a future transposition
// slip in one of those ternaries can't ship green.
describe("prev direction (the mirrored branches)", () => {
   it("tracks rightward travel and slides the pane in from the left edge", () => {
      spec.engage("prev")
      spec.move(80)
      expect(article().style.transform).toBe("translateX(80px)")
      expect(pane()!.style.transform).toBe("translateX(calc(-100% + 80px))")
      spec.move(-60) // wrong-direction travel, mirrored
      expect(article().style.transform).toBe("translateX(0px)")
   })

   it("probes the OLDER neighbor for the pane fill", async () => {
      spec.engage("prev")
      await flush()
      expect(mocks.neighborOlder).toHaveBeenCalledWith(2)
      expect(mocks.neighborNewer).not.toHaveBeenCalled()
      expect(mocks.loadMeta).toHaveBeenCalledWith(1)
   })

   it("commits outward to the right, then rests", async () => {
      let release!: (v: boolean) => void
      commit.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("prev")
      spec.move(300)
      spec.end(300, true)
      expect(commit).toHaveBeenCalledWith("prev")
      // Mid-flight: the outgoing article leaves toward the right, pane to centre.
      expect(article().style.transform).toBe("translateX(100%)")
      expect(pane()!.style.transform).toBe("translateX(0)")
      release(true)
      await flush()
      expect(article().style.transform).toBe("")
      expect(pane()!.classList.contains("srr-pager-show")).toBe(false)
   })

   it("snaps back toward the left edge it came from", async () => {
      vi.useFakeTimers()
      spec.engage("prev")
      spec.move(80)
      spec.end(80, false)
      expect(pane()!.style.transform).toBe("translateX(-100%)")
      await vi.advanceTimersByTimeAsync(300)
      expect(article().style.transform).toBe("")
      expect(pane()!.classList.contains("srr-pager-show")).toBe(false)
   })
})

describe("commit", () => {
   it("a committed release calls deps.commit with the side and rests on success", async () => {
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true)
      expect(commit).toHaveBeenCalledWith("next")
      await flush()
      expect(article().style.transform).toBe("")
      expect(pane()!.classList.contains("srr-pager-show")).toBe(false)
   })

   it("a refused commit (busy/failed nav) snaps back", async () => {
      commit.mockResolvedValueOnce(false)
      vi.useFakeTimers()
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true)
      await vi.advanceTimersByTimeAsync(300)
      expect(article().style.transform).toBe("")
      expect(pane()!.classList.contains("srr-pager-show")).toBe(false)
   })

   it("an uncommitted release never calls deps.commit", async () => {
      vi.useFakeTimers()
      spec.engage("next")
      spec.move(-80)
      spec.end(-80, false)
      await vi.advanceTimersByTimeAsync(300)
      expect(commit).not.toHaveBeenCalled()
      expect(article().style.transform).toBe("")
   })

   it("a REJECTED commit (cold pack, offline) still settles back to rest", async () => {
      commit.mockRejectedValueOnce(new Error("cold pack"))
      vi.useFakeTimers()
      spec.engage("next")
      spec.move(-300)
      spec.end(-300, true)
      await vi.advanceTimersByTimeAsync(300)
      // guard() owns the error popup; the pane's job is to not leave it over a
      // half-slid surface.
      expect(article().style.transform).toBe("")
      expect(pane()!.classList.contains("srr-pager-show")).toBe(false)
   })

   it("a drag arriving mid-commit is skipped", () => {
      let release!: (v: boolean) => void
      commit.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("next")
      spec.end(-300, true)
      expect(spec.engage("next")).toBe("skip")
      release(true)
   })
})

describe("gesture handoff", () => {
   it("a settle armed by the previous drag never fires into the next one", async () => {
      vi.useFakeTimers()
      // Drag A releases short of the threshold — a 250ms settle is now armed.
      spec.engage("next")
      spec.move(-80)
      spec.end(-80, false)
      await vi.advanceTimersByTimeAsync(100)
      // Drag B starts while that settle is still pending.
      spec.engage("next")
      spec.move(-120)
      // Past drag A's deadline: its rest() must not clear drag B's tracking (or,
      // had B committed, snap the article back mid slide-out).
      await vi.advanceTimersByTimeAsync(200)
      expect(article().style.transform).toBe("translateX(-120px)")
      expect(pane()!.classList.contains("srr-pager-show")).toBe(true)
   })
})

describe("reduced motion", () => {
   it("settles instantly — no transition style is left behind", () => {
      const mm = vi.fn(() => ({ matches: true }) as MediaQueryList)
      Object.defineProperty(window, "matchMedia", { value: mm, configurable: true })
      spec.engage("next")
      spec.move(-80)
      spec.end(-80, false)
      expect(article().style.transform).toBe("")
      expect(article().style.transition).toBe("")
   })
})
