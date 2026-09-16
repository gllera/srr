import { describe, expect, it, vi } from "vitest"
import {
   arrayEqual,
   batch,
   computed,
   diffedForEffects,
   effect,
   MAX_FLUSH_ITERATIONS,
   onChange,
   resource,
   shallowEqual,
   signal,
   untracked,
} from "./signals"

// One macrotask: long enough for a resource loader's promise and its .then to land.
const tick = () => new Promise((r) => setTimeout(r))

describe("signal (semantic 1)", () => {
   it("reads its value, and set() replaces it", () => {
      const s = signal(1)
      expect(s()).toBe(1)
      s.set(2)
      expect(s()).toBe(2)
   })

   it("an equal set() is a no-op for dependents", () => {
      const s = signal(1)
      const runs = vi.fn()
      effect(() => void runs(s()))
      s.set(1)
      expect(runs).toHaveBeenCalledTimes(1)
      s.set(2)
      expect(runs).toHaveBeenCalledTimes(2)
      expect(runs).toHaveBeenLastCalledWith(2)
   })

   it("honours a custom equals", () => {
      const s = signal({ n: 1 }, (a, b) => a.n === b.n)
      const runs = vi.fn()
      effect(() => void runs(s().n))
      s.set({ n: 1 })
      expect(runs).toHaveBeenCalledTimes(1)
      s.set({ n: 2 })
      expect(runs).toHaveBeenCalledTimes(2)
   })

   it("update() applies a function of the current value", () => {
      const s = signal(4)
      s.update((n) => n + 1)
      expect(s()).toBe(5)
   })

   it("flushes before set() returns when no batch is open", () => {
      const s = signal(0)
      let seen = -1
      effect(() => {
         seen = s()
      })
      s.set(5)
      expect(seen).toBe(5)
   })
})

describe("dynamic dependencies (semantic 2)", () => {
   it("a branch that stops reading a signal stops depending on it", () => {
      const flag = signal(true)
      const a = signal(1)
      const b = signal(10)
      const runs = vi.fn()
      effect(() => void runs(flag() ? a() : b()))
      b.set(11) // not read yet
      expect(runs).toHaveBeenCalledTimes(1)
      flag.set(false)
      expect(runs).toHaveBeenCalledTimes(2)
      a.set(2) // no longer read
      expect(runs).toHaveBeenCalledTimes(2)
      b.set(12)
      expect(runs).toHaveBeenCalledTimes(3)
   })
})

describe("computed (semantic 3)", () => {
   it("is lazy: its function does not run until it is read", () => {
      const fn = vi.fn(() => 1)
      const c = computed(fn)
      expect(fn).not.toHaveBeenCalled()
      expect(c()).toBe(1)
      expect(fn).toHaveBeenCalledTimes(1)
   })

   it("memoizes until a dependency moves", () => {
      const s = signal(1)
      const fn = vi.fn(() => s() * 2)
      const c = computed(fn)
      c()
      c()
      expect(fn).toHaveBeenCalledTimes(1)
      s.set(2)
      expect(c()).toBe(4)
      expect(fn).toHaveBeenCalledTimes(2)
   })

   it("an effect does not re-run when the computed recomputes to an equal value", () => {
      const n = signal(1)
      const parity = computed(() => n() % 2)
      const runs = vi.fn()
      effect(() => void runs(parity()))
      n.set(3) // parity still 1
      expect(runs).toHaveBeenCalledTimes(1)
      n.set(4)
      expect(runs).toHaveBeenCalledTimes(2)
   })

   it("a custom equals cuts off structurally equal records", () => {
      const a = signal(1)
      const rec = computed(() => ({ odd: a() % 2 === 1 }), shallowEqual)
      const runs = vi.fn()
      effect(() => void runs(rec()))
      a.set(3)
      expect(runs).toHaveBeenCalledTimes(1)
   })

   it("a computed of a computed stays consistent", () => {
      const s = signal(2)
      const double = computed(() => s() * 2)
      const plusOne = computed(() => double() + 1)
      expect(plusOne()).toBe(5)
      s.set(3)
      expect(plusOne()).toBe(7)
   })
})

describe("effect (semantic 4)", () => {
   it("runs once immediately", () => {
      const runs = vi.fn()
      effect(runs)
      expect(runs).toHaveBeenCalledTimes(1)
   })

   it("created inside a batch, runs when the batch closes", () => {
      const runs = vi.fn()
      batch(() => {
         effect(runs)
         expect(runs).not.toHaveBeenCalled()
      })
      expect(runs).toHaveBeenCalledTimes(1)
   })

   it("runs a returned cleanup before the next run and on dispose", () => {
      const s = signal(0)
      const log: string[] = []
      const stop = effect(() => {
         const v = s()
         log.push("run" + v)
         return () => log.push("clean" + v)
      })
      s.set(1)
      stop()
      expect(log).toEqual(["run0", "clean0", "run1", "clean1"])
   })

   it("dispose stops further runs", () => {
      const s = signal(0)
      const runs = vi.fn()
      const stop = effect(() => void runs(s()))
      stop()
      s.set(1)
      expect(runs).toHaveBeenCalledTimes(1)
   })
})

describe("flush (semantics 5 and 7)", () => {
   it("runs pending effects in creation order, even after an earlier effect re-subscribed", () => {
      const s = signal(0)
      const t = signal(0)
      const order: string[] = []
      effect(() => void (s(), t(), order.push("a")))
      effect(() => void (s(), order.push("b")))
      t.set(1) // a re-runs and re-subscribes to s AFTER b
      order.length = 0
      s.set(1)
      expect(order).toEqual(["a", "b"])
   })

   it("a write made by an effect reaches its dependents in the same flush", () => {
      const src = signal(1)
      const doubled = signal(0)
      let seen = 0
      effect(() => doubled.set(src() * 2))
      effect(() => {
         seen = doubled()
      })
      src.set(5)
      expect(seen).toBe(10)
   })

   it("throws on an effect cycle", () => {
      expect(MAX_FLUSH_ITERATIONS).toBe(100)
      const s = signal(0)
      expect(() => effect(() => s.set(s() + 1))).toThrow("signals: effect cycle")
   })

   it("an effect that throws does not stop the flush; the first error is rethrown", () => {
      const s = signal(0)
      const later = vi.fn()
      effect(() => {
         if (s() === 1) throw new Error("first")
      })
      effect(() => {
         if (s() === 1) throw new Error("second")
      })
      effect(() => void later(s()))
      expect(() => s.set(1)).toThrow("first")
      expect(later).toHaveBeenLastCalledWith(1)
   })
})

describe("batch (semantic 6)", () => {
   it("coalesces writes into one flush", () => {
      const a = signal(0)
      const b = signal(0)
      const runs = vi.fn()
      effect(() => void runs(a() + b()))
      batch(() => {
         a.set(1)
         b.set(2)
      })
      expect(runs).toHaveBeenCalledTimes(2)
      expect(runs).toHaveBeenLastCalledWith(3)
   })

   it("nests: only the outermost batch flushes", () => {
      const s = signal(0)
      let seen = 0
      effect(() => {
         seen = s()
      })
      batch(() => {
         batch(() => s.set(1))
         expect(seen).toBe(0)
      })
      expect(seen).toBe(1)
   })

   it("a throwing body still flushes, then rethrows the body's error", () => {
      const s = signal(0)
      let seen = 0
      effect(() => {
         seen = s()
      })
      expect(() =>
         batch(() => {
            s.set(7)
            throw new Error("body")
         }),
      ).toThrow("body")
      expect(seen).toBe(7)
   })
})

describe("untracked (semantic 8)", () => {
   it("reads without subscribing", () => {
      const tracked = signal(0)
      const quiet = signal(0)
      const runs = vi.fn()
      effect(() => void runs(tracked() + untracked(quiet)))
      quiet.set(5)
      expect(runs).toHaveBeenCalledTimes(1)
      tracked.set(1)
      expect(runs).toHaveBeenLastCalledWith(6)
   })
})

describe("synchronous by construction (semantic 10)", () => {
   it("every derived value is current right after a write, with no await", () => {
      const s = signal(1)
      const c = computed(() => s() + 1)
      let mirrored = 0
      effect(() => {
         mirrored = c()
      })
      s.set(9)
      expect(c()).toBe(10)
      expect(mirrored).toBe(10)
   })
})

describe("resource (semantic 9)", () => {
   it("starts the loader for the current key and publishes value and pending", async () => {
      const key = signal(1)
      const r = resource(key, async (k) => `v${k}`)
      expect(r.pending()).toBe(true)
      await tick()
      expect(r.value()).toBe("v1")
      expect(r.pending()).toBe(false)
   })

   it("does nothing when the key is equal to the last started key", async () => {
      const key = signal(1)
      const loader = vi.fn(async (k: number) => k)
      resource(() => key() % 2, loader)
      key.set(3) // same parity → same key
      await tick()
      expect(loader).toHaveBeenCalledTimes(1)
   })

   it("honours keyEquals", async () => {
      const key = signal([1, 2])
      const loader = vi.fn(async () => 0)
      resource(key, loader, arrayEqual)
      key.set([1, 2])
      await tick()
      expect(loader).toHaveBeenCalledTimes(1)
   })

   it("drops a stale result when a newer run started meanwhile", async () => {
      const key = signal(1)
      const resolvers = new Map<number, (v: string) => void>()
      const r = resource(key, (k) => new Promise<string>((res) => resolvers.set(k, res)))
      key.set(2)
      resolvers.get(2)!("two")
      await tick()
      resolvers.get(1)!("one") // the superseded run lands last
      await tick()
      expect(r.value()).toBe("two")
   })

   it("keeps the last good value across a failed reload, and exposes the error", async () => {
      const key = signal(1)
      const r = resource(key, async (k) => {
         if (k === 2) throw new Error("boom")
         return k
      })
      await tick()
      key.set(2)
      await tick()
      expect(r.value()).toBe(1)
      expect((r.error() as Error).message).toBe("boom")
      expect(r.pending()).toBe(false)
   })

   it("a synchronous throw in the loader lands in error(), not out of the write", async () => {
      const key = signal(1)
      const r = resource(key, (k) => {
         if (k === 2) throw new Error("sync")
         return Promise.resolve(k)
      })
      expect(() => key.set(2)).not.toThrow()
      await tick()
      expect((r.error() as Error).message).toBe("sync")
   })

   it("refetch() re-runs the loader for an unchanged key", async () => {
      const loader = vi.fn(async () => 1)
      const r = resource(() => "k", loader)
      r.refetch()
      await tick()
      expect(loader).toHaveBeenCalledTimes(2)
   })

   it("dispose() drops an in-flight result", async () => {
      let land: (v: number) => void = () => {}
      const r = resource(
         () => 1,
         () => new Promise<number>((res) => (land = res)),
      )
      r.dispose()
      land(5)
      await tick()
      expect(r.value()).toBeUndefined()
   })
})

describe("onChange / diffed (the shared prime-then-diff primitive)", () => {
   it("onChange: the first run primes without firing, then fires on every real change", () => {
      const s = signal(1)
      const body = vi.fn()
      onChange(s, body)
      expect(body).not.toHaveBeenCalled() // priming, not a change
      s.set(1) // equal write — signal's own equals no-ops before onChange sees it
      expect(body).not.toHaveBeenCalled()
      s.set(2)
      expect(body).toHaveBeenCalledExactlyOnceWith(2, 1)
   })

   it("onChange: equals short-circuits a content-equal-but-reference-different value on the SECOND post-prime call", () => {
      // The exact class of bug this session hit in test helpers: a fresh []/{}
      // that is content-equal to the last one must not re-fire.
      const s = signal<number[]>([1], () => false) // never equal at the signal level, forces onChange's own equals to do the work
      const body = vi.fn()
      onChange(s, body, arrayEqual)
      s.set([2]) // first real change after priming
      expect(body).toHaveBeenCalledTimes(1)
      s.set([2]) // a NEW array, same contents as the last one onChange recorded
      expect(body).toHaveBeenCalledTimes(1) // still 1 — arrayEqual caught it
      s.set([3])
      expect(body).toHaveBeenCalledTimes(2)
   })

   it("diffed: fireOnFirst runs the very first invocation with prev === null", () => {
      const s = signal("a")
      const seen: Array<[string, string | null]> = []
      diffedForEffects(s, (now, prev) => seen.push([now, prev]), { fireOnFirst: true })
      expect(seen).toEqual([["a", null]])
      s.set("b")
      expect(seen).toEqual([
         ["a", null],
         ["b", "a"],
      ])
   })

   it("diffed: a skip gate true on the very first run defers priming until it clears", () => {
      const s = signal(1)
      let skip = true
      const body = vi.fn()
      diffedForEffects(s, body, { fireOnFirst: true, skip: () => skip })
      expect(body).not.toHaveBeenCalled()
      s.set(2) // still gated — must not prime on a value it never actually saw fire
      expect(body).not.toHaveBeenCalled()
      skip = false
      s.set(3) // the write that flips the effect while skip is now false
      expect(body).toHaveBeenCalledExactlyOnceWith(3, null) // its first real fire, still "first"
   })

   it("diffed: a change made WHILE the skip gate is true is not lost — it is compared against the correct stale value once the gate clears", () => {
      const s = signal(1)
      let skip = false
      const body = vi.fn()
      diffedForEffects(s, body, { fireOnFirst: true, skip: () => skip })
      expect(body).toHaveBeenCalledExactlyOnceWith(1, null)
      skip = true
      s.set(2) // moves while gated — must not be swallowed nor treated as "unchanged" later
      expect(body).toHaveBeenCalledTimes(1)
      skip = false
      s.set(3) // a plain (non-signal) gate: unblocking alone doesn't refire it
      expect(body).toHaveBeenCalledTimes(2)
      expect(body).toHaveBeenLastCalledWith(3, 1) // prev is 1 (the last value it actually processed), not the missed 2
   })

   it("diffed: a signal-backed skip gate re-fires the body when it clears (the rendering hold)", () => {
      const s = signal(1)
      const gate = signal(false)
      const body = vi.fn()
      diffedForEffects(s, body, { fireOnFirst: true, skip: () => gate() })
      gate.set(true)
      s.set(2)
      expect(body).toHaveBeenCalledTimes(1)
      gate.set(false) // releasing the gate alone re-runs the effect
      expect(body).toHaveBeenCalledTimes(2)
      expect(body).toHaveBeenLastCalledWith(2, 1)
   })
})

describe("robustness", () => {
   it("a computed that throws rethrows on read and still reaches its readers on the next write", () => {
      const s = signal(0)
      const c = computed(() => {
         if (s() === 1) throw new Error("boom")
         return s()
      })
      const seen: number[] = []
      effect(() => {
         try {
            seen.push(c())
         } catch {
            seen.push(-1)
         }
      })
      s.set(1)
      s.set(2)
      s.set(3)
      expect(seen).toEqual([0, -1, 2, 3])
   })

   it("a reader whose first read of a computed throws still subscribes to it", () => {
      const s = signal(1)
      const c = computed(() => {
         if (s() === 1) throw new Error("boom")
         return s()
      })
      const seen: number[] = []
      effect(() => {
         try {
            seen.push(c())
         } catch {
            seen.push(-1)
         }
      })
      s.set(2)
      expect(seen).toEqual([-1, 2])
   })

   it("a computed that recovers to the SAME value it held before the throw still counts as fresh", () => {
      const s = signal(0)
      const c = computed(() => {
         if (s() === 1) throw new Error("boom")
         return 7
      })
      const seen: number[] = []
      effect(() => {
         try {
            seen.push(c())
         } catch {
            seen.push(-1)
         }
      })
      s.set(1)
      s.set(2) // recovers to 7 — the value held before the throw — not a new one
      expect(seen).toEqual([7, -1, 7])
   })

   it("an effect that disposes itself runs the cleanup it returned and stays unsubscribed", () => {
      const s = signal(0)
      const cleaned = vi.fn()
      const runs = vi.fn()
      let stop: () => void = () => {}
      stop = effect(() => {
         runs(s())
         if (s() === 1) stop()
         return cleaned
      })
      s.set(1)
      expect(cleaned).toHaveBeenCalledTimes(2) // the first run's, then its own
      s.set(2)
      expect(runs).toHaveBeenCalledTimes(2)
   })

   it("onChange compares a null dependency like any other value", () => {
      const s = signal<string | null>(null)
      const t = signal(0)
      const body = vi.fn()
      onChange(() => (t(), s()), body) // primes on null
      t.set(1) // re-runs the effect; the dependency is still null
      expect(body).not.toHaveBeenCalled()
   })
})

describe("helpers", () => {
   it("shallowEqual compares own keys with Object.is", () => {
      expect(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true)
      expect(shallowEqual({ a: 1 }, { a: 1, b: 2 } as { a: number })).toBe(false)
      expect(shallowEqual({ a: NaN }, { a: NaN })).toBe(true)
      expect(shallowEqual({ a: {} }, { a: {} })).toBe(false)
   })

   it("arrayEqual compares length and Object.is per index", () => {
      expect(arrayEqual([1, "a"], [1, "a"])).toBe(true)
      expect(arrayEqual([1], [1, 2])).toBe(false)
      expect(arrayEqual([{}], [{}])).toBe(false)
   })
})
