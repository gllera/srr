import { describe, it, expect, beforeEach, vi } from "vitest"

// fmt.ts's relative-URL bounds check (resolvePackRelative) only bites when the
// pack base is a SUBPATH: against the root base used in fmt.test.ts a "../" ref
// normalizes back to the origin root and stays in-bounds. Here we mock ./base
// with a deep subpath so the off-base drop (a credentialed-GET info-leak vector)
// is actually exercised. Dynamic import after vi.mock so fmt binds the mocked base.
const SUB = "http://localhost:3000/srr/feed/"
vi.mock("./base", () => ({ PACK_BASE: new URL(SUB) }))

type Fmt = typeof import("./fmt")
let sanitizeHtml: Fmt["sanitizeHtml"]
let extractPrefetchMedia: Fmt["extractPrefetchMedia"]

const attr = (html: string, sel: string, name: string): string | null => {
   const t = document.createElement("template")
   t.innerHTML = sanitizeHtml(html)
   return t.content.querySelector(sel)!.getAttribute(name)
}

beforeEach(async () => {
   localStorage.clear()
   vi.resetModules()
   ;({ sanitizeHtml, extractPrefetchMedia } = await import("./fmt"))
})

describe("sanitizeHtml relative URL bounds (subpath pack base)", () => {
   it("keeps a same-subtree relative ref", () => {
      expect(attr('<img src="assets/ab/cd.jpg">', "img", "src")).toBe(SUB + "assets/ab/cd.jpg")
   })

   it("keeps a ref that resolves to exactly the base root", () => {
      // "." resolves to the base directory itself — on the boundary, still in-bounds.
      expect(attr('<a href=".">x</a>', "a", "href")).toBe(SUB)
   })

   it("drops a ../ traversal that escapes the pack subtree (img src)", () => {
      // resolves to http://localhost:3000/secret.jpg — off the /srr/feed/ subtree.
      expect(attr('<img src="../../secret.jpg">', "img", "src")).toBeNull()
   })

   it("drops an assets/../../ traversal (the case the doc comment names)", () => {
      expect(attr('<img src="assets/../../../secret.jpg">', "img", "src")).toBeNull()
   })

   it("drops a ../ traversal on an anchor href (off-subtree navigation/asset)", () => {
      expect(attr('<a href="../../../etc/passwd">x</a>', "a", "href")).toBeNull()
   })

   it("drops a sibling-directory ref that only shares a string prefix, not a path segment", () => {
      // "../feed-evil/x" resolves to .../srr/feed-evil/x — startsWith(".../srr/feed/")
      // is false, so the prefix-string check must reject the sibling dir.
      expect(attr('<img src="../feed-evil/x.jpg">', "img", "src")).toBeNull()
   })

   it("still drops a protocol-relative foreign-origin ref under a subpath base", () => {
      expect(attr('<img src="//evil.example/x.jpg">', "img", "src")).toBeNull()
   })

   it("drops a ../ traversal on a video poster too (poster takes the asset/bounds path)", () => {
      expect(attr('<video poster="../../p.jpg"></video>', "video", "poster")).toBeNull()
   })

   it("drops a ../ traversal on an audio src too (audio takes the asset/bounds path)", () => {
      expect(attr('<audio src="../../clip.mp3"></audio>', "audio", "src")).toBeNull()
   })
})

describe("extractPrefetchMedia relative URL bounds (subpath pack base)", () => {
   it("resolves in-subtree refs and drops escaping ones, per media list", () => {
      const html =
         '<img src="assets/ab/cd.webp"><img src="../../secret.jpg">' +
         '<video poster="../../p.jpg" src="assets/ab/cd.webm"></video><video src="//evil.example/v.mp4"></video>'
      expect(extractPrefetchMedia(html)).toEqual({
         images: [SUB + "assets/ab/cd.webp"],
         videos: [SUB + "assets/ab/cd.webm"],
      })
   })
})
