import { describe, expect, it } from "vitest"
import { ROSTER, rosterLookup } from "../src/roster"

describe("rosterLookup", () => {
   const t1email = Object.entries(ROSTER).find(([, v]) => v.uid === "t1")![0]

   it("maps a roster email to its tenant", () => {
      expect(rosterLookup(t1email)).toEqual({ uid: "t1", active: true })
   })

   it("is case-insensitive on the email", () => {
      expect(rosterLookup(t1email.toUpperCase())).toEqual({ uid: "t1", active: true })
   })

   it("returns null for unknown emails", () => {
      expect(rosterLookup("nobody@example.com")).toBeNull()
   })

   it("returns null for an inactive entry", () => {
      expect(rosterLookup("inactive@test.invalid")).toBeNull()
   })
})
