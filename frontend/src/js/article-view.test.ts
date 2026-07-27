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
      const frag = buildContent({ f: 1, a: 1, c: "<p>hello</p>" }, new URL("https://cdn.example/"), { inert: false })
      const host = document.createElement("div")
      host.append(frag)
      expect(host.querySelector("p")?.textContent).toBe("hello")
   })

   it("returns the compaction tombstone when content is absent", () => {
      const frag = buildContent({ f: 1, a: 1 } as IArticleWire, new URL("https://cdn.example/"), { inert: false })
      const host = document.createElement("div")
      host.append(frag)
      expect(host.textContent).not.toContain("undefined")
      expect(host.textContent!.length).toBeGreaterThan(0)
   })
})

describe("buildContent inert media", () => {
   const html =
      '<p>before</p><audio src="https://cdn.example/ep.mp3" controls></audio>' +
      '<video src="https://cdn.example/v.mp4" poster="https://cdn.example/p.jpg" width="640" height="360"></video>' +
      '<img src="https://cdn.example/i.jpg"><p>after</p>'

   function build(inert: boolean): HTMLElement {
      const host = document.createElement("div")
      host.append(buildContent({ f: 1, a: 1, c: html }, new URL("https://cdn.example/"), { inert }))
      return host
   }

   it("emits no audio or video elements", () => {
      expect(build(true).querySelectorAll("audio, video")).toHaveLength(0)
   })

   it("emits one stub per replaced element, in place", () => {
      const stubs = build(true).querySelectorAll(".srr-media-stub")
      expect(stubs).toHaveLength(2)
   })

   it("keeps images real — they are the article's substance and are already prefetched", () => {
      expect(build(true).querySelectorAll("img")).toHaveLength(1)
   })

   it("carries the video poster and its intrinsic box onto the stub", () => {
      const stub = build(true).querySelectorAll(".srr-media-stub")[1] as HTMLElement
      expect(stub.style.aspectRatio).toBe("640 / 360")
      expect(stub.style.backgroundImage).toContain("p.jpg")
   })

   it("gives an audio stub its own class rather than a video box", () => {
      const stub = build(true).querySelectorAll(".srr-media-stub")[0] as HTMLElement
      expect(stub.classList.contains("srr-media-stub-audio")).toBe(true)
      expect(stub.style.aspectRatio).toBe("")
   })

   it("falls back to a 16:9 box when the video declares no intrinsic size", () => {
      const host = document.createElement("div")
      host.append(
         buildContent(
            { f: 1, a: 1, c: '<video src="https://cdn.example/v.mp4"></video>' },
            new URL("https://cdn.example/"),
            {
               inert: true,
            },
         ),
      )
      expect((host.querySelector(".srr-media-stub") as HTMLElement).style.aspectRatio).toBe("16 / 9")
   })

   it("hides the stub from assistive tech — it stands in for nothing announceable", () => {
      expect(build(true).querySelector(".srr-media-stub")?.getAttribute("aria-hidden")).toBe("true")
   })

   it("leaves media untouched when not inert", () => {
      const host = build(false)
      expect(host.querySelectorAll("audio, video")).toHaveLength(2)
      expect(host.querySelectorAll(".srr-media-stub")).toHaveLength(0)
   })

   it("preserves surrounding document order", () => {
      const kinds = [...build(true).children].map(
         (n) => n.tagName.toLowerCase() + (n.className ? "." + n.className : ""),
      )
      expect(kinds).toEqual(["p", "div.srr-media-stub srr-media-stub-audio", "div.srr-media-stub", "img", "p"])
   })
})
