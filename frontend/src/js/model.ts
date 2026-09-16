// model.ts — every piece of state a surface derives from, as signals
// (docs/superpowers/specs/2026-09-15-frontend-state-store-design.md). ATOMS
// ONLY: no logic, and no import of data/nav/seen or any surface — those modules
// WRITE into this one, each writing only the atoms it owns. The ownership table
// is docs/superpowers/plans/2026-09-15-frontend-architecture-trio-index.md §3
// (and frontend/docs/ARCHITECTURE.md), enforced by model.test.ts: always write
// through `import * as model from "./model"` as `model.<atom>.set(…)`.
import { HOME_MID } from "./keys"
import { arrayEqual, shallowEqual, signal } from "./signals"

export interface Cursor {
   chron: number
   feedId: number
}

// The settings footer's sync readout; sync.ts re-exports it as SyncState.
export interface SyncStatus {
   on: boolean
   okAt: number
   error: string
}

export type Focus = "list" | "reader"

// ── What is on screen ─────────────────────────────────────────────────────────
export const cursor = signal<Cursor>({ chron: -1, feedId: -1 }, (a, b) => a.chron === b.chron && a.feedId === b.feedId)
// The lane's identity; nav derives its membership.
export const laneTokens = signal<readonly string[]>([], arrayEqual)
export const unreadOnly = signal(false)
export const activeMid = signal<string>(HOME_MID)

// ── Device state (the VALUE after each write; localStorage stays the store) ────
export const seen = signal<Readonly<Record<string, number>>>({}, shallowEqual)
export const saved = signal<readonly number[]>([], arrayEqual) // insertion order, as srr-saved stores it
// Bumped only by a filter-scoped bulk frontier move (D1) — never by ordinary reading.
export const frontierEpoch = signal(0)
// Bumped by a profile merge that changed local state / moved the mount table (S14).
export const profileRev = signal(0)
export const profileMountsRev = signal(0)

// ── The store ─────────────────────────────────────────────────────────────────
// Bumped after nav and search reconciled to an adopted snapshot (D2).
export const snapshot = signal(0)
export const storeGrown = signal(0)
export const mountsRev = signal(0)

// ── Layout inputs (wired by the Layout plan) ──────────────────────────────────
export const split = signal(false)
export const focus = signal<Focus>("list")
export const paneHidden = signal(false)
export const readerPainted = signal(false)
// A command that ends in a surface paint is in flight (D3, S16).
export const rendering = signal(false)

// ── Status the settings footer reads ──────────────────────────────────────────
export const syncStatus = signal<SyncStatus>({ on: false, okAt: 0, error: "" }, shallowEqual)
export const refreshError = signal("")
