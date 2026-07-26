import { describe, it, expect, vi, beforeEach } from "vitest"

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
}))
vi.mock("./data", () => data)

const nav = vi.hoisted(() => ({
   pendingFrontierUndo: vi.fn<() => { mid: string; prev: Record<string, number | undefined>; to: number } | null>(
      () => null,
   ),
   frontierUndoSize: vi.fn(async () => 0),
   markFrontierUndoOffered: vi.fn(),
   undoFrontierMove: vi.fn(() => true),
   isUnreadOnly: vi.fn(() => false),
   applyFilter: vi.fn(),
   filterTokens: vi.fn(() => [] as string[]),
   markAllRead: vi.fn(() => true),
   markUnreadFrom: vi.fn(() => true),
   currentChron: vi.fn(() => -1),
}))
vi.mock("./nav", () => nav)

// afterFrontierMove's surface reconciliation — asserted only as "it ran".
const list = vi.hoisted(() => ({
   rerender: vi.fn(async () => {}),
   invalidate: vi.fn(),
   refresh: vi.fn(),
}))
vi.mock("./list", () => list)

import * as menus from "./menus"

const showSnackbar = vi.fn<(text: string, action?: { label: string; run: () => void }) => void>()
const hideSnackbar = vi.fn()
const reReadReader = vi.fn()

// The action the snackbar was handed — the thing that outlives the offer.
const undoButton = () => showSnackbar.mock.calls.at(-1)![1]!

beforeEach(() => {
   vi.clearAllMocks()
   mid = "0"
   data.activeStore.mockImplementation(() => ({ mid }))
   nav.pendingFrontierUndo.mockReturnValue(null)
   nav.frontierUndoSize.mockResolvedValue(0)
   nav.undoFrontierMove.mockReturnValue(true)
   nav.isUnreadOnly.mockReturnValue(false)
   menus.setup({
      view: () => "list",
      showError: vi.fn(),
      showSnackbar,
      hideSnackbar,
      syncUnreadBadge: vi.fn(async () => {}),
      reReadReader,
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
      expect(list.refresh).toHaveBeenCalled() // afterFrontierMove ran
   })

   // The reader is multi-store, the snackbar lives 8s, and NOTHING takes it
   // down on a store switch — app.ts's switchMount, a mount pick in the filter
   // picker and route()'s back/forward setActive all leave it up and clickable.
   // Every term of the answer is scoped to one store: the snapshot's `feed:<id>`
   // keys, the count it announced, and afterFrontierMove's reconciliation of
   // whatever lane is showing NOW. So the mount is what the button checks first
   // — the same argument, and the same shape, as list.ts's row-swipe record.
   it("Undo does nothing after the active store changed under the snackbar", async () => {
      await offer()
      mid = "s7" // the user switched stores while the offer was up
      undoButton().run()
      expect(nav.undoFrontierMove).not.toHaveBeenCalled()
      // The snackbar still goes away — the button was pressed, and leaving a
      // dead offer on screen would invite pressing it again.
      expect(hideSnackbar).toHaveBeenCalled()
      // …and no surface was reconciled for a move that did not happen.
      expect(list.refresh).not.toHaveBeenCalled()
      expect(reReadReader).not.toHaveBeenCalled()
   })
})
