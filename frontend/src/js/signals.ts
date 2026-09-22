// signals.ts — the reactive primitive under the app's state model
// (docs/superpowers/specs/2026-09-15-frontend-state-store-design.md). A LEAF,
// like keys.ts/urlish.ts/motion.ts: it imports nothing.
//
// Version-based pull. Every signal and computed carries a version that bumps
// only when its value actually changed; a dependent records the version it read,
// and "did anything I depend on move?" is a version compare. A write marks
// dependents stale (push) and a flush re-validates them (pull), which is what
// gives computed its equality cutoff without a second propagation pass.
//
// The flush is SYNCHRONOUS at the end of the outermost batch — no scheduler, no
// microtask. A write returns only after every effect it feeds has run, except
// the ones that choose to wait: effects.ts's deferred paints skip while
// model.rendering is held and run when the command's hold is released. The only
// asynchrony anywhere in this module is a resource loader's own promise.

export interface Signal<T> {
   (): T
   set(v: T): void
   update(f: (v: T) => T): void
}

export type Equals<T> = (a: T, b: T) => boolean

export interface Resource<T> {
   value(): T | undefined
   pending(): boolean
   error(): unknown
   refetch(): void
   dispose(): void
}

// A flush that needs more passes than this is an effect cycle — a bug, not a retry.
export const MAX_FLUSH_ITERATIONS = 100

interface Source {
   version: number
   observers: Set<Observer>
}

interface Observer {
   deps: Map<Source, number>
   markStale(): void
}

let tracking: Observer | null = null
let batchDepth = 0
let flushing = false
let effectSeq = 0
const pending = new Set<EffectNode>()

function track(src: Source): void {
   if (tracking && !tracking.deps.has(src)) {
      tracking.deps.set(src, src.version)
      src.observers.add(tracking)
   }
}

// Run fn as `node`, re-collecting its dependency set from scratch (semantic 2).
function collect<R>(node: Observer, fn: () => R): R {
   for (const src of node.deps.keys()) src.observers.delete(node)
   node.deps = new Map()
   const prev = tracking
   tracking = node
   try {
      return fn()
   } finally {
      tracking = prev
   }
}

// Has any recorded dependency moved? Computed deps are brought up to date first,
// so a computed that recomputed to an EQUAL value reads as unmoved (semantic 3).
function depsMoved(deps: Map<Source, number>): boolean {
   for (const [src, seen] of deps) {
      if (src instanceof ComputedNode) src.refresh()
      if (src.version !== seen) return true
   }
   return false
}

class SignalNode<T> implements Source {
   version = 0
   observers = new Set<Observer>()
   constructor(
      public value: T,
      private readonly equals: Equals<T>,
   ) {}

   get(): T {
      track(this)
      return this.value
   }

   set(v: T): void {
      if (this.equals(this.value, v)) return
      this.value = v
      this.version++
      for (const o of [...this.observers]) o.markStale()
      if (batchDepth === 0) flush()
   }
}

class ComputedNode<T> implements Source, Observer {
   version = 0
   observers = new Set<Observer>()
   deps = new Map<Source, number>()
   private stale = true
   private has = false
   private value: T | undefined
   // What the last computation threw, if it threw. A throw is this node's value
   // for its current dependency versions, not a reason to stay stale: a stale
   // node stops propagating (markStale returns early), so its readers would
   // never hear of the write that fixes it.
   private failure: { error: unknown } | null = null

   constructor(
      private readonly fn: () => T,
      private readonly equals: Equals<T>,
   ) {}

   markStale(): void {
      if (this.stale) return
      this.stale = true
      for (const o of [...this.observers]) o.markStale()
   }

   refresh(): void {
      if (!this.stale) return
      if ((this.has || this.failure) && !depsMoved(this.deps)) {
         this.stale = false
         return
      }
      let next: T
      try {
         next = collect(this, this.fn)
      } catch (error) {
         this.stale = false
         this.failure = { error }
         this.version++
         return
      }
      this.stale = false
      // Recovering from a failure must bump version even when `next` equals
      // the LAST GOOD value — `this.value` was never touched while failing, so
      // an equals() check alone can't tell "recovered back to an old value"
      // from "never changed". A reader's stored dep version was captured
      // while `failure` was set (the throw branch above always bumps), so
      // skipping the bump here would leave that version looking unmoved and
      // the reader silently stuck on the stale error forever.
      const recovered = this.failure !== null
      this.failure = null
      if (!this.has || recovered || !this.equals(this.value as T, next)) {
         this.value = next
         this.version++
      }
      this.has = true
   }

   get(): T {
      this.refresh()
      // Tracked even when the value is a throw, so the reader re-runs once a
      // dependency moves.
      track(this)
      if (this.failure) throw this.failure.error
      return this.value as T
   }
}

class EffectNode implements Observer {
   readonly id = ++effectSeq
   deps = new Map<Source, number>()
   private ran = false
   private disposed = false
   private cleanup: (() => void) | undefined

   constructor(private readonly fn: () => void | (() => void)) {}

   markStale(): void {
      if (!this.disposed) pending.add(this)
   }

   runIfMoved(): void {
      if (this.disposed) return
      if (this.ran && !depsMoved(this.deps)) return
      this.runCleanup()
      this.ran = true
      const r = collect(this, this.fn)
      if (this.disposed) {
         // fn disposed its own effect: it may have read signals after doing so,
         // and the cleanup it just returned is the last one it gets to run.
         this.unsubscribe()
         if (typeof r === "function") r()
         return
      }
      if (typeof r === "function") this.cleanup = r
   }

   dispose(): void {
      if (this.disposed) return
      this.disposed = true
      pending.delete(this)
      this.unsubscribe()
      this.runCleanup()
   }

   private unsubscribe(): void {
      for (const src of this.deps.keys()) src.observers.delete(this)
      this.deps.clear()
   }

   private runCleanup(): void {
      const c = this.cleanup
      this.cleanup = undefined
      c?.()
   }
}

// Run every pending effect, in creation order, until none is pending (semantic
// 5). Re-entrant calls — a write made BY an effect — return at once: the loop
// below picks up what they scheduled. An effect's error does not stop the pass;
// the first one is rethrown once the flush is done (semantic 7).
function flush(): void {
   if (flushing) return
   flushing = true
   let failed = false
   let firstError: unknown
   try {
      for (let pass = 0; pending.size > 0; pass++) {
         if (pass >= MAX_FLUSH_ITERATIONS) {
            pending.clear()
            throw new Error("signals: effect cycle")
         }
         const due = [...pending].sort((a, b) => a.id - b.id)
         pending.clear()
         for (const e of due) {
            try {
               e.runIfMoved()
            } catch (err) {
               if (!failed) {
                  failed = true
                  firstError = err
               }
            }
         }
      }
   } finally {
      flushing = false
   }
   if (failed) throw firstError
}

export function signal<T>(init: T, equals: Equals<T> = Object.is): Signal<T> {
   const node = new SignalNode(init, equals)
   const read = (() => node.get()) as Signal<T>
   read.set = (v: T) => node.set(v)
   read.update = (f: (v: T) => T) => node.set(f(node.value))
   return read
}

export function computed<T>(fn: () => T, equals: Equals<T> = Object.is): () => T {
   const node = new ComputedNode(fn, equals)
   return () => node.get()
}

// Runs fn once now — or when the enclosing batch closes, or later in the flush
// that is already running when it is created — and again whenever a dependency
// moved. Returns dispose.
export function effect(fn: () => void | (() => void)): () => void {
   const node = new EffectNode(fn)
   pending.add(node)
   if (batchDepth === 0) flush()
   return () => node.dispose()
}

export function batch(fn: () => void): void {
   batchDepth++
   let threw = false
   let bodyError: unknown
   try {
      fn()
   } catch (e) {
      threw = true
      bodyError = e
   } finally {
      batchDepth--
   }
   if (batchDepth === 0) {
      try {
         flush()
      } catch (e) {
         if (!threw) throw e
      }
   }
   if (threw) throw bodyError
}

export function untracked<T>(fn: () => T): T {
   const prev = tracking
   tracking = null
   try {
      return fn()
   } finally {
      tracking = prev
   }
}

// An async derivation over the primitive (semantic 9): an effect that reads
// deps(), and for a key it has not already started, runs loader(key) under a
// fresh token. Only the newest run may publish — the token guard the reader's
// old hand-rolled chrome re-probe did by hand, now the `readerChrome` effect
// in `effects.ts`.
export function resource<K, T>(
   deps: () => K,
   loader: (key: K) => Promise<T>,
   keyEquals: Equals<K> = Object.is,
): Resource<T> {
   const value = signal<T | undefined>(undefined)
   const busy = signal(false)
   const error = signal<unknown>(undefined)
   const forced = signal(0)
   let token = 0
   let started = false
   let lastKey: K | undefined
   let lastForced = 0
   const stop = effect(() => {
      const key = deps()
      const f = forced()
      if (started && f === lastForced && keyEquals(lastKey as K, key)) return
      started = true
      lastKey = key
      lastForced = f
      const my = ++token
      busy.set(true)
      error.set(undefined)
      let run: Promise<T>
      try {
         run = untracked(() => loader(key))
      } catch (e) {
         run = Promise.reject(e)
      }
      run.then(
         (v) => {
            if (my !== token) return
            batch(() => {
               value.set(v)
               busy.set(false)
            })
         },
         (e: unknown) => {
            if (my !== token) return
            batch(() => {
               error.set(e)
               busy.set(false)
            })
         },
      )
   })
   return {
      value: () => value(),
      pending: () => busy(),
      error: () => error(),
      refetch: () => forced.update((n) => n + 1),
      dispose: () => {
         token++
         stop()
         busy.set(false)
      },
   }
}

export interface DiffedOpts<K> {
   equals?: Equals<K>
   // Fire on the very first run too (with prev === null) — for a caller whose
   // first run is itself a paint to do, as opposed to onChange()'s callers,
   // whose first run is a baseline rather than a change.
   fireOnFirst?: boolean
   // A gate re-checked on every run, independent of whether dep() changed: while
   // it holds, the body must not run (effects.ts's model.rendering). The
   // baseline is primed on the very FIRST run even when held — the state before
   // the command, which a "what moved" body needs — and frozen while held, so a
   // change made under the hold is compared against that baseline once the hold
   // clears rather than lost. The first run that is not held fires
   // unconditionally (nothing has acted yet); every later one is the ordinary
   // equal-value skip.
   hold?: () => boolean
}

// The one "effect + diff + act under untracked" state machine: onChange() and
// effects.ts's deferred() are both one-line wrappers over it.
export function diffed<K>(dep: () => K, body: (now: K, prev: K | null) => void, opts: DiffedOpts<K> = {}): () => void {
   const { equals = Object.is, fireOnFirst = false, hold } = opts
   let last: K | null = null
   let primed = false
   let ran = !fireOnFirst // the first run is a baseline, not a change, unless the caller says otherwise
   return effect(() => {
      const now = dep()
      const prev = primed ? last : null
      if (!primed) {
         primed = true
         last = now
      }
      if (hold?.()) return
      if (ran && equals(last as K, now)) return
      ran = true
      last = now
      untracked(() => body(now, prev))
   })
}

// Fires body on every dependency change AFTER the first — the initial
// subscribe establishes a baseline rather than being a "change" itself.
// Several modules hand-rolled this "prime, then diff and act" shape over
// profileRev/activeMid-style merge counters; this is the one copy.
export function onChange<K>(dep: () => K, body: (now: K, prev: K) => void, equals: Equals<K> = Object.is): () => void {
   return diffed(dep, (now, prev) => body(now, prev as K), { equals })
}

export function shallowEqual<T extends object>(a: T, b: T): boolean {
   if (Object.is(a, b)) return true
   const ka = Object.keys(a)
   const kb = Object.keys(b)
   if (ka.length !== kb.length) return false
   const ra = a as Record<string, unknown>
   const rb = b as Record<string, unknown>
   for (const k of ka) if (!Object.prototype.hasOwnProperty.call(rb, k) || !Object.is(ra[k], rb[k])) return false
   return true
}

export function arrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
   if (a === b) return true
   if (a.length !== b.length) return false
   for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
   return true
}
