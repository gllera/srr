// api.ts's error-classification surface: apiLooksMissing must tell "there is
// no API answering here at all" (a network error, or 404/502/503/504 — what a
// missing/absent `srr serve` behind a reverse proxy actually produces) apart
// from "the API is there and it said no" (401/403 — an expired forward-auth
// session — and 409 — the fetch loop holds the store lock), because store.ts's
// boot() only appends the "needs `srr serve`" hint in the former case; in the
// latter it would mislead. api() and streamSSE() must throw an ApiError
// carrying the HTTP status so that classification is possible at all.

import { afterEach, describe, expect, it, vi } from "vitest"
import { api, apiLooksMissing, ApiError, streamSSE } from "./api"

afterEach(() => {
   vi.unstubAllGlobals()
})

describe("apiLooksMissing", () => {
   it("is true for a non-ApiError (e.g. fetch's own TypeError on a network failure)", () => {
      expect(apiLooksMissing(new TypeError("Failed to fetch"))).toBe(true)
   })

   it.each([404, 502, 503, 504])("is true for ApiError status %d", (status) => {
      expect(apiLooksMissing(new ApiError("nope", status))).toBe(true)
   })

   it.each([401, 403, 409, 500])("is false for ApiError status %d", (status) => {
      expect(apiLooksMissing(new ApiError("nope", status))).toBe(false)
   })
})

describe("api()", () => {
   // serve answers 415 to a JSON body labelled anything but application/json,
   // and the OPML import is the one body sent raw under a type of its own.
   it("labels a JSON body application/json and a raw body with its own type", async () => {
      // The generic declares the CALL signature so mock.calls types the init.
      const f = vi.fn<(input: string, init?: RequestInit) => Promise<{ ok: boolean; text: () => Promise<string> }>>(
         async () => ({ ok: true, text: async () => "{}" }),
      )
      vi.stubGlobal("fetch", f)
      await api("PUT", "/api/dedup", { days: 3 })
      await api("POST", "/api/import?dry_run=1", "<opml/>", "application/xml")
      await api("GET", "/api/overview")

      const sent = f.mock.calls.map(([, init]) => [
         (init?.headers as Record<string, string>)["Content-Type"],
         init?.body,
      ])
      expect(sent).toEqual([
         ["application/json", '{"days":3}'],
         ["application/xml", "<opml/>"],
         [undefined, undefined],
      ])
   })

   it("rejects with an ApiError carrying the status on a failed request", async () => {
      vi.stubGlobal(
         "fetch",
         vi.fn(async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: "not found" }) })),
      )
      await expect(api("GET", "/api/missing")).rejects.toMatchObject({
         status: 404,
         message: "not found",
      })
      await expect(api("GET", "/api/missing")).rejects.toBeInstanceOf(ApiError)
   })
})

describe("streamSSE()", () => {
   it("rejects a pre-stream failure with the same ApiError api() raises", async () => {
      vi.stubGlobal(
         "fetch",
         vi.fn(async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: "store locked" }) })),
      )
      const err = await streamSSE("/api/fetch", () => {}).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err).toMatchObject({ status: 409, message: "store locked" })
   })
})
