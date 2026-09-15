import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { deriveLayout, initLayout, layout, type LayoutHosts } from "./layout"
import * as model from "./model"

// One file, one registry: no resetModules here, so this suite and layout.ts share
// ONE model instance — which is why every case resets the five inputs first.
function resetInputs(): void {
   model.split.set(false)
   model.focus.set("list")
   model.paneHidden.set(false)
   model.readerPainted.set(false)
   model.cursor.set({ chron: -1, feedId: -1 })
}

const DERIVED = ["listMounted", "listShown", "readerMounted", "readerLive", "readerSteppable", "listKeys"] as const
const T = true
const F = false

// [split, focus, paneHidden, readerPainted, cursorChron, DERIVED as 0/1 in order].
// Written out, not computed: a table generated from the formulas layout.ts uses
// would agree with whatever those formulas say.
const TABLE: Array<[boolean, model.Focus, boolean, boolean, number, string]> = [
   [F, "list", F, F, -1, "110001"],
   [F, "list", F, F, 0, "110001"],
   [F, "list", F, T, -1, "110001"],
   [F, "list", F, T, 0, "110001"],
   [F, "list", T, F, -1, "110001"],
   [F, "list", T, F, 0, "110001"],
   [F, "list", T, T, -1, "110001"],
   [F, "list", T, T, 0, "110001"],
   [F, "reader", F, F, -1, "001010"],
   [F, "reader", F, F, 0, "001010"],
   [F, "reader", F, T, -1, "001010"],
   [F, "reader", F, T, 0, "001110"],
   [F, "reader", T, F, -1, "001010"],
   [F, "reader", T, F, 0, "001010"],
   [F, "reader", T, T, -1, "001010"],
   [F, "reader", T, T, 0, "001110"],
   [T, "list", F, F, -1, "111001"],
   [T, "list", F, F, 0, "111001"],
   [T, "list", F, T, -1, "111001"],
   [T, "list", F, T, 0, "111110"],
   [T, "list", T, F, -1, "101001"],
   [T, "list", T, F, 0, "101001"],
   [T, "list", T, T, -1, "101001"],
   [T, "list", T, T, 0, "101110"],
   [T, "reader", F, F, -1, "111010"],
   [T, "reader", F, F, 0, "111010"],
   [T, "reader", F, T, -1, "111010"],
   [T, "reader", F, T, 0, "111110"],
   [T, "reader", T, F, -1, "101010"],
   [T, "reader", T, F, 0, "101010"],
   [T, "reader", T, T, -1, "101010"],
   [T, "reader", T, T, 0, "101110"],
]

describe("deriveLayout — the truth table", () => {
   it("covers all 32 input combinations exactly once", () => {
      expect(TABLE).toHaveLength(32)
      expect(new Set(TABLE.map((r) => r.slice(0, 5).join(","))).size).toBe(32)
   })

   it.each(TABLE)(
      "split=%s focus=%s paneHidden=%s painted=%s cursor=%s → %s",
      (split, focus, paneHidden, readerPainted, cursorChron, bits) => {
         const want: Record<string, unknown> = { split, focus, paneHidden }
         DERIVED.forEach((f, i) => (want[f] = bits[i] === "1"))
         expect(deriveLayout({ split, focus, paneHidden, readerPainted, cursorChron })).toEqual(want)
      },
   )

   it("below the breakpoint exactly one host is mounted", () => {
      for (const [split, focus, paneHidden, readerPainted, cursorChron] of TABLE) {
         if (split) continue
         const l = deriveLayout({ split, focus, paneHidden, readerPainted, cursorChron })
         expect(l.listMounted).toBe(!l.readerMounted)
      }
   })
})

describe("layout() — the record over the model", () => {
   beforeEach(resetInputs)

   it("reads its five inputs from the model", () => {
      model.split.set(true)
      model.focus.set("reader")
      model.paneHidden.set(true)
      model.readerPainted.set(true)
      model.cursor.set({ chron: 4, feedId: 1 })
      expect(layout()).toEqual(
         deriveLayout({ split: true, focus: "reader", paneHidden: true, readerPainted: true, cursorChron: 4 }),
      )
   })
})

describe("initLayout — the one DOM writer", () => {
   let hosts: LayoutHosts
   let dispose: () => void
   const classes = () => [...document.body.classList].sort()

   beforeEach(() => {
      resetInputs()
      document.body.className = ""
      hosts = { listView: document.createElement("div"), article: document.createElement("article") }
      hosts.listView.hidden = true
      hosts.article.hidden = true
      dispose = initLayout(hosts)
   })
   afterEach(() => {
      dispose()
      vi.restoreAllMocks()
   })

   it("stamps the single-surface list on registration", () => {
      expect(classes()).toEqual(["srr-list-shown", "srr-view-list"])
      expect(hosts.listView.hidden).toBe(false)
      expect(hosts.article.hidden).toBe(true)
   })

   it("follows a focus change synchronously", () => {
      model.focus.set("reader")
      expect(classes()).toEqual(["srr-reader-shown"])
      expect(hosts.listView.hidden).toBe(true)
      expect(hosts.article.hidden).toBe(false)
   })

   it("mounts both hosts under split, whichever surface has focus", () => {
      model.split.set(true)
      expect(classes()).toEqual(["srr-list-shown", "srr-reader-shown", "srr-split", "srr-view-list"])
      model.focus.set("reader")
      expect(classes()).toEqual(["srr-list-shown", "srr-reader-shown", "srr-split"])
      expect(hosts.listView.hidden).toBe(false)
      expect(hosts.article.hidden).toBe(false)
   })

   it("keeps a hidden pane mounted but not shown", () => {
      model.split.set(true)
      model.paneHidden.set(true)
      expect(classes()).toEqual(["srr-pane-hidden", "srr-reader-shown", "srr-split", "srr-view-list"])
      // Laid out, taken off screen by CSS — never [hidden], which would lose its scrollTop.
      expect(hosts.listView.hidden).toBe(false)
   })

   it("stamps srr-pane-hidden at any width (pane.ts restores it at any viewport; the CSS scopes it)", () => {
      model.paneHidden.set(true)
      expect(document.body.classList.contains("srr-pane-hidden")).toBe(true)
      expect(document.body.classList.contains("srr-list-shown")).toBe(true)
   })

   it("does not touch the DOM when an input moves without changing the record", () => {
      const toggle = vi.spyOn(DOMTokenList.prototype, "toggle")
      model.cursor.set({ chron: 7, feedId: 3 }) // nothing painted: readerLive stays false
      model.readerPainted.set(true) // painted and a cursor, but the reader is not mounted
      expect(toggle).not.toHaveBeenCalled()
   })

   it("stops writing once disposed", () => {
      dispose()
      model.focus.set("reader")
      expect(document.body.classList.contains("srr-view-list")).toBe(true)
      dispose = () => {}
   })
})
