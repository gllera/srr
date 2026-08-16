import { describe, expect, it } from "vitest"
import { classify, classifyReader, policy, policyReader, type Route } from "../src/router"

describe("classify", () => {
   it("root", () => {
      expect(classify("/")).toEqual({ kind: "root" })
   })

   it("names the three sign-in routes, and only those three", () => {
      expect(classify("/auth/login")).toEqual({ kind: "login" })
      expect(classify("/auth/callback")).toEqual({ kind: "callback" })
      expect(classify("/auth/logout")).toEqual({ kind: "logout" })
      // Not a prefix: a route filed under /auth/ later is gated by default.
      expect(classify("/auth/")).toEqual({ kind: "none" })
      expect(classify("/auth/whatever")).toEqual({ kind: "none" })
      expect(classify("/auth/login/extra")).toEqual({ kind: "none" })
   })

   it("gives both workers the SAME three sign-in paths", () => {
      // One table feeds both (router.ts classifyAuth). The failure this pins is
      // not a mismatched route table — it is oidc.ts's redirect_uri, built from
      // the `/auth/callback` literal and compared un-normalized at the IdP, so a
      // divergence here is a sign-in that cannot complete on one of the two.
      for (const p of ["/auth/login", "/auth/callback", "/auth/logout"]) {
         expect(classify(p), p).toEqual(classifyReader(p))
      }
   })

   it("bare tenant prefix redirects to the slash form", () => {
      // No uid on the verdict: the redirect reflects the path it was handed and
      // authorizes nothing, so carrying one would only suggest it does.
      expect(classify("/u/t1")).toEqual({ kind: "redirect-slash" })
   })

   it("shell index — both spellings", () => {
      expect(classify("/u/t1/")).toEqual({ kind: "shell-index", uid: "t1" })
      expect(classify("/u/t1/index.html")).toEqual({ kind: "shell-index", uid: "t1" })
   })

   it("shell assets — every bundle shape, virtually under the prefix", () => {
      for (const name of [
         "frontend.1294b80e.js",
         "frontend.a6f9c5dd.css",
         "sw.586aa705.js",
         "icon.aea4e164.svg",
         "icon-192.936dab90.png",
         "icon-512.e13f7d70.png",
         "apple-touch-icon.bcdd2574.png",
         "manifest.webmanifest",
      ]) {
         expect(classify(`/u/t1/${name}`)).toEqual({ kind: "shell-asset", name })
      }
   })

   it("shell-asset lookalikes are STORE keys, not assets", () => {
      // manifest/<m>.gz is the generation-manifest series, not the webmanifest.
      expect(classify("/u/t1/manifest/1743.gz")).toEqual({ kind: "store", uid: "t1", key: "manifest/1743.gz" })
      // A frontend.js with no content hash is not a bundle name.
      expect(classify("/u/t1/frontend.js")).toEqual({ kind: "store", uid: "t1", key: "frontend.js" })
      // A nested path never matches the flat shell.
      expect(classify("/u/t1/x/sw.586aa705.js")).toEqual({ kind: "store", uid: "t1", key: "x/sw.586aa705.js" })
   })

   it("sync.json", () => {
      expect(classify("/u/t1/sync.json")).toEqual({ kind: "sync", uid: "t1" })
   })

   it("denied backend-only classes", () => {
      expect(classify("/u/t1/config.gz")).toEqual({ kind: "denied" })
      expect(classify("/u/t1/seen/441.gz")).toEqual({ kind: "denied" })
      expect(classify("/u/t1/inbox/gw.gz")).toEqual({ kind: "denied" })
      // …but a key merely CONTAINING those words is a normal store key.
      expect(classify("/u/t1/data/seen.gz")).toEqual({ kind: "store", uid: "t1", key: "data/seen.gz" })
   })

   it("store keys — root objects, series, assets", () => {
      expect(classify("/u/t1/db.gz")).toEqual({ kind: "store", uid: "t1", key: "db.gz" })
      expect(classify("/u/t1/idx/0.gz")).toEqual({ kind: "store", uid: "t1", key: "idx/0.gz" })
      expect(classify("/u/t1/assets/ab/0123456789abcdef.webp")).toEqual({
         kind: "store",
         uid: "t1",
         key: "assets/ab/0123456789abcdef.webp",
      })
   })

   it("rejects malformed uids and paths outside /u/", () => {
      expect(classify("/u//db.gz")).toEqual({ kind: "none" })
      expect(classify("/u/T1/db.gz")).toEqual({ kind: "none" })
      expect(classify("/u/-bad/db.gz")).toEqual({ kind: "none" })
      expect(classify("/favicon.ico")).toEqual({ kind: "none" })
      expect(classify("/anything")).toEqual({ kind: "none" })
      expect(classify("/u")).toEqual({ kind: "none" })
   })

   it("rejects suspicious store keys (hygiene — R2 keys are flat anyway)", () => {
      expect(classify("/u/t1/a/../b.gz")).toEqual({ kind: "none" })
      expect(classify("/u/t1/a//b.gz")).toEqual({ kind: "none" })
      expect(classify("/u/t1/dir/")).toEqual({ kind: "none" })
   })
})

describe("policy", () => {
   // The invariant the whole split exists for. Gating used to be decided by
   // whether a `case` in dispatch remembered to authorize, which fails OPEN —
   // an ungated new route answers 200 with every other test still green. This
   // says it from the outside: anything carrying a uid is tenant-gated.
   it("gates every tenant-scoped route, and only public routes are ungated", () => {
      const paths = [
         "/",
         "/auth/login",
         "/auth/callback",
         "/auth/logout",
         "/u/t1",
         "/u/t1/",
         "/u/t1/index.html",
         "/u/t1/frontend.1294b80e.js",
         "/u/t1/manifest.webmanifest",
         "/u/t1/sync.json",
         "/u/t1/config.gz",
         "/u/t1/db.gz",
         "/u/t1/assets/ab/0123456789abcdef.webp",
         "/favicon.ico",
      ]
      for (const p of paths) {
         const route = classify(p)
         const { gate } = policy(route)
         if ("uid" in route) expect(gate, `${p} carries a uid`).toBe("tenant")
         else expect(gate, `${p} carries no uid`).not.toBe("session")
      }
   })

   it("keeps the store and the sync blob the only user-byte routes", () => {
      const userByte = (p: string) => policy(classify(p)).userBytes
      expect(userByte("/u/t1/db.gz")).toBe(true)
      expect(userByte("/u/t1/sync.json")).toBe(true)
      // The shell is a published release artifact, not user bytes — stamping
      // index.ts's `sandbox` on it would stop the reader running at all.
      expect(userByte("/u/t1/")).toBe(false)
      expect(userByte("/u/t1/frontend.1294b80e.js")).toBe(false)
      expect(userByte("/u/t1/config.gz")).toBe(false)
   })

   it("names PUT and POST on exactly one route each", () => {
      const every = ["/", "/auth/login", "/auth/callback", "/auth/logout", "/u/t1/", "/u/t1/sync.json", "/u/t1/db.gz"]
      const writable = (m: string) => every.filter((p) => policy(classify(p)).methods.includes(m))
      expect(writable("PUT")).toEqual(["/u/t1/sync.json"])
      expect(writable("POST")).toEqual(["/auth/logout"])
   })

   it("leaves the reader's sign-in routes ungated and its shell gated", () => {
      expect(policyReader(classifyReader("/")).gate).toBe("session")
      expect(policyReader(classifyReader("/index.html")).gate).toBe("session")
      for (const p of ["/auth/login", "/auth/callback", "/auth/logout", "/sw.586aa705.js", "/nope"]) {
         expect(policyReader(classifyReader(p)).gate, p).toBe("public")
      }
   })

   it("gives every route kind a policy — the exhaustive switch, from the outside", () => {
      const kinds: Route["kind"][] = [
         "login",
         "callback",
         "logout",
         "root",
         "redirect-slash",
         "shell-index",
         "shell-asset",
         "sync",
         "denied",
         "store",
         "none",
      ]
      for (const kind of kinds) {
         const p = policy({ kind, uid: "t1", name: "x", key: "k" } as unknown as Route)
         expect(p.methods, kind).toContain("GET")
      }
   })
})
