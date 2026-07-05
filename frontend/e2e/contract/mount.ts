// Contract-layer reader mount: drive the REAL frontend data modules
// (idx.ts/data.ts/nav.ts) against REAL srr-produced pack bytes on disk.
//
// data.ts fetches db.gz at module load (an eager `const dbFetch = fetch(...)`),
// so the fetch shim must be installed BEFORE the module is imported. We
// vi.resetModules() + dynamic import per scenario so each gets fresh module
// state (data caches db; nav holds filter state).

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vitest"

import type * as DataModule from "../../src/js/data"
import type * as NavModule from "../../src/js/nav"

function hrefOf(input: unknown): string {
   if (typeof input === "string") return input
   const obj = input as { href?: string; url?: string }
   return obj.href ?? obj.url ?? String(input)
}

// Map a CDN-relative request (db.gz, idx/*.gz, data/*.gz, meta/*.gz) to the
// matching file under storeDir and return its RAW gzip bytes with NO
// Content-Encoding header — data.ts decompresses manually via
// DecompressionStream, so a gzip header would double-decode.
function makeFetchShim(storeDir: string) {
   return vi.fn(async (input: unknown) => {
      const pathname = new URL(hrefOf(input)).pathname.replace(/^\/+/, "")
      const file = join(storeDir, pathname)
      if (!existsSync(file)) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(readFileSync(file)), { status: 200 })
   })
}

export interface MountedReader {
   data: typeof DataModule
   nav: typeof NavModule
   fetchMock: ReturnType<typeof makeFetchShim>
}

// Mount the reader against storeDir and run data.init() (loads db.gz + all idx
// packs). Returns the freshly-imported real modules.
export async function mountReader(storeDir: string): Promise<MountedReader> {
   vi.unstubAllGlobals()
   const fetchMock = makeFetchShim(storeDir)
   vi.stubGlobal("fetch", fetchMock)
   vi.resetModules()
   const data = (await import("../../src/js/data")) as typeof DataModule
   const nav = (await import("../../src/js/nav")) as typeof NavModule
   await data.init()
   return { data, nav, fetchMock }
}
