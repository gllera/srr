import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { bitAt } from "./watch-plane"

// The watch accessors over a real manifest boot: the smallest real layout (one
// all-delta cycle, two articles), plus a watch roster whose rule "hot" marks
// chron 1 — byte-shaped after backend/watch.go.

async function gzip(input: string): Promise<Uint8Array> {
   const stream = new Response(new TextEncoder().encode(input)).body!.pipeThrough(new CompressionStream("gzip"))
   return new Uint8Array(await new Response(stream).arrayBuffer())
}

const FEEDS = { 0: { title: "Delta", url: "http://f/a.xml", total_art: 2, add_idx: 0 } }
const DELTA_JSONL = '{"f":0,"a":100,"p":90,"t":"One","c":"one"}\n{"f":0,"a":100,"p":91,"t":"Two","c":"two"}\n'

function files(withWatch: boolean): Record<string, string> {
   const names: Record<string, unknown> = {
      data: { b: 1 },
      idx: {},
      meta: {},
      deltas: { s: "data", r: [1] },
      seen: { s: "seen", stem: 1 },
      next: { data: 2, seen: 2, watch: 2 },
   }
   const manifest: Record<string, unknown> = {
      v: 3,
      m: 2,
      fetched_at: 100,
      total_art: 2,
      na: 2,
      pack_off: 0,
      names,
      feeds: FEEDS,
   }
   const out: Record<string, string> = {
      "/db.gz": JSON.stringify({ v: 3, m: 2, t: 100 }),
      "/data/1.gz": DELTA_JSONL,
   }
   if (withWatch) {
      names.watch = { b: 0, r: [[1, 1]], l: 0 }
      manifest.wf = { hot: 0 }
      manifest.wc = 2
      out["/watch/1.gz"] = JSON.stringify({ v: 1, base: 0, n: 2, bits: { hot: btoa(String.fromCharCode(0b10)) } })
   }
   out["/manifest/2.gz"] = JSON.stringify(manifest)
   return out
}

let fetched: string[]

async function mount(f: Record<string, string>) {
   const bytes = new Map<string, Uint8Array>()
   for (const [path, body] of Object.entries(f)) bytes.set(path, await gzip(body))
   fetched = []
   vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
         const url = input instanceof URL ? input : new URL(String(input))
         fetched.push(url.pathname.replace(/^\/+/, ""))
         const gz = bytes.get(url.pathname)
         return gz ? new Response(gz, { status: 200 }) : new Response("not found", { status: 404 })
      }),
   )
   vi.resetModules()
   const data = await import("./data")
   await data.init()
   return data
}

beforeEach(() => sessionStorage.clear())
afterEach(() => {
   vi.unstubAllGlobals()
   vi.resetModules()
})

describe("watch accessors", () => {
   it("read the roster and the coverage end from the manifest", async () => {
      const data = await mount(files(true))
      expect(data.watchRules()).toEqual({ hot: 0 })
      expect(data.watchCovered()).toBe(2)
   })

   it("load a listed plane once per snapshot, decoded", async () => {
      const data = await mount(files(true))
      const plane = await data.loadWatchPlane(0)
      await data.loadWatchPlane(0)
      const hot = plane.bits.get("hot")!
      expect([bitAt(hot, 0), bitAt(hot, 1)]).toEqual([false, true])
      expect(fetched.filter((k) => k === "watch/1.gz")).toHaveLength(1)
   })

   it("answer 'no rules' on a store without any, and an unlisted position is all-zero with no fetch", async () => {
      const data = await mount(files(false))
      expect(data.watchRules()).toEqual({})
      expect(data.watchCovered()).toBe(0)
      const plane = await data.loadWatchPlane(0)
      expect([plane.base, plane.bits.size]).toEqual([0, 0])
      expect(fetched.some((k) => k.startsWith("watch/"))).toBe(false)
   })
})
