// The console's two feed PROBES — the Feeds-row preview (GET /api/preview) and
// the add/edit dialog's URL probe (GET /api/resolve) — must carry the feed's
// SECRET GRANT. SEC5 made the grant fail-closed: with no `secrets` on the query
// the server resolves `grantSecrets(ctx, recipes, recipe, nil)`, i.e. the
// RECIPE's grant alone, so an external-ingest feed whose credentials come from
// its own feed-level override probes as an auth failure or 0 items while its
// real fetch cycle is fine — and the preview dialog renders a "feed-level
// secrets override" chip above a preview that did not apply it.
//
// Nothing else pins either probe's query string, so the wire shape lives here:
// one REPEATED `secrets=` param per scope, because the server reads q["secrets"]
// (a slice), not a joined list.

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

// nth fetched URL, split into the two halves the probes are asserted on.
const called = (f: ReturnType<typeof stubFetch>, n: number): URL => new URL(f.mock.calls[n][0], "http://localhost")
const query = (f: ReturnType<typeof stubFetch>, n: number): URLSearchParams => called(f, n).searchParams
const path = (f: ReturnType<typeof stubFetch>, n: number): string => called(f, n).pathname

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
   it("sends one secrets= param per scope, beside the pipe and ingest overrides", async () => {
      const f = stubFetch([])
      await renderPreviewInto(document.createElement("div"), FEED.url, "tg", FEED.pipe, FEED.ingest, FEED.secrets)

      expect(f).toHaveBeenCalledTimes(1)
      expect(path(f, 0)).toBe("/api/preview")
      const q = query(f, 0)
      expect(q.getAll("secrets")).toEqual(["tg", "alerts"])
      expect(q.get("ingest")).toBe("srr-telegram")
      expect(q.getAll("pipe")).toEqual(["#default"])
      expect(q.get("recipe")).toBe("tg")
   })

   it("sends no secrets param at all when the feed grants none", async () => {
      const f = stubFetch([])
      await renderPreviewInto(document.createElement("div"), FEED.url, "default")

      expect(query(f, 0).getAll("secrets")).toEqual([])
   })

   it("is what the Feeds-row Preview action passes the feed's own grant through", async () => {
      const f = stubFetch([])
      renderers.feeds()
      clickByLabel("Preview")

      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
      expect(path(f, 0)).toBe("/api/preview")
      expect(query(f, 0).getAll("secrets")).toEqual(["tg", "alerts"])
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
      expect(path(f, 0)).toBe("/api/resolve")
      const first = query(f, 0)
      expect(first.getAll("secrets")).toEqual(["tg", "alerts"])
      expect(first.get("url")).toBe(FEED.url)
      expect(first.get("recipe")).toBe("tg")
      expect(first.get("ingest")).toBe("srr-telegram")

      // Editing the grant changes what the probe can authenticate as, so it must
      // re-run even though the URL did not move.
      secretsIn.value = "tg"
      secretsIn.dispatchEvent(new Event("change"))
      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2))
      expect(query(f, 1).getAll("secrets")).toEqual(["tg"])
   })

   it("sends no secrets param when the scopes field is empty", async () => {
      const f = stubFetch({ url: FEED.url, title: "Telegram wire", items: 3 })
      state.snapshot = snapshot([{ ...FEED, secrets: [] }])
      renderers.feeds()
      clickByLabel("Edit")

      const urlIn = document.getElementById("f_url") as HTMLInputElement
      expect((document.getElementById("f_secrets") as HTMLInputElement).value).toBe("")
      urlIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }))

      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
      expect(query(f, 0).getAll("secrets")).toEqual([])
   })
})
