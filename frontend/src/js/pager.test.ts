import { beforeEach, describe, expect, it, vi } from "vitest"

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

   it("a drag arriving mid-commit is skipped", () => {
      let release!: (v: boolean) => void
      commit.mockReturnValueOnce(new Promise((r) => (release = r)))
      spec.engage("next")
      spec.end(-300, true)
      expect(spec.engage("next")).toBe("skip")
      release(true)
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
