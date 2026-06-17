// design.test.ts — unit coverage for the harness control panel's pure logic.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { beforeEach, describe, expect, it } from "vitest"

import { stateHash, forceTransient, clearTransients, TRANSIENTS, buildPanel } from "./design"

// A minimal stand-in for the real skeleton: just the nodes the forcers touch.
function seedSkeleton() {
   document.body.innerHTML = `
      <div class="srr-popup"><span class="srr-popup-text"></span></div>
      <article class="srr-reader"><div class="srr-content"></div></article>
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

describe("skeleton drift guard", () => {
   const SRC = join(dirname(fileURLToPath(import.meta.url)), "..") // frontend/src

   // The harness boots the REAL app, which needs index.html's exact .srr-* DOM,
   // so design.html must embed the same skeleton. Compare the marked regions
   // whitespace-insensitively: prettier wraps inline <p> text differently
   // between the two files, but any added/removed/renamed element or attribute
   // still trips this guard. If it fails, re-sync design.html's skeleton region.
   function skeleton(file: string): string {
      const html = readFileSync(join(SRC, file), "utf8")
      const start = html.indexOf("<!-- srr:skeleton:start -->")
      const end = html.indexOf("<!-- srr:skeleton:end -->")
      if (start < 0 || end < 0) throw new Error(`${file}: skeleton markers missing`)
      return html.slice(start, end).replace(/\s+/g, "")
   }

   it("design.html embeds index.html's skeleton (structure)", () => {
      expect(skeleton("design.html")).toBe(skeleton("index.html"))
   })
})

describe("buildPanel", () => {
   it("always renders the surface + transient + theme groups", () => {
      const panel = buildPanel({})
      const titles = [...panel.querySelectorAll(".srr-design-group-title")].map((e) => e.textContent)
      expect(titles).toEqual(["Surfaces", "Curated states", "Transient", "Theme"])
      // No targets → curated shows only its title + the run-fixture note.
      expect(panel.querySelector(".srr-design-note")!.textContent).toContain("make design-fixture")
   })

   it("adds curated buttons when targets are present", () => {
      const panel = buildPanel({ sampleTag: "tech", ferrToken: "4", longTitlePos: 9, savedDeletedChron: 3 })
      const labels = [...panel.querySelectorAll(".srr-design-btn")].map((e) => e.textContent)
      expect(labels).toContain("Tag: tech")
      expect(labels).toContain("Feed w/ error")
      expect(labels).toContain("Long title")
      expect(labels).toContain("Saved (deleted feed)")
   })
})
