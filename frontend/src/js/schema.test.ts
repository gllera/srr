import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// schema.ts imports keys.ts only and has no module-level side effects, so a
// normal static import is fine (the last test re-imports it dynamically to prove
// that importing it writes nothing).
import { ensureSchema, SCHEMA_VERSION, type Migration } from "./schema"
import { SCHEMA_KEY, seenKey, HOME_MID } from "./keys"

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
   localStorage.clear()
   warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
   vi.restoreAllMocks()
})

const stored = () => localStorage.getItem(SCHEMA_KEY)

describe("ensureSchema — the ladder", () => {
   it("stamps the current version when the key is absent", () => {
      expect(ensureSchema()).toEqual({ action: "stamped", from: 0, to: SCHEMA_VERSION })
      expect(stored()).toBe(String(SCHEMA_VERSION))
   })

   it("does nothing when the stamp already equals the current version", () => {
      localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
      const set = vi.spyOn(Storage.prototype, "setItem")
      expect(ensureSchema()).toEqual({ action: "current", from: SCHEMA_VERSION, to: SCHEMA_VERSION })
      expect(set).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
   })

   it("is idempotent — the second boot is a no-op", () => {
      ensureSchema()
      const set = vi.spyOn(Storage.prototype, "setItem")
      expect(ensureSchema().action).toBe("current")
      expect(set).not.toHaveBeenCalled()
   })

   it("runs the rungs above the stored version, ascending, then stamps the target", () => {
      localStorage.setItem(SCHEMA_KEY, "1")
      const ran: number[] = []
      // Deliberately out of order on the way in.
      const migrations: Migration[] = [
         { to: 3, run: () => ran.push(3) },
         { to: 2, run: () => ran.push(2) },
      ]
      expect(ensureSchema({ version: 3, migrations })).toEqual({ action: "migrated", from: 1, to: 3 })
      expect(ran).toEqual([2, 3])
      expect(stored()).toBe("3")
   })

   it("skips rungs at or below the stored version and above the target", () => {
      localStorage.setItem(SCHEMA_KEY, "2")
      const ran: number[] = []
      const migrations: Migration[] = [
         { to: 1, run: () => ran.push(1) },
         { to: 2, run: () => ran.push(2) },
         { to: 3, run: () => ran.push(3) },
         { to: 4, run: () => ran.push(4) },
      ]
      expect(ensureSchema({ version: 3, migrations })).toEqual({ action: "migrated", from: 2, to: 3 })
      expect(ran).toEqual([3])
   })

   it("reaches the target even when no rung names it", () => {
      // A version bump whose last step needed no data change is legal; the device
      // must not be left one behind, re-walking an empty ladder every boot.
      localStorage.setItem(SCHEMA_KEY, "1")
      const migrations: Migration[] = [{ to: 2, run: () => {} }]
      expect(ensureSchema({ version: 3, migrations })).toEqual({ action: "migrated", from: 1, to: 3 })
      expect(stored()).toBe("3")
   })

   it("a failing rung stops the walk and stamps the last one that completed", () => {
      localStorage.setItem(SCHEMA_KEY, "1")
      const ran: number[] = []
      const migrations: Migration[] = [
         { to: 2, run: () => ran.push(2) },
         {
            to: 3,
            run: () => {
               throw new Error("nope")
            },
         },
         { to: 4, run: () => ran.push(4) },
      ]
      expect(ensureSchema({ version: 4, migrations })).toEqual({ action: "migrated", from: 1, to: 2 })
      expect(ran).toEqual([2]) // rung 4 never runs behind a failed 3
      expect(stored()).toBe("2")
      expect(warn).toHaveBeenCalled()
   })

   it("a rung failing first leaves the stamp where it was", () => {
      localStorage.setItem(SCHEMA_KEY, "1")
      const migrations: Migration[] = [
         {
            to: 2,
            run: () => {
               throw new Error("nope")
            },
         },
      ]
      expect(ensureSchema({ version: 2, migrations })).toEqual({ action: "migrated", from: 1, to: 1 })
      expect(stored()).toBe("1")
   })
})

describe("ensureSchema — a stamp from a newer build", () => {
   it("leaves a higher version alone and warns", () => {
      localStorage.setItem(SCHEMA_KEY, "99")
      const set = vi.spyOn(Storage.prototype, "setItem")
      expect(ensureSchema()).toEqual({ action: "ahead", from: 99, to: 99 })
      expect(stored()).toBe("99") // NOT written down to SCHEMA_VERSION
      expect(set).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
   })

   it("never runs a migration for a higher version", () => {
      localStorage.setItem(SCHEMA_KEY, "5")
      const ran: number[] = []
      const migrations: Migration[] = [{ to: 2, run: () => ran.push(2) }]
      expect(ensureSchema({ version: 3, migrations }).action).toBe("ahead")
      expect(ran).toEqual([])
   })

   it("does not touch any other stored key", () => {
      // The higher branch is the one where a wipe would be tempting; it must not
      // cost a real person their read frontier.
      localStorage.setItem(SCHEMA_KEY, "99")
      localStorage.setItem(seenKey(HOME_MID), '{"feed:3":41}')
      ensureSchema()
      expect(localStorage.getItem(seenKey(HOME_MID))).toBe('{"feed:3":41}')
   })
})

describe("ensureSchema — a corrupt stamp", () => {
   for (const bad of ["abc", "1.5", "-2", "0", "  ", "[]", "{}"])
      it(`treats ${JSON.stringify(bad)} as no version information and stamps`, () => {
         localStorage.setItem(SCHEMA_KEY, bad)
         expect(ensureSchema()).toEqual({ action: "stamped", from: 0, to: SCHEMA_VERSION })
         expect(stored()).toBe(String(SCHEMA_VERSION))
         expect(warn).toHaveBeenCalled()
      })

   it("treats an empty string as absent, without a warning", () => {
      localStorage.setItem(SCHEMA_KEY, "")
      expect(ensureSchema()).toEqual({ action: "stamped", from: 0, to: SCHEMA_VERSION })
      expect(warn).not.toHaveBeenCalled()
   })

   it("re-runs the ladder from the legacy version rather than skipping it", () => {
      localStorage.setItem(SCHEMA_KEY, "garbage")
      const ran: number[] = []
      const migrations: Migration[] = [{ to: 2, run: () => ran.push(2) }]
      expect(ensureSchema({ version: 2, migrations })).toEqual({ action: "migrated", from: 0, to: 2 })
      expect(ran).toEqual([2])
   })

   it("does not touch any other stored key", () => {
      localStorage.setItem(SCHEMA_KEY, "garbage")
      localStorage.setItem(seenKey(HOME_MID), '{"feed:3":41}')
      ensureSchema()
      expect(localStorage.getItem(seenKey(HOME_MID))).toBe('{"feed:3":41}')
   })
})

describe("ensureSchema — hostile storage", () => {
   it("reports unavailable when reads throw (private mode, storage disabled)", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
         throw new Error("denied")
      })
      const set = vi.spyOn(Storage.prototype, "setItem")
      expect(ensureSchema()).toEqual({ action: "unavailable", from: 0, to: 0 })
      expect(set).not.toHaveBeenCalled()
   })

   it("never runs a migration when reads throw", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
         throw new Error("denied")
      })
      const ran: number[] = []
      expect(ensureSchema({ version: 2, migrations: [{ to: 2, run: () => ran.push(2) }] }).action).toBe("unavailable")
      expect(ran).toEqual([])
   })

   it("survives a write that throws, reporting the version still in storage", () => {
      localStorage.setItem(SCHEMA_KEY, "1")
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
         throw new Error("quota")
      })
      const ran: number[] = []
      // The migration still ran; only the stamp failed, so `to` stays honest and
      // the next boot re-runs the (idempotent) rung.
      expect(ensureSchema({ version: 2, migrations: [{ to: 2, run: () => ran.push(2) }] })).toEqual({
         action: "migrated",
         from: 1,
         to: 1,
      })
      expect(ran).toEqual([2])
   })

   it("survives a write that throws on the absent-key stamp", () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
         throw new Error("quota")
      })
      expect(() => ensureSchema()).not.toThrow()
      expect(ensureSchema()).toEqual({ action: "stamped", from: 0, to: 0 })
   })
})

describe("schema module", () => {
   it("writes nothing at import time — the gate runs only when called", async () => {
      vi.resetModules()
      await import("./schema")
      expect(stored()).toBe(null)
   })
})
