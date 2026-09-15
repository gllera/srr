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
// microtask. That is load-bearing for app.ts's guard(): when `await fn()`
// returns, every derived paint for the writes made inside it has already run.
// The only asynchrony anywhere in this module is a resource loader's own promise.

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
      if (this.has && !depsMoved(this.deps)) {
         this.stale = false
         return
      }
      // A throwing fn leaves the node stale, so the next read retries.
      const next = collect(this, this.fn)
      this.stale = false
      if (!this.has || !this.equals(this.value as T, next)) {
         this.value = next
         this.version++
      }
      this.has = true
   }

   get(): T {
      this.refresh()
      track(this)
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
      if (typeof r === "function") this.cleanup = r
   }

   dispose(): void {
      if (this.disposed) return
      this.disposed = true
      pending.delete(this)
      for (const src of this.deps.keys()) src.observers.delete(this)
      this.deps.clear()
      this.runCleanup()
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
// fresh token. Only the newest run may publish — the token guard
// reader.reprobeReaderChrome used to do by hand.
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
