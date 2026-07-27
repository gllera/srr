import { beforeEach, describe, expect, it, vi } from "vitest"

import { type IArticleWire } from "./format.gen"

vi.mock("./data", () => ({
   feedTitle: (f: number) => (f === 7 ? "The Wire" : "Other"),
   activeStore: () => ({ base: "https://cdn.example/", mid: "m1" }),
}))

import { buildContent, paintMasthead, stampContentHost, type ArticleRefs } from "./article-view"

function makeRefs(): ArticleRefs {
   const root = document.createElement("article")
   root.className = "srr-reader"
   root.innerHTML =
      '<a class="srr-title-row"><div class="srr-kicker">' +
      '<span class="srr-source"></span><span class="srr-desk"></span><time class="srr-date"></time>' +
      '</div><h1 class="srr-title"></h1></a><div class="srr-content"></div>'
   return {
      root,
      titleRow: root.querySelector(".srr-title-row") as HTMLAnchorElement,
      source: root.querySelector(".srr-source") as HTMLElement,
      desk: root.querySelector(".srr-desk") as HTMLElement,
      date: root.querySelector(".srr-date") as HTMLElement,
      title: root.querySelector(".srr-title") as HTMLElement,
      content: root.querySelector(".srr-content") as HTMLElement,
   }
}

describe("paintMasthead", () => {
   let refs: ArticleRefs
   beforeEach(() => {
      refs = makeRefs()
   })

   it("fills source, title, desk and the source tint", () => {
      paintMasthead(refs, { f: 7, a: 1, t: "Headline", l: "https://ex.com/a", c: "<p>x</p>" }, {
         tag: "world",
      } as IFeed)
      expect(refs.source.textContent).toBe("The Wire")
      expect(refs.title.textContent).toBe("Headline")
      expect(refs.desk.textContent).toBe("#world")
      expect(refs.root.dataset.src).toBeDefined()
      expect(refs.titleRow.getAttribute("href")).toBe("https://ex.com/a")
   })

   it("renders an untitled article as empty text, never the string undefined", () => {
      paintMasthead(refs, { f: 7, a: 1, c: "<p>x</p>" }, undefined)
      expect(refs.title.textContent).toBe("")
      expect(refs.desk.textContent).toBe("")
   })

   it("refuses a javascript: permalink", () => {
      paintMasthead(refs, { f: 7, a: 1, l: "javascript:alert(1)", c: "" }, undefined)
      expect(refs.titleRow.hasAttribute("href")).toBe(false)
   })

   it("marks a titleless feed on the root", () => {
      paintMasthead(refs, { f: 7, a: 1, c: "" }, { nt: true } as IFeed)
      expect(refs.root.classList.contains("srr-reader-titleless")).toBe(true)
   })
})

describe("stampContentHost", () => {
   it("stamps the article language and dir=auto", () => {
      const host = document.createElement("div")
      stampContentHost(host, { f: 1, a: 1, c: "", g: "es" })
      expect(host.lang).toBe("es")
      expect(host.dir).toBe("auto")
   })

   it("declares UNKNOWN rather than inheriting when the article has no lang", () => {
      const host = document.createElement("div")
      host.lang = "es"
      stampContentHost(host, { f: 1, a: 1, c: "" })
      expect(host.lang).toBe("")
      expect(host.hasAttribute("lang")).toBe(true)
   })
})

describe("buildContent", () => {
   it("returns the sanitized article nodes", () => {
      const frag = buildContent({ f: 1, a: 1, c: "<p>hello</p>" }, "https://cdn.example/", { inert: false })
      const host = document.createElement("div")
      host.append(frag)
      expect(host.querySelector("p")?.textContent).toBe("hello")
   })

   it("returns the compaction tombstone when content is absent", () => {
      const frag = buildContent({ f: 1, a: 1 } as IArticleWire, "https://cdn.example/", { inert: false })
      const host = document.createElement("div")
      host.append(frag)
      expect(host.textContent).not.toContain("undefined")
      expect(host.textContent!.length).toBeGreaterThan(0)
   })
})
