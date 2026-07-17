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

// An optional per-request hook for failure-injection scenarios (flaky
// networks, transient 5xx): receives the store-relative path and the default
// serve thunk; return serve() to pass through or any Response to override.
export type FetchIntercept = (pathname: string, serve: () => Promise<Response>) => Promise<Response>

// Map a CDN-relative request (db.gz, idx/*.gz, data/*.gz, meta/*.gz) to the
// matching file under storeDir and return its RAW gzip bytes with NO
// Content-Encoding header — data.ts decompresses manually via
// DecompressionStream, so a gzip header would double-decode.
function makeFetchShim(storeDir: string, intercept?: FetchIntercept) {
   const serve = async (pathname: string) => {
      const file = join(storeDir, pathname)
      if (!existsSync(file)) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(readFileSync(file)), { status: 200 })
   }
   return vi.fn(async (input: unknown) => {
      const pathname = new URL(hrefOf(input)).pathname.replace(/^\/+/, "")
      return intercept ? intercept(pathname, () => serve(pathname)) : serve(pathname)
   })
}

export interface MountedReader {
   data: typeof DataModule
   nav: typeof NavModule
   fetchMock: ReturnType<typeof makeFetchShim>
   // location.reload spy: the reader CALLS reload on purpose (assertPackOk's
   // stale-tab self-heal), and jsdom would log "Not implemented: navigation to
   // another Document" for each call. Suites assert the self-heal through this
   // spy instead of tolerating the noise.
   reloads: ReturnType<typeof vi.fn>
}

// Swap window.location for a plain-object clone whose reload is a silent spy —
// the whole object, because jsdom pins `reload` as a non-configurable read-only
// own property (neither redefinable nor proxy-wrappable without violating the
// proxy invariant); same workaround as data.edge.test.ts, made harness-wide
// here. A static snapshot of the URL parts is enough: the data/nav modules
// only READ location (base.ts's href at import; hash updates go through
// history). Restored by the next mount's vi.unstubAllGlobals().
function stubLocationReload(): ReturnType<typeof vi.fn> {
   const real = window.location
   const reload = vi.fn()
   vi.stubGlobal("location", {
      href: real.href,
      origin: real.origin,
      protocol: real.protocol,
      host: real.host,
      hostname: real.hostname,
      port: real.port,
      pathname: real.pathname,
      search: real.search,
      hash: real.hash,
      reload,
      toString: () => real.href,
   })
   return reload
}

// Mount the reader against storeDir and run data.init() (loads db.gz + all idx
// packs). Returns the freshly-imported real modules.
export async function mountReader(storeDir: string, intercept?: FetchIntercept): Promise<MountedReader> {
   vi.unstubAllGlobals()
   const fetchMock = makeFetchShim(storeDir, intercept)
   vi.stubGlobal("fetch", fetchMock)
   const reloads = stubLocationReload()
   vi.resetModules()
   const data = (await import("../../src/js/data")) as typeof DataModule
   const nav = (await import("../../src/js/nav")) as typeof NavModule
   await data.init()
   return { data, nav, fetchMock, reloads }
}
