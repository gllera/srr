// api.ts's error-classification surface: apiLooksMissing must tell "there is
// no API answering here at all" (a network error, or 404/502/503/504 — what a
// missing/absent `srr serve` behind a reverse proxy actually produces) apart
// from "the API is there and it said no" (401/403 — an expired forward-auth
// session — and 409 — the fetch loop holds the store lock), because store.ts's
// boot() only appends the "needs `srr serve`" hint in the former case; in the
// latter it would mislead. api() itself must throw an ApiError carrying the
// HTTP status so that classification is possible at all.

import { afterEach, describe, expect, it, vi } from "vitest"
import { api, apiLooksMissing, ApiError } from "./api"

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
