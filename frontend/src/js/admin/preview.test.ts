// The console's two feed PROBES — the Feeds-row preview (POST /api/preview)
// and the add/edit dialog's URL probe (POST /api/resolve) — must carry the
// feed's SECRET GRANT. SEC5 made the grant fail-closed: with no `secrets` in
// the body the server resolves `grantSecrets(ctx, recipes, recipe, nil)`, i.e.
// the RECIPE's grant alone, so an external-ingest feed whose credentials come
// from its own feed-level override probes as an auth failure or 0 items while
// its real fetch cycle is fine — and the preview dialog renders a "feed-level
// secrets override" chip above a preview that did not apply it.
//
// Nothing else pins either probe's request, so the wire shape lives here: a
// POST whose JSON body (`application/json`, the type the server requires)
// carries `secrets` as an array, one entry per scope — and NOTHING on the query
// string, because the server answers a GET of either route with 405: both run
// the ingest command they are handed, so nothing a bare URL can trigger may
// reach them.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { renderPreviewInto } from "./preview"
import { renderers, state } from "./store"
import type { FeedListView, OverviewView } from "./types"
import "./feeds" // side effect: registers renderers.feeds

// An external-ingest feed carrying an override on every axis — the srr-telegram
// shape, which is the live instance of this bug on the production box.
const FEED: FeedListView = {
   id: 7,
   title: "Telegram wire",
   url: "https://t.me/s/example",
   recipe: "tg",
   ingest: "srr-telegram",
   pipe: ["#default"],
   secrets: ["tg", "alerts"],
   fail_streak: 0,
   last_ok: 0,
   last_new: 0,
   total_art: 0,
}

const snapshot = (feeds: FeedListView[]): OverviewView => ({
   feeds,
   tags: [],
   recipes: { default: {}, tg: {} },
   out: [],
   m: 1,
   fetched_at: Math.floor(Date.now() / 1000),
   total_art: 0,
   dedup_days: 30,
   version: "test",
})

// stubFetch installs a fetch returning `body` as JSON for every call (api.ts
// reads res.text() then JSON.parses it) and hands back the spy. The generic
// declares the CALL signature (the impl ignores its args), so mock.calls types
// as the request URL rather than an empty tuple.
type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; text: () => Promise<string> }>

function stubFetch(body: unknown) {
   const f = vi.fn<FetchLike>(async () => ({ ok: true, text: async () => JSON.stringify(body) }))
   vi.stubGlobal("fetch", f)
   return f
}

// The nth request, split into what the probes are asserted on: where it went,
// how, and the JSON body it carried.
interface Sent {
   path: string
   search: string
   method?: string
   contentType?: string
   body: Record<string, unknown>
}

function sent(f: ReturnType<typeof stubFetch>, n: number): Sent {
   const [input, init] = f.mock.calls[n]
   const u = new URL(input, "http://localhost")
   return {
      path: u.pathname,
      search: u.search,
      method: init?.method,
      contentType: (init?.headers as Record<string, string> | undefined)?.["Content-Type"],
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
   }
}

// expectProbe asserts the request shape both probes share — a POST to `path`
// with a JSON body and nothing on the query string — and returns that body.
function expectProbe(f: ReturnType<typeof stubFetch>, n: number, path: string): Record<string, unknown> {
   const s = sent(f, n)
   expect(s.path).toBe(path)
   expect(s.method).toBe("POST")
   expect(s.search).toBe("")
   expect(s.contentType).toBe("application/json")
   return s.body
}

const clickByLabel = (label: string): void =>
   (document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click()

const resolveStatus = (): string => document.querySelector(".resolve-status")?.textContent || ""

beforeAll(() => {
   // jsdom 29 implements <dialog> but neither showModal nor close; both modals
   // open through them. The dialogs are module-level singletons cached on first
   // open, so the container below is created ONCE and only its children are
   // redrawn — wiping document.body between cases would detach those dialogs
   // while the module still held them.
   const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>
   proto.showModal ??= function (this: HTMLDialogElement) {
      this.open = true
   }
   proto.close ??= function (this: HTMLDialogElement) {
      this.open = false
   }
   for (const id of ["banner", "feeds"]) {
      const d = document.createElement("div")
      d.id = id
      document.body.append(d)
   }
})

beforeEach(() => {
   state.snapshot = snapshot([{ ...FEED }])
})

afterEach(() => {
   vi.unstubAllGlobals()
})

describe("/api/preview probe", () => {
   it("POSTs the scopes as an array, beside the pipe and ingest overrides", async () => {
      const f = stubFetch([])
      await renderPreviewInto(document.createElement("div"), FEED.url, "tg", FEED.pipe, FEED.ingest, FEED.secrets)

      expect(f).toHaveBeenCalledTimes(1)
      expect(expectProbe(f, 0, "/api/preview")).toEqual({
         url: FEED.url,
         recipe: "tg",
         pipe: ["#default"],
         ingest: "srr-telegram",
         secrets: ["tg", "alerts"],
      })
   })

   it("sends no secrets at all when the feed grants none", async () => {
      const f = stubFetch([])
      await renderPreviewInto(document.createElement("div"), FEED.url, "default")

      expect(expectProbe(f, 0, "/api/preview").secrets ?? []).toEqual([])
   })

   it("is what the Feeds-row Preview action passes the feed's own grant through", async () => {
      const f = stubFetch([])
      renderers.feeds()
      clickByLabel("Preview")

      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
      expect(expectProbe(f, 0, "/api/preview").secrets).toEqual(["tg", "alerts"])
   })
})

describe("/api/resolve probe", () => {
   it("carries the dialog's scopes and RE-PROBES when the field is edited", async () => {
      const f = stubFetch({ url: FEED.url, title: "Telegram wire", items: 3 })
      renderers.feeds()
      clickByLabel("Edit")

      const urlIn = document.getElementById("f_url") as HTMLInputElement
      const secretsIn = document.getElementById("f_secrets") as HTMLInputElement
      expect(secretsIn.value).toBe("tg, alerts")

      // Probe once (Enter forces it) so checkURL's `probed` memo is armed — it
      // is keyed on the URL ALONE, which is why the re-probe below must force.
      urlIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }))
      await vi.waitFor(() => expect(resolveStatus()).toContain("3 items"))
      expect(f).toHaveBeenCalledTimes(1)
      expect(expectProbe(f, 0, "/api/resolve")).toEqual({
         url: FEED.url,
         recipe: "tg",
         ingest: "srr-telegram",
         secrets: ["tg", "alerts"],
      })

      // Editing the grant changes what the probe can authenticate as, so it must
      // re-run even though the URL did not move.
      secretsIn.value = "tg"
      secretsIn.dispatchEvent(new Event("change"))
      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2))
      expect(expectProbe(f, 1, "/api/resolve").secrets).toEqual(["tg"])
   })

   it("sends no secrets when the scopes field is empty", async () => {
      const f = stubFetch({ url: FEED.url, title: "Telegram wire", items: 3 })
      state.snapshot = snapshot([{ ...FEED, secrets: [] }])
      renderers.feeds()
      clickByLabel("Edit")

      const urlIn = document.getElementById("f_url") as HTMLInputElement
      expect((document.getElementById("f_secrets") as HTMLInputElement).value).toBe("")
      urlIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }))

      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
      expect(expectProbe(f, 0, "/api/resolve").secrets ?? []).toEqual([])
   })
})
