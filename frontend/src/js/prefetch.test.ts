import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// data.ts fires a db.gz fetch at module load, so it is mocked (the house
// pattern); fmt is the REAL module, because what this suite pins is which URLs
// the prefetch ends up assigning — the ones fmt's routing lets through.
const data = vi.hoisted(() => ({
   loadArticle: vi.fn(),
   activeStore: () => ({ mid: "0", base: new URL("http://localhost:3000/") }),
}))
vi.mock("./data", () => data)

import { abortPrefetch, schedulePrefetch } from "./prefetch"

describe("schedulePrefetch", () => {
   let assigned: string[]

   beforeEach(() => {
      assigned = []
      // Every src the prefetch hands an Image or a <video> — what the browser
      // would fetch, before the user has opened the article.
      for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype])
         vi.spyOn(proto, "src", "set").mockImplementation((v: string) => void assigned.push(v))
      vi.stubGlobal("requestIdleCallback", (run: () => void) => {
         run()
         return 0
      })
   })

   afterEach(() => {
      abortPrefetch()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
   })

   it("warms the neighbour's asset key and never a same-origin path a crafted ref spells", async () => {
      // The self-hosted base is the origin root, which the admin API shares.
      const key = "assets/ab/0123456789abcdef.jpg"
      data.loadArticle.mockResolvedValue({
         c:
            '<img src="assets/../api/preview?url=x&ingest=y"><img src="/api/overview">' +
            '<video poster="api/preview" src="assets/ab/../../api/x"></video>' +
            `<img src="${key}">`,
      })
      schedulePrefetch(7)
      await vi.waitFor(() => expect(assigned.length).toBeGreaterThan(0))
      expect(data.loadArticle).toHaveBeenCalledWith(7)
      expect(assigned).toEqual(["http://localhost:3000/" + key])
   })
})
