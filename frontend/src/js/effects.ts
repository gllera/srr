// effects.ts — derived rendering
// (docs/superpowers/specs/2026-09-15-frontend-state-store-design.md).
//
// Every paint that is a PROJECTION of the model is one named effect here,
// registered once by app.ts's init(). An effect reads model atoms and the
// layout record, and calls its surface under untracked(), so a surface that
// happens to read a signal can never widen the effect's dependency set.
// Surfaces arrive injected (EffectSurfaces): this module imports no controller,
// which is what lets effects.test.ts register the real table against fakes.
//
// Deliberately NOT here: the article render (guard() does it — it IS the
// navigation), the frontier-undo snackbar offer (a response to one write, not a
// projection of state), and anything that navigates.
import { layout } from "./layout"
import * as model from "./model"
import { arrayEqual, diffedForEffects, effect, resource, untracked } from "./signals"

// An effect whose body must not run inside a command (D3, S16): it tracks
// `inputs`, waits out model.rendering, and runs once per change of the input
// tuple — so a guarded landing that moved three of its inputs costs one run, at
// the end, over the state the command left. `prev` is the tuple of the last run
// (null on the first), for bodies that care what moved. The one "effect + diff
// + act" state machine lives in signals.ts (onChange()'s own primitive); this
// is that machine with this table's two policies — always fire once, wait out
// a render — as parameters, not a second hand-rolled copy of it.
function deferred(inputs: () => unknown[], body: (now: unknown[], prev: unknown[] | null) => void): () => void {
   return diffedForEffects(inputs, body, { equals: arrayEqual, fireOnFirst: true, skip: () => model.rendering() })
}

export interface EffectSurfaces {
   // titleAndBadge: the active store's [ALL] unread tally, the list's tab title,
   // and the one writer of the badge + the title's leading count.
   unreadTotal(): Promise<number>
   setListTitle(): void
   applyUnreadTotal(total: number): void

   // pickerStatus: refill an OPEN settings menu's status footer (a no-op when closed).
   refreshSettingsStatus(): void

   // readerChrome: probe the article on screen (nav.probeCurrent) and paint its
   // prev/next + pending pill (reader.applyChrome).
   probeChrome(): Promise<IShowFeed | null>
   applyChrome(o: IShowFeed, pulseOnGrowth: boolean): void
   // saveButton: the ★ toggle (reader.paintSaveButton; nav.isSaved).
   paintSaveButton(canSave: boolean, saved: boolean): void
   isSaved(chron: number): boolean
   // feedLabel: the now-viewing readout + the back-button breadcrumb.
   paintFeedLabel(): void

   // listSurface: rebuild a mounted list whose membership moved (list.reconcile),
   // re-sync the search bar after it, report a failed rebuild.
   reconcileList(mounted: boolean): Promise<void> | null
   afterListBuild(): void
   onListError(e: unknown): void
   // listRows: re-derive dots/stars/highlight in place; under split, bring the
   // cursor row along after a reader-side step.
   refreshListRows(): void
   followListCursor(): void
   // listGrowth: reopen the list's top after an adopted snapshot.
   listGrown(): void
   // pickerRows: repaint an OPEN picker.
   pickerOpen(): boolean
   renderPicker(): void
}

export interface Effects {
   // guard() calls this right after reader.render(o), while model.rendering is
   // still held: the chrome it just painted is current for today's inputs (D3).
   markChromePainted(): void
   dispose(): void
}

export function registerEffects(s: EffectSurfaces): Effects {
   const stops: Array<() => void> = []

   // ── titleAndBadge (RDR12) ───────────────────────────────────────────────────
   // The tally is a resource keyed on what can change it — the seen map, the
   // adopted snapshot, the active store — so a burst of writes collapses to the
   // newest key (the token guard drops older runs), and a rejection leaves the
   // last written total up rather than surfacing anywhere.
   const total = resource(
      () => [model.seen(), model.snapshot(), model.activeMid()],
      () => s.unreadTotal(),
      arrayEqual,
   )
   stops.push(total.dispose)
   stops.push(
      effect(() => {
         const n = total.value()
         if (n !== undefined) untracked(() => s.applyUnreadTotal(n))
      }),
   )
   // The LIST's tab title, whenever the list holds focus and whenever what it
   // names moved under it (a lane, a store, a feed renamed by a refresh). The
   // reader names its own article through ReaderDeps.setTitle on each render.
   stops.push(
      deferred(
         () => [layout().focus, model.laneTokens(), model.activeMid(), model.snapshot()],
         ([focus]) => {
            if (focus === "list") s.setListTitle()
         },
      ),
   )

   // ── pickerStatus ────────────────────────────────────────────────────────────
   // The settings menu's footer reads sync.state(), refresh.lastRefreshError()
   // and the store's freshness; each of those publishes an atom.
   stops.push(
      effect(() => {
         model.syncStatus()
         model.refreshError()
         model.snapshot()
         untracked(() => s.refreshSettingsStatus())
      }),
   )

   // ── readerChrome (D3) ───────────────────────────────────────────────────────
   // prev/next + the pending pill for the article the pane shows, re-derived
   // whenever something it counts moved WITHOUT a render: a frontier gesture, a
   // Show-read flip, a store refresh, a row swipe, a sync merge. A landing is
   // painted by reader.render from the IShowFeed showFeed already computed, so
   // guard() holds model.rendering across it and records the key it painted;
   // the resource starts nothing for those inputs, and a landing costs exactly
   // the probes it cost before this effect existed.
   const chromeKey = (): unknown[] => {
      const c = model.cursor()
      return [
         c.chron,
         c.feedId,
         model.laneTokens(),
         model.unreadOnly(),
         model.frontierEpoch(),
         model.seen(),
         model.saved(),
         model.snapshot(),
         model.activeMid(),
      ]
   }
   let paintedKey: unknown[] | null = null
   let paintedGrowth = untracked(() => model.storeGrown())
   const chrome = resource<unknown[] | null, IShowFeed | null>(
      () => {
         const live = layout().readerLive
         const key = chromeKey()
         if (model.rendering() || !live) return null
         return paintedKey !== null && arrayEqual(key, paintedKey) ? null : key
      },
      (key) => (key === null ? Promise.resolve(null) : s.probeChrome()),
      (a, b) => a === b || (a !== null && b !== null && arrayEqual(a, b)),
   )
   stops.push(chrome.dispose)
   stops.push(
      effect(() => {
         const o = chrome.value()
         // Tracked, not untracked: a probe that resolves to the SAME object a
         // prior probe already applied (a static fake, or a store that genuinely
         // hasn't changed) must still repaint — the input that triggered it (a
         // frontier move, a merge) is real even when the projected chrome isn't.
         // Reading pending() here is what makes a settled fetch retrigger this
         // effect regardless of the resolved value's identity.
         if (!o || chrome.pending()) return
         untracked(() => {
            const grown = model.storeGrown()
            s.applyChrome(o, grown !== paintedGrowth)
            paintedGrowth = grown
            paintedKey = chromeKey()
         })
      }),
   )

   // ── saveButton (S20) ────────────────────────────────────────────────────────
   // Synchronous: a star written anywhere — the reader's button, a row's star, a
   // row swipe, a sync merge — repaints the button describing that article.
   stops.push(
      effect(() => {
         const c = model.cursor()
         model.saved()
         const painted = model.readerPainted()
         untracked(() => {
            const canSave = painted && c.chron >= 0
            s.paintSaveButton(canSave, canSave && s.isSaved(c.chron))
         })
      }),
   )

   // ── feedLabel (S20) ─────────────────────────────────────────────────────────
   // The readout names the lane and — with more than one store mounted — the
   // store; reader.paintFeedLabel memoizes on both, so a no-change run is cheap.
   stops.push(
      effect(() => {
         model.laneTokens()
         model.activeMid()
         model.mountsRev()
         model.snapshot()
         untracked(() => s.paintFeedLabel())
      }),
   )

   // ── listSurface ─────────────────────────────────────────────────────────────
   // The list's MEMBERSHIP moved without a list command (a Show-read flip, a
   // bulk frontier move under unread-only, a typed query, a store switch): let the
   // list decide between nothing, invalidate (hidden) and rebuild (on screen).
   stops.push(
      deferred(
         () => [layout().listMounted, model.laneTokens(), model.unreadOnly(), model.frontierEpoch(), model.activeMid()],
         ([listMounted]) => {
            const build = s.reconcileList(listMounted as boolean)
            if (build)
               build.then(
                  () => s.afterListBuild(),
                  (e: unknown) => s.onListError(e),
               )
         },
      ),
   )

   // ── listRows ────────────────────────────────────────────────────────────────
   // Read/unread weight, stars and the current-row highlight follow the seen
   // map, the saved set and the cursor. Under split with a live pane, a cursor
   // the READER moved brings its row along (followCursor refreshes too); a list
   // hidden behind the single-surface reader re-derives on its way back (show()).
   stops.push(
      deferred(
         () => [layout().listMounted, layout().split, layout().readerLive, model.cursor(), model.seen(), model.saved()],
         ([listMounted, split, readerLive, c], prev) => {
            if (!listMounted) return
            const wasLive = prev?.[2] as boolean | undefined
            const moved = prev !== null && (prev[3] as model.Cursor).chron !== (c as model.Cursor).chron
            const becameLive = wasLive !== undefined && !wasLive && readerLive
            if (split && readerLive && (moved || becameLive)) s.followListCursor()
            else s.refreshListRows()
         },
      ),
   )

   // ── listGrowth ──────────────────────────────────────────────────────────────
   // Every adopted snapshot reopens the top of an on-screen list (the "N new"
   // pill, S21) — once per snapshot, never for a layout change.
   stops.push(
      deferred(
         () => [layout().listMounted, model.snapshot()],
         ([listMounted, n], prev) => {
            if (prev === null || prev[1] === n) return
            if (listMounted) s.listGrown()
         },
      ),
   )

   // ── pickerRows ──────────────────────────────────────────────────────────────
   // An open picker's rows, badges and scope chips count the lane, the device
   // state, the store and the mount table.
   stops.push(
      deferred(
         () => [
            model.laneTokens(),
            model.seen(),
            model.saved(),
            model.snapshot(),
            model.unreadOnly(),
            model.mountsRev(),
            model.activeMid(),
         ],
         (_now, prev) => {
            if (prev !== null && s.pickerOpen()) s.renderPicker()
         },
      ),
   )

   return {
      markChromePainted: () =>
         untracked(() => {
            paintedKey = chromeKey()
            paintedGrowth = model.storeGrown()
         }),
      dispose: () => stops.forEach((stop) => stop()),
   }
}
