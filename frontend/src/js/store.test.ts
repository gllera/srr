import { beforeEach, describe, expect, it } from "vitest"

import { HOME, type StoreContext } from "./base"
import { HOME_MID, pinsKey, profileTsKey, savedKey, seenKey, seenTsKey } from "./keys"
import { isPinned, listPins, pinFilter, unpinFilter } from "./pin"

// The S37 seam's safety property (docs/MULTI-STORE-SPEC.md §11.7): two store
// contexts keep strictly separate device state, AND the home store (mid "0")
// writes the BARE legacy key names — so a single-store user's srr-seen /
// srr-saved / srr-pins survive with no migration. This pins both at the level
// that decides them: keys.ts (the mid ⇒ key function) and pin.ts (the mid-keyed
// registry). nav writes seen/saved through exactly these key helpers.

// The home store (mid "0", from base.ts) and a mounted peer.
const home: StoreContext = HOME
const peer: StoreContext = {
   mid: "s3f9a1c22",
   base: new URL("https://cdn.example.org/store/"),
   cred: "same-origin",
   role: "peer",
}

beforeEach(() => localStorage.clear())

describe("keys.ts: mid ⇒ key", () => {
   it("the home store (mid '0') maps to the exact bare legacy names", () => {
      expect(HOME_MID).toBe("0")
      expect(home.mid).toBe("0")
      expect(seenKey(home.mid)).toBe("srr-seen")
      expect(seenTsKey(home.mid)).toBe("srr-seen-ts")
      expect(savedKey(home.mid)).toBe("srr-saved")
      expect(pinsKey(home.mid)).toBe("srr-pins")
      expect(profileTsKey(home.mid)).toBe("srr-profile-ts")
   })

   it("a peer mount suffixes @<mid>", () => {
      expect(seenKey(peer.mid)).toBe("srr-seen@s3f9a1c22")
      expect(seenTsKey(peer.mid)).toBe("srr-seen-ts@s3f9a1c22")
      expect(savedKey(peer.mid)).toBe("srr-saved@s3f9a1c22")
      expect(pinsKey(peer.mid)).toBe("srr-pins@s3f9a1c22")
      expect(profileTsKey(peer.mid)).toBe("srr-profile-ts@s3f9a1c22")
   })
})

describe("two contexts do not see each other's seen/saved state", () => {
   it("writes under one mid never touch the other's key space; mid '0' uses bare names", () => {
      // Write each store's seen + seen-ts + saved through the mid-keyed helpers
      // (exactly as nav.ts's writeSeen / toggleSaved do).
      localStorage.setItem(seenKey(home.mid), JSON.stringify({ "feed:3": 41 }))
      localStorage.setItem(seenTsKey(home.mid), JSON.stringify({ "feed:3": 1000 }))
      localStorage.setItem(savedKey(home.mid), JSON.stringify([1201, 87]))
      localStorage.setItem(seenKey(peer.mid), JSON.stringify({ "feed:3": 9 }))
      localStorage.setItem(seenTsKey(peer.mid), JSON.stringify({ "feed:3": 2000 }))
      localStorage.setItem(savedKey(peer.mid), JSON.stringify([5]))

      // Each store reads back ONLY its own values.
      expect(JSON.parse(localStorage.getItem(seenKey(home.mid))!)).toEqual({ "feed:3": 41 })
      expect(JSON.parse(localStorage.getItem(seenKey(peer.mid))!)).toEqual({ "feed:3": 9 })
      expect(JSON.parse(localStorage.getItem(savedKey(home.mid))!)).toEqual([1201, 87])
      expect(JSON.parse(localStorage.getItem(savedKey(peer.mid))!)).toEqual([5])

      // The home store's writes landed under the BARE legacy names — a
      // single-store user's exact keys, no migration.
      expect(localStorage.getItem("srr-seen")).toBe(JSON.stringify({ "feed:3": 41 }))
      expect(localStorage.getItem("srr-seen-ts")).toBe(JSON.stringify({ "feed:3": 1000 }))
      expect(localStorage.getItem("srr-saved")).toBe(JSON.stringify([1201, 87]))

      // The peer's state lives under suffixed keys, disjoint from the bare set.
      expect(localStorage.getItem("srr-seen@s3f9a1c22")).toBe(JSON.stringify({ "feed:3": 9 }))
      expect(localStorage.getItem("srr-saved@s3f9a1c22")).toBe(JSON.stringify([5]))
   })
})

describe("pin.ts: per-store registries, home store keeps srr-pins", () => {
   it("pins written through each mid stay isolated", () => {
      pinFilter("all", ["idx/L1.gz", "data/1.gz"], home.mid)
      pinFilter("news", ["meta/0.gz"], peer.mid)

      // Neither registry sees the other's entries.
      expect(isPinned("all", home.mid)).toBe(true)
      expect(isPinned("all", peer.mid)).toBe(false)
      expect(isPinned("news", peer.mid)).toBe(true)
      expect(isPinned("news", home.mid)).toBe(false)
      expect([...listPins(home.mid).keys()]).toEqual(["all"])
      expect([...listPins(peer.mid).keys()]).toEqual(["news"])

      // The home store's registry is the bare `srr-pins`; the peer's is suffixed
      // and holds none of the home store's names (and vice versa).
      expect(localStorage.getItem("srr-pins")).toContain("data/1.gz")
      expect(localStorage.getItem("srr-pins")).not.toContain("news")
      expect(localStorage.getItem("srr-pins@s3f9a1c22")).toContain("meta/0.gz")
      expect(localStorage.getItem("srr-pins@s3f9a1c22")).not.toContain("data/1.gz")

      // Unpinning under one mid leaves the other intact.
      unpinFilter("all", home.mid)
      expect(isPinned("all", home.mid)).toBe(false)
      expect(isPinned("news", peer.mid)).toBe(true)
   })

   it("the default mid is the home store — the single-store call path is unchanged", () => {
      pinFilter("saved", ["idx/L2.gz"]) // no mid arg
      expect(isPinned("saved")).toBe(true) // no mid arg
      expect(isPinned("saved", peer.mid)).toBe(false)
      expect(localStorage.getItem("srr-pins")).toContain("saved")
      expect(localStorage.getItem("srr-pins@s3f9a1c22")).toBeNull()
   })
})
