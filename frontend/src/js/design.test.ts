// design.test.ts — unit coverage for the harness control panel's pure logic.
import { beforeEach, describe, expect, it } from "vitest"

import { stateHash, forceTransient, clearTransients, TRANSIENTS } from "./design"

// A minimal stand-in for the real skeleton: just the nodes the forcers touch.
function seedSkeleton() {
   document.body.innerHTML = `
      <div class="srr-popup"><span class="srr-popup-text"></span></div>
      <article class="srr-reader"><div class="srr-content"></div><nav class="srr-readon"></nav></article>
      <div class="srr-list"></div>
      <nav class="srr-toolbar">
         <button class="srr-prev"></button><button class="srr-next"></button>
      </nav>`
}

describe("stateHash", () => {
   it("maps named states to hashes", () => {
      expect(stateHash({ kind: "list" })).toBe("#")
      expect(stateHash({ kind: "saved" })).toBe("#!~saved")
      expect(stateHash({ kind: "filter", token: "tech" })).toBe("#!tech")
      expect(stateHash({ kind: "search", query: "climate" })).toBe("#!q%3Aclimate")
      expect(stateHash({ kind: "reader", pos: 12 })).toBe("#12")
      expect(stateHash({ kind: "reader", pos: 12, token: "tech" })).toBe("#12!tech")
   })
})

describe("forceTransient / clearTransients", () => {
   beforeEach(seedSkeleton)

   it("opens the error popup", () => {
      forceTransient("error", document)
      expect(document.querySelector(".srr-popup")!.classList.contains("srr-open")).toBe(true)
      expect(document.querySelector(".srr-popup-text")!.textContent).not.toBe("")
   })

   it("pulses the reader left edge bell", () => {
      forceTransient("bell-left", document)
      const r = document.querySelector(".srr-reader")!
      expect(r.classList.contains("srr-bell-left")).toBe(true)
      expect(document.querySelector(".srr-prev")!.classList.contains("srr-edge-pulse")).toBe(true)
   })

   it("clearTransients removes every forced class", () => {
      for (const t of TRANSIENTS) forceTransient(t.id, document)
      clearTransients(document)
      expect(document.querySelector(".srr-popup")!.classList.contains("srr-open")).toBe(false)
      expect(document.querySelector(".srr-reader")!.classList.contains("srr-bell-left")).toBe(false)
   })
})
