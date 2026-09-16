import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"

// menus.ts owns the frontier gestures' UI half. What is pinned here is the ONE
// piece of it that is a deferred action rather than a synchronous handler: the
// RDR1/RDR2 undo snackbar, whose button is answered up to SNACKBAR_MS (8s)
// after the offer was made. Everything else in the module (the two anchored
// menus, the Stores dialog) is driven at the app.ts layer, where the real
// dropdown/skeleton wiring lives — app.test.ts's "frontier undo snackbar" block
// covers this offer's ordinary lifecycle through that path. This suite exists
// for the case that path cannot reach: the ACTIVE STORE CHANGING while the
// snackbar is up.

// The active mount, settable — menus.ts reads only `.mid` on this path.
let mid = "0"
const data = vi.hoisted(() => ({
   activeStore: vi.fn(() => ({ mid: "0" })),
   applyMountTable: vi.fn(async (): Promise<string[]> => []),
   mountRecords: vi.fn(() => [{ id: "0", url: "http://localhost/", role: "home", cred: false, del: false }]),
}))
vi.mock("./data", () => data)

const nav = vi.hoisted(() => ({
   pendingFrontierUndo: vi.fn<() => { mid: string; prev: Record<string, number | undefined>; to: number } | null>(
      () => null,
   ),
   frontierUndoSize: vi.fn(async () => 0),
   markFrontierUndoOffered: vi.fn(),
   undoFrontierMove: vi.fn(() => true),
   bumpFrontierEpoch: vi.fn(),
   markAllRead: vi.fn(() => true),
   markUnreadFrom: vi.fn(() => true),
   currentChron: vi.fn(() => -1),
}))
vi.mock("./nav", () => nav)

import * as menus from "./menus"
import * as model from "./model"

const showSnackbar = vi.fn<(text: string, action?: { label: string; run: () => void }) => void>()
const hideSnackbar = vi.fn()
const rerunPlaceholder = vi.fn()
const showError = vi.fn()
// app.ts's rehome: runs the adoption as one command and lands home when it says so.
let landedHome = false
const rehome = vi.fn((adopt: () => boolean) => {
   landedHome = adopt()
})

// The action the snackbar was handed — the thing that outlives the offer.
const undoButton = () => showSnackbar.mock.calls.at(-1)![1]!

beforeEach(() => {
   vi.clearAllMocks()
   mid = "0"
   landedHome = false
   data.activeStore.mockImplementation(() => ({ mid }))
   nav.pendingFrontierUndo.mockReturnValue(null)
   nav.frontierUndoSize.mockResolvedValue(0)
   nav.undoFrontierMove.mockReturnValue(true)
   menus.setup({
      showError,
      showSnackbar,
      hideSnackbar,
      rerunPlaceholder,
      rehome,
   })
})

describe("offerFrontierUndo", () => {
   // A raise big enough to announce, taken on the home mount.
   const pending = { mid: "0", prev: { "feed:1": 0 }, to: 40 }

   const offer = async () => {
      nav.pendingFrontierUndo.mockReturnValue(pending)
      nav.frontierUndoSize.mockResolvedValue(42)
      await menus.offerFrontierUndo()
      expect(showSnackbar).toHaveBeenCalledTimes(1)
   }

   it("Undo replays the announced snapshot on the mount it was announced on", async () => {
      await offer()
      undoButton().run()
      expect(nav.undoFrontierMove).toHaveBeenCalledWith(pending)
      expect(hideSnackbar).toHaveBeenCalled()
      expect(nav.bumpFrontierEpoch).toHaveBeenCalled() // the bulk move is announced (D1)
      expect(rerunPlaceholder).toHaveBeenCalled() // and a placeholder re-resolves (S17)
   })

   // The reader is multi-store, the snackbar lives 8s, and NOTHING takes it
   // down on a store switch — app.ts's switchMount, a mount pick in the filter
   // picker and route()'s back/forward setActive all leave it up and clickable.
   // Every term of the answer is scoped to one store: the snapshot's `feed:<id>`
   // keys, the count it announced, and the write (bumpFrontierEpoch +
   // rerunPlaceholder) every surface showing NOW reconciles against. So the
   // mount is what the button checks first — the same argument, and the same
   // shape, as list.ts's row-swipe record.
   it("Undo does nothing after the active store changed under the snackbar", async () => {
      await offer()
      mid = "s7" // the user switched stores while the offer was up
      undoButton().run()
      expect(nav.undoFrontierMove).not.toHaveBeenCalled()
      // The snackbar still goes away — the button was pressed, and leaving a
      // dead offer on screen would invite pressing it again.
      expect(hideSnackbar).toHaveBeenCalled()
      // …and no surface was reconciled for a move that did not happen.
      expect(nav.bumpFrontierEpoch).not.toHaveBeenCalled()
      expect(rerunPlaceholder).not.toHaveBeenCalled()
   })
})

describe("mount-table changes", () => {
   it("adopts a mount table a merge moved (profileMountsRev)", () => {
      model.profileMountsRev.update((n) => n + 1)
      expect(data.applyMountTable).toHaveBeenCalledTimes(1)
   })

   it("lands on the home list when the active store was unmounted", () => {
      mid = "s7"
      data.applyMountTable.mockImplementationOnce(async () => {
         mid = "0" // data.ts falls back to home before its first await
         return []
      })
      menus.afterMountChange([])
      expect(rehome).toHaveBeenCalledTimes(1)
      expect(data.applyMountTable).toHaveBeenCalledTimes(1) // inside the command
      expect(landedHome).toBe(true)
   })

   it("leaves the surface alone when the active store survived", () => {
      menus.afterMountChange([])
      expect(rehome).toHaveBeenCalledTimes(1)
      expect(landedHome).toBe(false)
   })

   describe("telling the service worker", () => {
      const post = vi.fn()
      beforeEach(() => {
         Object.defineProperty(navigator, "serviceWorker", {
            value: { controller: { postMessage: post } },
            configurable: true,
         })
      })
      afterEach(() => {
         Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true })
      })

      it("posts the new roots at once, and again once the boots settle", async () => {
         let settle!: (v: string[]) => void
         data.applyMountTable.mockImplementationOnce(() => new Promise<string[]>((r) => (settle = r)))
         menus.afterMountChange([])
         expect(post).toHaveBeenCalledTimes(1) // the table is applied: a new peer's fetches route
         settle([])
         await new Promise((r) => setTimeout(r))
         expect(post).toHaveBeenCalledTimes(2)
      })

      it("a rejected adoption is reported, still re-posts, and never goes unhandled", async () => {
         data.applyMountTable.mockImplementationOnce(async () => {
            throw new Error("paint")
         })
         menus.afterMountChange([])
         await new Promise((r) => setTimeout(r))
         expect(showError).toHaveBeenCalledWith(new Error("paint"))
         expect(post).toHaveBeenCalledTimes(2)
      })
   })
})
