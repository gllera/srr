import { describe, expect, it } from "vitest"
import { parseRoster, rosterLookup } from "../src/roster"

const ROSTER = JSON.stringify({
   "owner@example.com": { uid: "t1", active: true },
   "Second@Example.com": { uid: "t2", active: true },
   "revoked@example.com": { uid: "t9", active: false },
})

describe("rosterLookup", () => {
   it("maps a roster email to its tenant", () => {
      expect(rosterLookup(ROSTER, "owner@example.com")).toEqual({ uid: "t1", active: true })
   })

   it("is case-insensitive on the email, on both sides", () => {
      expect(rosterLookup(ROSTER, "OWNER@EXAMPLE.COM")).toEqual({ uid: "t1", active: true })
      // …including a mixed-case KEY in the roster itself: an operator typing a
      // capital into the config must not create an unreachable tenant.
      expect(rosterLookup(ROSTER, "second@example.com")).toEqual({ uid: "t2", active: true })
   })

   it("returns null for unknown emails", () => {
      expect(rosterLookup(ROSTER, "nobody@example.com")).toBeNull()
   })

   it("returns null for an inactive entry (revocation)", () => {
      expect(rosterLookup(ROSTER, "revoked@example.com")).toBeNull()
   })
})

describe("parseRoster", () => {
   it("treats an absent or empty roster as authorizing nobody", () => {
      expect(parseRoster(undefined)).toEqual({})
      expect(parseRoster("")).toEqual({})
      expect(parseRoster("{}")).toEqual({})
   })

   it("authorizes nobody on unparseable JSON rather than throwing", () => {
      expect(parseRoster("{not json")).toEqual({})
      // A JSON scalar is not a roster either.
      expect(parseRoster('"nope"')).toEqual({})
   })

   it("drops malformed rows and keeps the healthy ones", () => {
      const parsed = parseRoster(
         JSON.stringify({
            "good@example.com": { uid: "t1", active: true },
            "noactive@example.com": { uid: "t2" },
            // active must be a real boolean: a truthy STRING must not read as live.
            "stringy@example.com": { uid: "t3", active: "true" },
            "nouid@example.com": { active: true },
            "emptyuid@example.com": { uid: "", active: true },
            "null@example.com": null,
            "scalar@example.com": 5,
         }),
      )
      expect(Object.keys(parsed)).toEqual(["good@example.com"])
   })

   it("drops a row whose uid could never address a tenant path", () => {
      // The router only ever produces uids matching UID_RE, and authorization is
      // an equality test against one — so a row like this is unreachable by
      // construction. Dropping it at parse keeps it out of the / redirect too.
      const parsed = parseRoster(
         JSON.stringify({
            "a@example.com": { uid: "../etc", active: true },
            "b@example.com": { uid: "T1", active: true },
            "c@example.com": { uid: "has space", active: true },
            "d@example.com": { uid: "t1", active: true },
         }),
      )
      expect(Object.keys(parsed)).toEqual(["d@example.com"])
   })

   it("memoizes per raw string without leaking a previous roster", () => {
      const a = JSON.stringify({ "a@example.com": { uid: "t1", active: true } })
      expect(parseRoster(a)).toBe(parseRoster(a))
      expect(parseRoster(JSON.stringify({ "b@example.com": { uid: "t2", active: true } }))).toEqual({
         "b@example.com": { uid: "t2", active: true },
      })
      // …and back again: the memo must not have pinned the first value.
      expect(parseRoster(a)).toEqual({ "a@example.com": { uid: "t1", active: true } })
   })
})
