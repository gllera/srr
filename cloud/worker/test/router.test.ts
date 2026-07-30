import { describe, expect, it } from "vitest"
import { classify } from "../src/router"

describe("classify", () => {
   it("root", () => {
      expect(classify("/")).toEqual({ kind: "root" })
   })

   it("bare tenant prefix redirects to the slash form", () => {
      expect(classify("/u/t1")).toEqual({ kind: "redirect-slash", uid: "t1" })
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
         expect(classify(`/u/t1/${name}`)).toEqual({ kind: "shell-asset", uid: "t1", name })
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
      expect(classify("/u/t1/config.gz")).toEqual({ kind: "denied", uid: "t1" })
      expect(classify("/u/t1/seen/441.gz")).toEqual({ kind: "denied", uid: "t1" })
      expect(classify("/u/t1/inbox/gw.gz")).toEqual({ kind: "denied", uid: "t1" })
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
