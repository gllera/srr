import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// data.ts fires a db.gz fetch at module load, so it is mocked (the house
// pattern); fmt is the REAL module, because what this suite pins is which URLs
// the prefetch ends up assigning — the ones fmt's routing lets through.
const data = vi.hoisted(() => ({
   loadArticle: vi.fn(),
   activeStore: vi.fn(),
}))
vi.mock("./data", () => data)

const KEY = "assets/ab/0123456789abcdef.jpg"

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
      const home = { mid: "0", base: new URL("http://localhost:3000/") }
      data.activeStore.mockReturnValue(home)
      data.loadArticle.mockResolvedValue({
         c:
            '<img src="assets/../api/preview?url=x&ingest=y"><img src="/api/overview">' +
            '<video poster="api/preview" src="assets/ab/../../api/x"></video>' +
            `<img src="${KEY}">`,
      })
      schedulePrefetch(7)
      await vi.waitFor(() => expect(assigned.length).toBeGreaterThan(0))
      expect(data.loadArticle).toHaveBeenCalledWith(7, home)
      expect(assigned).toEqual(["http://localhost:3000/" + KEY])
   })

   it("resolves a peer article's key against the peer's base, never the home one", async () => {
      // A base other than PACK_BASE, the home base fmt falls back to: a prefetch
      // that stopped passing the active store's base would warm the home URL
      // (docs/MULTI-STORE-SPEC.md MS7).
      const peer = "https://peer.example/store/"
      data.activeStore.mockReturnValue({ mid: "1", base: new URL(peer) })
      data.loadArticle.mockResolvedValue({ c: `<img src="${KEY}">` })
      schedulePrefetch(3)
      await vi.waitFor(() => expect(assigned.length).toBeGreaterThan(0))
      expect(assigned).toEqual([peer + KEY])
   })

   it("never warms the page's own server from a peer article, however the ref is spelled", async () => {
      // The page (jsdom's location) is where the admin API lives, and a peer's
      // base is another origin: being cross-origin to the ARTICLE'S base does not
      // make a ref to the page safe.
      expect(location.origin).toBe("http://localhost:3000")
      const peer = "https://peer.example/store/"
      data.activeStore.mockReturnValue({ mid: "1", base: new URL(peer) })
      data.loadArticle.mockResolvedValue({
         c:
            '<img src="http://localhost:3000/api/preview?url=x&amp;ingest=y"><img src="https:/api/x">' +
            '<img src="HTTP:/api/x"><video src="https://localhost:3000/api/v"></video>' +
            `<img src="${KEY}">`,
      })
      schedulePrefetch(5)
      await vi.waitFor(() => expect(assigned.length).toBeGreaterThan(0))
      expect(assigned).toEqual([peer + KEY])
   })

   // The prefetch runs on an idle callback and awaits the article, so the active
   // lane can move under it. The article it warms belongs to the store that was
   // active when it was SCHEDULED (the landing's neighbour), and its media are
   // that store's content: routed against the new lane's base instead, a home
   // key is warmed on the peer, and a home asset spelled absolutely (home being
   // the page origin) is dropped as a crafted same-origin URL.
   describe("judges the article against the store it was scheduled in, not the lane it lands in", () => {
      const HOME = { mid: "0", base: new URL("http://localhost:3000/") }
      const PEER = { mid: "1", base: new URL("https://peer.example/store/") }
      const CONTENT = `<img src="${KEY}"><video src="http://localhost:3000/${KEY.replace(".jpg", ".mp4")}"></video>`
      const WANT = ["http://localhost:3000/" + KEY, "http://localhost:3000/" + KEY.replace(".jpg", ".mp4")]

      it("when the lane changes while the article loads", async () => {
         data.activeStore.mockReturnValue(HOME)
         let land!: (a: { c: string }) => void
         data.loadArticle.mockReturnValue(new Promise((r) => (land = r)))
         schedulePrefetch(9)
         await vi.waitFor(() => expect(data.loadArticle).toHaveBeenCalled())
         data.activeStore.mockReturnValue(PEER)
         land({ c: CONTENT })
         await vi.waitFor(() => expect(assigned.length).toBeGreaterThan(0))
         expect(assigned).toEqual(WANT)
      })

      it("when the lane changes before the idle callback runs", async () => {
         let idle!: () => void
         vi.stubGlobal("requestIdleCallback", (run: () => void) => {
            idle = run
            return 0
         })
         data.activeStore.mockReturnValue(HOME)
         data.loadArticle.mockResolvedValue({ c: CONTENT })
         schedulePrefetch(9)
         data.activeStore.mockReturnValue(PEER)
         idle()
         await vi.waitFor(() => expect(assigned.length).toBeGreaterThan(0))
         // The scheduling store's article, not the peer's chron 9.
         expect(data.loadArticle).toHaveBeenCalledWith(9, HOME)
         expect(assigned).toEqual(WANT)
      })
   })
})
