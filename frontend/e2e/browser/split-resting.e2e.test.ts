import { mkdirSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser, Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, waitList, waitReader } from "./helpers"

// The split view's two panes when the list pane is built OUTSIDE a list command:
// a window widened across the breakpoint (the resting pane's probe settles while
// relayoutPane's rebuild holds rendering), a reload onto a caught-up reading
// position (a placeholder landing that moves nothing the list tracks), and a
// search deep link (the pane built by following the cursor). Each case is one
// fresh browser context over the same store.

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

const PEER = "sPEER0001"

const splitSettled = (p: Page) =>
   p.waitForFunction(
      () => document.body.classList.contains("srr-split") && !document.body.classList.contains("srr-loading"),
      { timeout: 20_000 },
   )
const restingPainted = (p: Page) =>
   p.waitForFunction(() => !!document.querySelector("article.srr-reader.srr-reader-empty .srr-empty-eyebrow"), {
      timeout: 10_000,
   })

describe("split view — panes built outside a list command", () => {
   let feeds: FeedServer
   let browser: Browser

   beforeAll(async () => {
      feeds = await feedServer({
         "/news.xml": rssFeed("News", nItems(40, "news", 0, 0)),
         "/peer.xml": rssFeed("Peer", nItems(12, "peer", 0, 100)),
      })
      clearDir(packsDir)
      await srr(packsDir, "feed", "add", "-t", "News", "-u", `${feeds.url}/news.xml`)
      await srr(packsDir, "fetch")
      mkdirSync(`${packsDir}/peer`, { recursive: true })
      await srr(`${packsDir}/peer`, "feed", "add", "-t", "Peer", "-u", `${feeds.url}/peer.xml`)
      await srr(`${packsDir}/peer`, "fetch")
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   const withPage = async (fn: (p: Page) => Promise<void>) => {
      const ctx = await browser.createBrowserContext()
      try {
         await fn(await ctx.newPage())
      } finally {
         await ctx.close()
      }
   }

   it("widening the narrow list paints the resting pane beside it", () =>
      withPage(async (page) => {
         await page.setViewport({ width: 420, height: 900 })
         await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(page)
         await page.setViewport({ width: 1280, height: 900 })
         await splitSettled(page)
         await restingPainted(page)
         expect(await page.$eval(".srr-next", (b) => (b as HTMLButtonElement).disabled)).toBe(false)
      }))

   it("widening after a narrow store switch shows the resting pane, not the other store's article", () =>
      withPage(async (page) => {
         await page.setViewport({ width: 420, height: 900 })
         await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await page.evaluate((peer) => {
            localStorage.setItem(
               "srr-mounts",
               JSON.stringify([
                  { id: "0", url: location.origin + "/packs/", label: "", ord: 0, role: "home", cred: false, ts: 0 },
                  {
                     id: peer,
                     url: location.origin + "/packs/peer/",
                     label: "Peer",
                     ord: 10,
                     role: "peer",
                     cred: false,
                     ts: 1,
                  },
               ]),
            )
            localStorage.setItem("srr-unread-only", "0")
         }, PEER)
         await page.reload({ waitUntil: "load" })
         await waitList(page)
         await page.evaluate(() =>
            (document.querySelector('.srr-list a.srr-row[data-chron="3"]') as HTMLElement).click(),
         )
         await waitReader(page)
         const homeTitle = await page.$eval(".srr-title", (e) => e.textContent)
         await page.keyboard.press("Escape")
         await waitList(page)
         await page.evaluate((peer) => (location.hash = `#!@${peer}`), PEER)
         await page.waitForFunction(
            () =>
               [...document.querySelectorAll(".srr-list a.srr-row .srr-row-title")].some((t) =>
                  t.textContent?.startsWith("peer"),
               ),
            { timeout: 20_000 },
         )
         await page.setViewport({ width: 1280, height: 900 })
         await splitSettled(page)
         await restingPainted(page)
         expect(await page.$eval(".srr-title", (e) => e.textContent)).not.toBe(homeTitle)
         expect(await page.$eval(".srr-save", (b) => (b as HTMLButtonElement).disabled)).toBe(true)
      }))

   it("a split reload onto a caught-up reading position still builds the list pane", () =>
      withPage(async (page) => {
         await page.setViewport({ width: 1280, height: 900 })
         await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await waitList(page)
         // Everything read, unread-only on, and the restore key naming a position.
         await page.evaluate(() => {
            localStorage.setItem("srr-seen", JSON.stringify({ "feed:0": 999, "feed:1": 999 }))
            localStorage.setItem("srr-unread-only", "1")
            localStorage.setItem("srr-hash", "#5")
            history.replaceState(null, "", location.pathname)
         })
         await page.reload({ waitUntil: "load" })
         await page.waitForFunction(
            () => document.querySelector(".srr-reader")?.classList.contains("srr-reader-empty"),
            {
               timeout: 20_000,
            },
         )
         await page.waitForFunction(() => document.querySelector(".srr-list")!.childElementCount > 0, {
            timeout: 10_000,
         })
      }))

   it("a search deep link booted at split shows the pane's search bar", () =>
      withPage(async (page) => {
         await page.setViewport({ width: 1280, height: 900 })
         await page.goto(`${baseUrl}#!`, { waitUntil: "load" })
         await page.evaluate(() => localStorage.setItem("srr-unread-only", "0"))
         await page.goto(`${baseUrl}#31!q%3Atitle%201`, { waitUntil: "load" })
         await page.reload({ waitUntil: "load" })
         await waitReader(page)
         await waitList(page)
         await page.waitForFunction(() => document.body.classList.contains("srr-searching"), { timeout: 10_000 })
      }))
})
