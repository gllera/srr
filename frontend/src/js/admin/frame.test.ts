import { describe, expect, it } from "vitest"

import { refuseIfFramed } from "./frame"

// The admin page drives a mutating API with the operator's session, so it must
// not run inside someone else's frame (clickjacking). A reverse proxy can say so
// with frame-ancestors, but a <meta> CSP cannot, and `srr frontend update`
// installs admin.html on any static host — so the page refuses on its own.
describe("refuseIfFramed", () => {
   it("lets a top-level page run", () => {
      const self = {} as Window
      ;(self as { top: Window }).top = self
      expect(refuseIfFramed(self, document.createElement("body"))).toBe(false)
   })

   it("refuses inside a frame and says why", () => {
      const body = document.createElement("body")
      body.innerHTML = "<main>console</main>"
      const framed = { top: {} as Window } as Window
      expect(refuseIfFramed(framed, body)).toBe(true)
      expect(body.textContent).toContain("frame")
      expect(body.querySelector("main")).toBeNull()
   })

   it("treats an unreadable top (cross-origin access throws) as framed", () => {
      const framed = {} as Window
      Object.defineProperty(framed, "top", {
         get() {
            throw new Error("SecurityError")
         },
      })
      expect(refuseIfFramed(framed, document.createElement("body"))).toBe(true)
   })
})
