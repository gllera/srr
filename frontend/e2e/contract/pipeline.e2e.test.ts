import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { HOSTILE_HTML, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// The fetch pipeline (#sanitize + #minify, the default root pipe) runs on the
// backend. This proves the reader receives already-sanitized content — dangerous
// nodes are gone before the SPA ever renders them.

describe("contract: sanitize/minify pipeline", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>

   beforeAll(async () => {
      feeds = await feedServer({
         "/hostile.xml": rssFeed("Hostile", [
            { title: "evil", link: "http://example.com/evil", guid: "evil-1", content: HOSTILE_HTML },
         ]),
      })
      store = makeStore()
      await srr(store, "chan", "add", "-t", "Hostile", "-u", `${feeds.url}/hostile.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("strips scripts/handlers/styles/js-urls but keeps safe content", async () => {
      const art = await reader.data.loadArticle(0)
      expect(art.c).not.toContain("<script")
      expect(art.c).not.toContain("__pwned")
      expect(art.c).not.toContain("onerror")
      expect(art.c).not.toContain("javascript:")
      expect(art.c).not.toContain("<style")
      expect(art.c).toContain("safe text")
      expect(art.c).toContain("bold survives")
   })

   it("renders no executable nodes when the stored content is parsed into the DOM", async () => {
      // String checks above can miss markup that only a DOM parser normalizes.
      // Parse the stored content the way the SPA does and assert the live DOM
      // carries no script/style/event-handler/js-url nodes.
      const art = await reader.data.loadArticle(0)
      const div = document.createElement("div")
      div.innerHTML = art.c
      expect(div.querySelector("script")).toBeNull()
      expect(div.querySelector("style")).toBeNull()
      expect(div.querySelector("[onerror]")).toBeNull()
      expect(div.querySelector('a[href^="javascript:"]')).toBeNull()
      expect(div.textContent).toContain("safe text")
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
