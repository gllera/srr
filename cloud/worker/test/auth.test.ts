import { describe, expect, it } from "vitest"
import { env } from "cloudflare:test"
import { readSession, sessionToken } from "../src/auth"
import { makeToken } from "./helpers"

const SECRET = env.SESSION_SECRET

describe("readSession", () => {
   it("accepts a valid sess token", async () => {
      const tok = await makeToken({ t: "sess", e: "a@b.c" })
      expect(await readSession(SECRET, tok)).toEqual({ e: "a@b.c" })
   })

   it("rejects a bad signature", async () => {
      const tok = await makeToken({ t: "sess", e: "a@b.c" }, "other-secret")
      expect(await readSession(SECRET, tok)).toBeNull()
   })

   it("rejects a tampered body", async () => {
      const tok = await makeToken({ t: "sess", e: "a@b.c" })
      const [, sig] = tok.split(".")
      const forged = btoa(JSON.stringify({ t: "sess", e: "evil@b.c" }))
         .replace(/\+/g, "-")
         .replace(/\//g, "_")
         .replace(/=+$/, "")
      expect(await readSession(SECRET, `${forged}.${sig}`)).toBeNull()
   })

   it("rejects malformed tokens", async () => {
      expect(await readSession(SECRET, null)).toBeNull()
      expect(await readSession(SECRET, "")).toBeNull()
      expect(await readSession(SECRET, "no-dot")).toBeNull()
      expect(await readSession(SECRET, "not!base64.also!bad")).toBeNull()
   })

   it("rejects a login token passed as sess (wrong type)", async () => {
      const tok = await makeToken({ t: "login", e: "a@b.c", x: Date.now() + 60_000 })
      expect(await readSession(SECRET, tok)).toBeNull()
   })

   it("rejects an expired token and a non-numeric expiry", async () => {
      expect(await readSession(SECRET, await makeToken({ t: "sess", e: "a@b.c", x: Date.now() - 1000 }))).toBeNull()
      expect(await readSession(SECRET, await makeToken({ t: "sess", e: "a@b.c", x: "soon" }))).toBeNull()
   })

   it("rejects a payload without an email", async () => {
      expect(await readSession(SECRET, await makeToken({ t: "sess" }))).toBeNull()
      expect(await readSession(SECRET, await makeToken({ t: "sess", e: "" }))).toBeNull()
   })
})

describe("sessionToken", () => {
   const req = (cookie?: string) => new Request("https://cloud.example.com/", { headers: cookie ? { cookie } : {} })

   it("extracts the sess cookie among others", () => {
      expect(sessionToken(req("a=1; sess=tok.sig; b=2"))).toBe("tok.sig")
      expect(sessionToken(req("sess=tok.sig"))).toBe("tok.sig")
   })

   it("returns null with no cookie header or no sess cookie", () => {
      expect(sessionToken(req())).toBeNull()
      expect(sessionToken(req("a=1; session=nope"))).toBeNull()
      expect(sessionToken(req("xsess=nope"))).toBeNull()
   })
})
