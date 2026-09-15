import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import * as model from "./model"
import { effect } from "./signals"

// The ownership table (docs/superpowers/plans/2026-09-15-frontend-architecture-trio-index.md
// §3, plus S14): the ONLY module allowed to write each atom. A write from
// anywhere else is a review finding, and this test is that review.
const OWNERS: Record<string, string> = {
   cursor: "nav.ts",
   laneTokens: "nav.ts",
   unreadOnly: "nav.ts",
   frontierEpoch: "nav.ts",
   activeMid: "data.ts",
   mountsRev: "data.ts",
   seen: "seen.ts",
   saved: "saved.ts",
   snapshot: "refresh.ts",
   storeGrown: "refresh.ts",
   refreshError: "refresh.ts",
   syncStatus: "sync.ts",
   rendering: "app.ts",
   focus: "app.ts",
   split: "split.ts",
   paneHidden: "pane.ts",
   readerPainted: "reader.ts",
   profileRev: "profile.ts",
   profileMountsRev: "profile.ts",
}

const here = dirname(fileURLToPath(import.meta.url))

function sources(dir: string): string[] {
   const out: string[] = []
   for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) out.push(...sources(p))
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p)
   }
   return out
}

describe("model", () => {
   it("declares exactly the atoms in the ownership table", () => {
      const atoms = Object.entries(model)
         .filter(([, v]) => typeof v === "function" && "set" in (v as object))
         .map(([k]) => k)
         .sort()
      expect(atoms).toEqual(Object.keys(OWNERS).sort())
   })

   it("starts from the documented initial values", () => {
      expect(model.cursor()).toEqual({ chron: -1, feedId: -1 })
      expect(model.laneTokens()).toEqual([])
      expect(model.unreadOnly()).toBe(false)
      expect(model.activeMid()).toBe("0")
      expect(model.seen()).toEqual({})
      expect(model.saved()).toEqual([])
      expect(model.syncStatus()).toEqual({ on: false, okAt: 0, error: "" })
      expect(model.refreshError()).toBe("")
      expect(model.focus()).toBe("list")
      for (const n of [model.frontierEpoch, model.snapshot, model.storeGrown, model.mountsRev]) expect(n()).toBe(0)
      for (const n of [model.profileRev, model.profileMountsRev]) expect(n()).toBe(0)
      for (const b of [model.rendering, model.split, model.paneHidden, model.readerPainted]) expect(b()).toBe(false)
   })

   it("cursor, laneTokens and syncStatus ignore structurally equal writes", () => {
      const runs = vi.fn()
      const stop = effect(() => void runs(model.cursor(), model.laneTokens(), model.syncStatus()))
      model.cursor.set({ chron: -1, feedId: -1 })
      model.laneTokens.set([])
      model.syncStatus.set({ on: false, okAt: 0, error: "" })
      expect(runs).toHaveBeenCalledTimes(1)
      model.laneTokens.set(["news"])
      expect(runs).toHaveBeenCalledTimes(2)
      stop()
      model.laneTokens.set([])
   })

   it("every model write in the shipped app comes from the atom's owner", () => {
      const write = /\bmodel\.(\w+)\.(?:set|update)\(/g
      const offenders: string[] = []
      for (const file of sources(here)) {
         const base = file.split(/[\\/]/).pop()!
         for (const m of readFileSync(file, "utf8").matchAll(write)) {
            const owner = OWNERS[m[1]]
            if (owner === undefined) offenders.push(`${relative(here, file)}: unknown atom model.${m[1]}`)
            else if (owner !== base) offenders.push(`${relative(here, file)} writes model.${m[1]} (owner: ${owner})`)
         }
      }
      expect(offenders).toEqual([])
   })
})
