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
import { layout, type Layout } from "./layout"
import * as model from "./model"
import { arrayEqual, effect, resource, signal, untracked } from "./signals"

// An effect whose body must not run inside a command (D3, S16): it tracks
// `inputs`, waits out model.rendering, and runs once per change of the input
// tuple — so a guarded landing that moved three of its inputs costs one run, at
// the end, over the state the command left. `prev` is the tuple of the last run
// (null on the first), for bodies that care what moved.
//
// This is now a small hand-rolled variant rather than a one-line wrapper over
// signals.ts's diffed() (still exported there as diffedForEffects — currently
// unused by this file, kept for the general "effect + diff + act" shape it
// documents; see its own docblock). The two diverge on ONE thing: diffed()'s
// `skip` bails out before ever priming (`last`/`primed` untouched), so an
// effect table whose registration itself happens under a hold — which is what
// app.ts's boot hold now does, task 9 — would prime with a null `prev` against
// whatever state the FIRST held command lands on, discarding the true
// pre-command baseline every "what moved" body (listRows) needs. This version
// primes on the first run regardless of hold, freezes that baseline while
// held, and always fires once, unconditionally, on the first run that isn't
// held. Revisit collapsing the two back into one primitive if diffed() grows
// a second caller with this same "prime through a hold" need.
//
// The baseline (`last`) is captured on the effect's VERY FIRST run — even one
// that lands while rendering is held, which is exactly what happens now that
// app.ts wraps the table's own registration in a boot hold (so nothing primes
// against nav's pre-route state). While held, `last` is FROZEN at that
// baseline rather than tracking every intermediate write a command makes — a
// caller like listRows reads `prev` to ask "what moved", and the answer is the
// gap between the state before the command and the state it landed, not
// whatever the command's own writes looked like mid-flight.
//
// `body` itself only ever runs outside a hold, and the FIRST time it runs is
// unconditional — even when the held state happened to settle back to exactly
// the frozen baseline (an [ALL] boot re-applying [] over [], the empty-store
// resting panel) — because nothing has actually been PAINTED yet; skipping
// that first call on an equality match would mean the effect never renders at
// all. Every call after that first one is the ordinary equal-value skip.
//
// A side effect of that unconditional first call: `prev` on it is the frozen
// PRE-hold baseline, not null — a caller whose body only acts when `prev !==
// null` (pickerRows, below) now sees a non-null `prev` on its very first run
// too, where every earlier version of this table always handed the first
// call `prev: null`. Currently harmless (nothing can open the picker before
// `registerEffects()` returns, so pickerRows' own first-ever call always has
// `pickerOpen() === false` regardless of `prev`) — pinned benign by the
// "keeps its PRE-hold baseline across a boot hold" case in effects.test.ts's
// `listRows` describe, which exercises the same first-call `prev` on the
// sibling effect that DOES act on it.
function deferred(inputs: () => unknown[], body: (now: unknown[], prev: unknown[] | null) => void): () => void {
   let last: unknown[] | null = null
   let primed = false
   let ran = false // has `body` itself run at least once — not "was something painted": paint() swallows a surface's own errors, and a body can return early without calling it
   return effect(() => {
      const now = inputs()
      const held = model.rendering()
      if (!primed) {
         primed = true
         last = now
         if (held) return
         ran = true
         untracked(() => body(now, null))
         return
      }
      if (held) return
      if (!ran) {
         const prev = last
         ran = true
         last = now
         untracked(() => body(now, prev))
         return
      }
      if (last !== null && arrayEqual(last, now)) return
      const prev = last
      last = now
      untracked(() => body(now, prev))
   })
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
   // saveButton: the ★ toggle (reader.paintSaveButton).
   paintSaveButton(canSave: boolean, saved: boolean): void
   // feedLabel: the now-viewing readout + the back-button breadcrumb.
   paintFeedLabel(): void

   // restingPane: the split view's resting panel for a pane that shows no
   // article beside the list (nav.restingState → reader.renderResting).
   restingState(): Promise<IShowFeed | null>
   renderResting(o: IShowFeed): void

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

   // A surface threw: report it. The flush and the write that triggered it go on.
   onPaintError(e: unknown): void
}

export interface Effects {
   // guard() calls this right after reader.render(o), while model.rendering is
   // still held: the chrome it just painted is current for the inputs the
   // landing committed (D3).
   markChromePainted(): void
}

export function registerEffects(s: EffectSurfaces): Effects {
   // A surface that throws is that surface's bug, not the writer's. Signals
   // semantic 7 would rethrow it from whichever model write triggered the flush
   // — an owner half-way through its bookkeeping, or guard() about to release
   // the mutex — so every surface call goes through here and is reported
   // instead.
   const paint = (fn: () => void): void => {
      try {
         untracked(fn)
      } catch (e) {
         s.onPaintError(e)
      }
   }

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
   effect(() => {
      const n = total.value()
      if (n !== undefined) paint(() => s.applyUnreadTotal(n))
   })
   // The LIST's tab title, whenever the list holds focus and whenever what it
   // names moved under it (a lane, a store, a feed renamed by a refresh). The
   // reader names its own article through ReaderDeps.setTitle on each render.
   deferred(
      () => [layout().focus, model.laneTokens(), model.activeMid(), model.snapshot()],
      ([focus]) => {
         if (focus === "list") paint(s.setListTitle)
      },
   )

   // ── pickerStatus ────────────────────────────────────────────────────────────
   // The settings menu's footer reads sync.state(), refresh.lastRefreshError()
   // and the store's freshness; each of those publishes an atom.
   effect(() => {
      model.syncStatus()
      model.refreshError()
      model.snapshot()
      paint(s.refreshSettingsStatus)
   })

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
   // The chrome inputs as the landing COMMITTED them: nav's resolve() writes the
   // cursor and its seen raise in one batch, so this runs once per landing with
   // both in place. A write that lands later, while showFeed's probes are still
   // awaited (a sync merge, a row ★), is not in what reader.render is about to
   // paint — so markChromePainted records this key rather than the one current
   // at paint time, and that later write still gets its probe.
   let landingKey: unknown[] | null = null
   effect(() => {
      model.cursor()
      if (untracked(() => model.rendering())) landingKey = untracked(chromeKey)
   })
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
   effect(() => {
      const o = chrome.value()
      // Tracked, not untracked: a probe that resolves to the SAME object a
      // prior probe already applied (a static fake, or a store that genuinely
      // hasn't changed) must still repaint — the input that triggered it (a
      // frontier move, a merge) is real even when the projected chrome isn't.
      // Reading pending() here is what makes a settled fetch retrigger this
      // effect regardless of the resolved value's identity. A failed probe
      // applies nothing: the resource keeps the previous value, which describes
      // different inputs.
      if (!o || chrome.pending() || chrome.error() !== undefined) return
      paint(() => {
         const grown = model.storeGrown()
         s.applyChrome(o, grown !== paintedGrowth)
         paintedGrowth = grown
         paintedKey = chromeKey()
      })
   })

   // ── saveButton (S20) ────────────────────────────────────────────────────────
   // Synchronous: a star written anywhere — the reader's button, a row's star, a
   // row swipe, a sync merge — repaints the button describing that article.
   effect(() => {
      const c = model.cursor()
      const saved = model.saved()
      const painted = model.readerPainted()
      paint(() => {
         const canSave = painted && c.chron >= 0
         s.paintSaveButton(canSave, canSave && saved.includes(c.chron))
      })
   })

   // ── feedLabel (S20) ─────────────────────────────────────────────────────────
   // The readout names the lane and — with more than one store mounted — the
   // store; reader.paintFeedLabel memoizes on both, so a no-change run is cheap.
   effect(() => {
      model.laneTokens()
      model.activeMid()
      model.mountsRev()
      model.snapshot()
      paint(s.paintFeedLabel)
   })

   // ── restingPane (D4) ────────────────────────────────────────────────────────
   // Under split, a list-focused pane with no live article shows the resting
   // panel — derived, not remembered. It repaints when that condition turns true
   // and when what the panel counts moved while it holds; never on the cursor,
   // which the list moves on every row step and the panel does not follow. A
   // probe that lands after the layout moved on — an article opened, a newer
   // run — drops. One that lands while a command holds rendering is retried
   // once the hold ends instead: the command may leave the pane resting with
   // none of these inputs moved (a crossing's list rebuild outlasts the probe
   // its own flush started), and a dropped paint nothing re-arms is a blank pane.
   const resting = (l: Layout) => l.split && l.focus === "list" && !l.readerLive
   const restingRetry = signal(0)
   let restingGen = 0
   deferred(
      () => [
         resting(layout()),
         model.laneTokens(),
         model.unreadOnly(),
         model.frontierEpoch(),
         // The panel's pill and copy count the device state too: a row swipe or
         // a sync merge moves them while the pane rests.
         model.seen(),
         model.saved(),
         model.activeMid(),
         model.snapshot(),
         restingRetry(),
      ],
      ([now]) => {
         const my = ++restingGen
         if (!now) return
         void s
            .restingState()
            .catch(() => null)
            .then((o) => {
               if (!o || my !== restingGen || !resting(layout())) return
               if (model.rendering()) return restingRetry.update((n) => n + 1)
               paint(() => s.renderResting(o))
            })
      },
   )
   // (.then runs outside any effect, so those reads subscribe nothing.)

   // ── listSurface ─────────────────────────────────────────────────────────────
   // The list's MEMBERSHIP moved without a list command (a Show-read flip, a
   // bulk frontier move under unread-only, a typed query, a store switch): let the
   // list decide between nothing, invalidate (hidden) and rebuild (on screen).
   deferred(
      () => [layout().listMounted, model.laneTokens(), model.unreadOnly(), model.frontierEpoch(), model.activeMid()],
      ([listMounted]) => {
         paint(() => {
            const build = s.reconcileList(listMounted as boolean)
            if (build)
               build.then(
                  () => s.afterListBuild(),
                  (e: unknown) => s.onListError(e),
               )
         })
      },
   )

   // ── listRows ────────────────────────────────────────────────────────────────
   // Read/unread weight, stars and the current-row highlight follow the seen
   // map, the saved set and the cursor. Under split with a live pane, a cursor
   // the READER moved brings its row along (followCursor refreshes too) — but
   // not on the crossing itself, whose re-layout tail (app.ts relayoutPane)
   // rebuilds or follows on its own. A cursor the LIST moved (its own row step,
   // with no live reader) needs nothing: selectRow already painted it. A list
   // hidden behind the single-surface reader re-derives on its way back.
   deferred(
      () => [layout().listMounted, layout().split, layout().readerLive, model.cursor(), model.seen(), model.saved()],
      ([listMounted, split, readerLive, c, seen, saved], prev) => {
         if (!listMounted) return
         // A split pane with nothing under the cursor has no row to follow, but it
         // may have no ROWS either: a guarded placeholder landing (a reload onto a
         // caught-up #pos) moves nothing tracked here and runs no list command.
         // followCursor rebuilds only a window built for another membership.
         if (split && (c as model.Cursor).chron < 0) paint(s.followListCursor)
         if (prev !== null && prev[0] === listMounted && prev[1] === split) {
            const moved = (prev[3] as model.Cursor).chron !== (c as model.Cursor).chron
            const becameLive = !prev[2] && (readerLive as boolean)
            if (split && readerLive && (moved || becameLive)) return paint(s.followListCursor)
            const onlyCursor = prev[2] === readerLive && prev[4] === seen && prev[5] === saved
            if (onlyCursor && !readerLive) return
         }
         paint(s.refreshListRows)
      },
   )

   // ── listGrowth ──────────────────────────────────────────────────────────────
   // Every adopted snapshot reopens the top of an on-screen list (the "N new"
   // pill, S21) — once per snapshot, never for a layout change.
   deferred(
      () => [layout().listMounted, model.snapshot()],
      ([listMounted, n], prev) => {
         if (prev === null || prev[1] === n) return
         if (listMounted) paint(s.listGrown)
      },
   )

   // ── pickerRows ──────────────────────────────────────────────────────────────
   // An open picker's rows, badges and scope chips count the lane, the device
   // state, the store and the mount table.
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
         if (prev !== null && s.pickerOpen()) paint(s.renderPicker)
      },
   )

   return {
      markChromePainted: () =>
         untracked(() => {
            paintedKey = landingKey ?? chromeKey()
            landingKey = null
            paintedGrowth = model.storeGrown()
         }),
   }
}
