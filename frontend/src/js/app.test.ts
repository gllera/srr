import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// app.ts is the DOM/async orchestrator: it has no exports, runs init() at import,
// and wires every listener. We mock its collaborators, seed the full toolbar +
// reader + popup skeleton, then drive it through real events (hashchange, click,
// keydown) and assert routing decisions / the guard mutex / the popup focus trap
// — the pure-logic P1s the heavy e2e-browser layer can't economically pin.

interface ShowFeed {
   article: { f: number; a: number; p: number; t: string; l: string; c: string }
   has_left: boolean
   has_right: boolean
   feed?: { id: number; tag: string }
   placeholder?: boolean
   filtered?: boolean
}
const showFeed = (o: Partial<ShowFeed> = {}): ShowFeed => ({
   article: { f: 1, a: 0, p: 0, t: "Title", l: "", c: "<p>body</p>" },
   has_left: false,
   has_right: false,
   ...o,
})

const nav = vi.hoisted(() => {
   const sf = () => ({ article: { f: 1, a: 0, p: 0, t: "T", l: "", c: "<p>x</p>" }, has_left: false, has_right: false })
   return {
      SAVED_TOKEN: "~saved",
      SEARCH_PREFIX: "q:",
      pruneSeen: vi.fn(),
      fromHash: vi.fn(async () => sf()),
      applyFilter: vi.fn(),
      tokensSuffix: vi.fn(() => ""),
      // The real implementation: a pure decode with no nav state, so a faithful
      // inline copy (not a stub) keeps the routing tests accurate.
      parseHashTokens: (hash: string) => {
         const bang = hash.indexOf("!")
         if (bang === -1) return []
         return hash
            .substring(bang + 1)
            .split("+")
            .filter((t: string) => t.length > 0)
            .map((t: string) => {
               try {
                  return decodeURIComponent(t)
               } catch {
                  return t
               }
            })
      },
      getCurrentFilterKey: vi.fn(() => ""),
      filterLabel: vi.fn((key: string) =>
         key === "" ? "All" : key === "~saved" ? "★ Saved" : /^\d+$/.test(key) ? data.feedTitle(Number(key)) : key,
      ),
      getFilterEntries: vi.fn(() => [""]),
      cycleFilter: vi.fn(async () => sf()),
      cycleToken: vi.fn(() => ""),
      isSearchFilter: vi.fn(() => false),
      searchAvailable: vi.fn(() => true),
      searchQuery: vi.fn(() => ""),
      searchShort: vi.fn(() => false),
      searchTruncated: vi.fn(() => false),
      isUnreadOnly: vi.fn(() => false),
      setUnreadOnly: vi.fn(),
      currentChron: vi.fn(() => -1),
      currentFeedId: vi.fn(() => -1),
      isSaved: vi.fn(() => false),
      toggleSaved: vi.fn(() => true),
      goTo: vi.fn(async () => sf()),
      left: vi.fn(async () => sf()),
      right: vi.fn(async () => sf()),
      first: vi.fn(async () => sf()),
      last: vi.fn(async () => sf()),
      switchFilter: vi.fn(async () => sf()),
      seek: vi.fn(async () => 0),
      unreadCounts: vi.fn(async () => new Map<number, number>()),
      filterKey: vi.fn(() => ""),
      filter: { feeds: new Map<number, number>(), saved: false, search: false, active: false },
   }
})
vi.mock("./nav", () => nav)

const data = vi.hoisted(() => ({
   init: vi.fn(async () => {}),
   db: { total_art: 0, fetched_at: 0, feeds: {} } as unknown as IDB,
   feedTitle: vi.fn(() => "Feed"),
   lastFetchedAt: vi.fn(() => 0),
   hasArticles: vi.fn(() => false),
   metaReady: vi.fn(() => true),
   idxSummaryDegraded: vi.fn(() => false),
   packNamesForFilter: vi.fn(async () => ["idx/L1.gz", "data/L1.gz"]),
}))
vi.mock("./data", () => data)

const list = vi.hoisted(() => ({
   setup: vi.fn(),
   show: vi.fn(async () => {}),
   rerender: vi.fn(async () => {}),
   moveSelection: vi.fn(async () => 0),
}))
vi.mock("./list", () => list)

const dropdown = vi.hoisted(() => ({
   closeAllDropdowns: vi.fn(),
   showFeedMenu: vi.fn(),
   showOverflowMenu: vi.fn(),
   setProfileImportHook: vi.fn(),
   setPinMenuHook: vi.fn(),
}))
vi.mock("./dropdown", () => dropdown)

vi.mock("./fmt", () => ({
   sanitizeHtml: (s: string) => s,
   formatDate: () => "01/01/2020 00:00",
   srcColorIndex: () => 0,
   timeAgo: () => "1h",
   timeAgoProse: (unix: number) => (unix === 0 ? "just now" : "4 minutes ago"),
   isStale: (unix: number) => unix > 0 && unix < 1000,
   collapseBrokenMedia: () => {},
   URL_DENY: /^\s*(?:javascript|data|vbscript|file)\s*:/i,
}))

const gestures = vi.hoisted(() => ({
   setupGestures: vi.fn(() => ({ resetScroll: vi.fn() })),
}))
vi.mock("./gestures", () => gestures)

const SKELETON = `
   <div class="srr-popup"><span class="srr-popup-text"></span>
      <button class="srr-popup-retry srr-hidden">Retry</button>
      <button class="srr-popup-close">x</button></div>
   <main class="srr-container">
      <div class="srr-searchbar"><input class="srr-search-input" /><button class="srr-search-clear"></button>
         <div class="srr-search-note"></div></div>
      <article class="srr-reader" hidden>
         <div class="srr-kicker"><span class="srr-source"></span><time class="srr-date"></time></div>
         <a class="srr-title-link"><h1 class="srr-title" tabindex="-1"></h1></a>
         <div class="srr-content"></div></article>
      <div class="srr-list" hidden></div>
      <nav class="srr-toolbar">
         <button class="srr-back"></button>
         <div class="srr-dropdown"><button class="srr-dropdown-btn srr-feed"></button><div id="srr-feed-menu" class="srr-dropdown-menu"></div></div>
         <button class="srr-prev" disabled></button>
         <button class="srr-search"></button>
         <button class="srr-next" disabled></button>
         <button class="srr-unread"></button>
         <button class="srr-save" disabled></button>
         <div class="srr-dropdown"><button class="srr-overflow srr-dropdown-btn"></button><div id="srr-overflow-menu" class="srr-dropdown-menu"></div></div>
      </nav>
      <div class="srr-status"></div>
   </main>`

const flush = () => new Promise((r) => setTimeout(r))
const hashTo = (h: string) => {
   window.location.hash = h
   window.dispatchEvent(new Event("hashchange"))
}

// app.ts binds window/document listeners (hashchange, click, keydown, …) at
// load. vi.resetModules() + re-import per test would STACK another set onto the
// shared window/document — one hashchange would then fire every prior instance's
// route(). Record what each boot adds and tear it down between tests so exactly
// one app instance is live.
const added: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = []

// Boot a fresh app instance with an initial hash already on location.
async function boot(initialHash = "") {
   document.body.innerHTML = SKELETON
   window.location.hash = initialHash
   vi.resetModules()
   await import("./app")
   await flush() // let init()'s awaited data.init + initial route settle
}

beforeEach(() => {
   localStorage.clear()
   window.location.hash = ""
   vi.clearAllMocks()
   data.init.mockResolvedValue(undefined)
   nav.fromHash.mockResolvedValue(showFeed())
   // jsdom doesn't implement these; render() and the toolbar use them.
   window.scrollTo = () => {}
   vi.spyOn(history, "pushState").mockImplementation(() => {})
   vi.spyOn(history, "replaceState").mockImplementation(() => {})
   added.length = 0
   for (const t of [window, document] as EventTarget[]) {
      const orig = t.addEventListener.bind(t)
      vi.spyOn(t, "addEventListener").mockImplementation((type, h, opts) => {
         if (h) added.push([t, type, h])
         orig(type, h, opts)
      })
   }
})
afterEach(() => {
   for (const [t, type, h] of added) t.removeEventListener(type, h)
   vi.restoreAllMocks()
   vi.resetModules()
})

describe("route() — surface selection from the hash", () => {
   it("routes a numeric position to the reader via nav.fromHash", async () => {
      await boot()
      nav.fromHash.mockClear()
      nav.applyFilter.mockClear() // drop the boot's own route("") → applyFilter([])
      hashTo("#2")
      await flush()
      expect(nav.fromHash).toHaveBeenCalledWith("2")
      expect(nav.applyFilter).not.toHaveBeenCalled()
      expect(document.querySelector(".srr-reader")!.hasAttribute("hidden")).toBe(false) // reader shown
   })

   it("routes a token-only hash to the LIST (applyFilter + list.show, not fromHash)", async () => {
      await boot()
      nav.fromHash.mockClear()
      list.show.mockClear()
      hashTo("#!news")
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith(["news"])
      expect(nav.fromHash).not.toHaveBeenCalled()
      expect(list.show).toHaveBeenCalled()
      expect(document.body.classList.contains("srr-view-list")).toBe(true)
   })

   it("routes an empty hash to the [ALL] list (applyFilter with no tokens)", async () => {
      await boot()
      nav.applyFilter.mockClear()
      hashTo("#")
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith([])
   })

   it("decodes + splits multi-token filters and passes a malformed token through verbatim", async () => {
      await boot()
      nav.applyFilter.mockClear()
      hashTo("#!a%2Bb+%E0%A4%A") // "a+b" (escaped +) then a lone malformed %-escape
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith(["a+b", "%E0%A4%A"])
   })
})

describe("init() — foreign-hash rejection (OAuth/Access fragment)", () => {
   it("strips a foreign non-numeric boot hash and falls back to the list, never treating it as a position", async () => {
      await boot("#access_token=abc.def&state=xyz")
      // The fragment was replaced away (bare path, no '#') and routing never
      // treated it as a reader position.
      const replaced = (history.replaceState as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[2])
      expect(replaced.some((u) => typeof u === "string" && !u.includes("#"))).toBe(true)
      expect(nav.fromHash).not.toHaveBeenCalled()
   })
})

describe("guard() — busy mutex", () => {
   it("drops an overlapping navigation while one is in flight (fromHash runs once)", async () => {
      await boot()
      let release!: () => void
      nav.fromHash.mockImplementation(() => new Promise((r) => (release = () => r(showFeed()))))
      hashTo("#2")
      await flush()
      hashTo("#3") // arrives while #2 is still in flight → dropped by the busy guard
      await flush()
      expect(nav.fromHash).toHaveBeenCalledTimes(1)
      expect(nav.fromHash).toHaveBeenLastCalledWith("2")
      release()
      await flush()
   })
})

describe("reader edge — margin bell", () => {
   // The default showFeed() has no left/right neighbor, so routing #2 lands on an
   // article with BOTH prev and next disabled — i.e. at both edges at once.
   it("ArrowLeft at the first article rings the bell instead of navigating", async () => {
      await boot()
      hashTo("#2")
      await flush()
      const reader = document.querySelector(".srr-reader") as HTMLElement
      expect((document.querySelector(".srr-prev") as HTMLButtonElement).disabled).toBe(true)
      nav.left.mockClear()
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
      expect(reader.classList.contains("srr-bell-left")).toBe(true)
      expect(nav.left).not.toHaveBeenCalled()
   })

   it("ArrowRight at the last article rings the bell to the right", async () => {
      await boot()
      hashTo("#2")
      await flush()
      const reader = document.querySelector(".srr-reader") as HTMLElement
      expect((document.querySelector(".srr-next") as HTMLButtonElement).disabled).toBe(true)
      nav.right.mockClear()
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
      expect(reader.classList.contains("srr-bell-right")).toBe(true)
      expect(nav.right).not.toHaveBeenCalled()
   })
})

describe("error popup — focus trap + close", () => {
   const popup = () => document.querySelector(".srr-popup")!
   const retry = () => document.querySelector(".srr-popup-retry") as HTMLButtonElement
   const close = () => document.querySelector(".srr-popup-close") as HTMLButtonElement
   const tab = (shift = false) =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true }))

   it("opens with a retry on a failed navigation, focuses Retry, and traps Tab between Retry↔Close", async () => {
      await boot()
      nav.fromHash.mockRejectedValue(new Error("pack fetch failed"))
      hashTo("#5")
      await flush()
      expect(popup().classList.contains("srr-open")).toBe(true)
      expect(retry().classList.contains("srr-hidden")).toBe(false) // retry shown (retryable error)
      expect(document.activeElement).toBe(retry())
      // Tab from the last focusable (Close) wraps to the first (Retry).
      close().focus()
      tab()
      expect(document.activeElement).toBe(retry())
      // Shift+Tab from the first wraps to the last.
      retry().focus()
      tab(true)
      expect(document.activeElement).toBe(close())
   })

   it("Escape closes the popup", async () => {
      await boot()
      nav.fromHash.mockRejectedValue(new Error("boom"))
      hashTo("#5")
      await flush()
      expect(popup().classList.contains("srr-open")).toBe(true)
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      expect(popup().classList.contains("srr-open")).toBe(false)
   })
})

// FE-S7 follow-up: the list-vs-reader routing in the feed-menu onSelect callback
// moved from dropdown.ts into app.ts. These tests pin that decision: selecting a
// filter from the feed menu must call selectFilter (list surface) or
// guard(switchFilter) (reader surface), never the wrong one.
describe("feed-menu onSelect routing — list vs reader (FE-S7)", () => {
   const clickFeed = () =>
      document.querySelector<HTMLButtonElement>(".srr-feed")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))

   // Capture the onSelect callback that app.ts passed to showFeedMenu.
   // showFeedMenu is a vi.fn() so its args are always available.
   const captureOnSelect = (): ((token: string) => void) => {
      const calls = (dropdown.showFeedMenu as ReturnType<typeof vi.fn>).mock.calls
      return calls[calls.length - 1][1]
   }

   it("LIST surface: onSelect calls selectFilter (applyFilter path), not switchFilter", async () => {
      await boot() // boots into list (hash "" → list surface)
      expect(document.body.classList.contains("srr-view-list")).toBe(true)

      dropdown.showFeedMenu.mockClear()
      nav.applyFilter.mockClear()
      nav.switchFilter.mockClear()

      clickFeed()
      expect(dropdown.showFeedMenu).toHaveBeenCalledTimes(1)

      const onSelect = captureOnSelect()
      await onSelect("42")
      await flush()

      // selectFilter calls nav.applyFilter then routes to the list
      expect(nav.applyFilter).toHaveBeenCalledWith(["42"])
      // switchFilter is the reader path — must NOT be called here
      expect(nav.switchFilter).not.toHaveBeenCalled()
   })

   it("READER surface: onSelect calls guard(switchFilter), not selectFilter/applyFilter", async () => {
      await boot()
      // Route into the reader by navigating to a numeric hash
      nav.fromHash.mockClear()
      hashTo("#3")
      await flush()
      expect(document.querySelector(".srr-reader")!.hasAttribute("hidden")).toBe(false)
      expect(document.body.classList.contains("srr-view-list")).toBe(false)

      dropdown.showFeedMenu.mockClear()
      nav.applyFilter.mockClear()
      nav.switchFilter.mockClear()

      clickFeed()
      expect(dropdown.showFeedMenu).toHaveBeenCalledTimes(1)

      const onSelect = captureOnSelect()
      await onSelect("7")
      await flush()

      // guard(switchFilter) runs switchFilter and shows the reader result
      expect(nav.switchFilter).toHaveBeenCalledWith("7")
      // applyFilter is the list path — must NOT be called here
      expect(nav.applyFilter).not.toHaveBeenCalled()
   })
})

describe("refreshStatus() — freshness & degradation status banner", () => {
   const status = () => document.querySelector(".srr-status") as HTMLElement

   it("shows freshness text when fetched_at > 0 and everything is healthy", async () => {
      data.lastFetchedAt.mockReturnValue(1700000000) // nonzero, treated as recent by mock isStale
      data.metaReady.mockReturnValue(true)
      data.idxSummaryDegraded.mockReturnValue(false)
      await boot()
      const text = status().textContent ?? ""
      expect(text).toContain("Updated")
      expect(text).toContain("minutes ago")
      expect(status().classList.contains("srr-status-warn")).toBe(false)
   })

   it("shows stale warning when isStale returns true", async () => {
      // isStale mock: unix > 0 && unix < 1000 => stale; use value 1 (> 0 and < 1000)
      data.lastFetchedAt.mockReturnValue(1)
      data.metaReady.mockReturnValue(true)
      data.idxSummaryDegraded.mockReturnValue(false)
      await boot()
      const text = status().textContent ?? ""
      expect(text).toContain("backend may be down")
      expect(status().classList.contains("srr-status-warn")).toBe(true)
   })

   it("shows search unavailable when metaReady is false and store is non-empty", async () => {
      data.lastFetchedAt.mockReturnValue(1700000000)
      data.hasArticles.mockReturnValue(true)
      data.metaReady.mockReturnValue(false)
      data.idxSummaryDegraded.mockReturnValue(false)
      await boot()
      const text = status().textContent ?? ""
      expect(text).toContain("Search unavailable")
      expect(status().classList.contains("srr-status-warn")).toBe(true)
   })

   it("shows degraded note when idxSummaryDegraded is true", async () => {
      data.lastFetchedAt.mockReturnValue(1700000000)
      data.metaReady.mockReturnValue(true)
      data.idxSummaryDegraded.mockReturnValue(true)
      await boot()
      const text = status().textContent ?? ""
      expect(text).toContain("optimizing")
      expect(status().classList.contains("srr-status-warn")).toBe(true)
   })

   it("shows no freshness line when fetched_at is 0", async () => {
      data.lastFetchedAt.mockReturnValue(0)
      data.metaReady.mockReturnValue(true)
      data.idxSummaryDegraded.mockReturnValue(false)
      await boot()
      const text = status().textContent ?? ""
      expect(text).not.toContain("Updated")
      expect(text).not.toContain("backend may be down")
      expect(status().classList.contains("srr-status-warn")).toBe(false)
   })

   it("empty store with recent fetch shows only freshness line, no search warning, no warn class", async () => {
      // total_art === 0: metaReady() returns false (its real empty-store behaviour),
      // but hasArticles() is false, so metaMissing must stay false.
      data.lastFetchedAt.mockReturnValue(1700000000) // nonzero, recent (isStale mock: unix < 1000 => stale)
      data.hasArticles.mockReturnValue(false)
      data.metaReady.mockReturnValue(false) // mirrors real empty-store return value
      data.idxSummaryDegraded.mockReturnValue(false)
      await boot()
      const text = status().textContent ?? ""
      expect(text).toContain("Updated")
      expect(text).not.toContain("Search unavailable")
      expect(status().classList.contains("srr-status-warn")).toBe(false)
   })

   it("stale + metaReady false on non-empty store shows both warnings and warn class", async () => {
      // isStale mock: unix > 0 && unix < 1000 => stale; use value 1
      data.lastFetchedAt.mockReturnValue(1)
      data.hasArticles.mockReturnValue(true)
      data.metaReady.mockReturnValue(false)
      data.idxSummaryDegraded.mockReturnValue(false)
      await boot()
      const text = status().textContent ?? ""
      expect(text).toContain("backend may be down")
      expect(text).toContain("Search unavailable — index rebuilding")
      expect(text).toContain(" · ") // separator between the two parts
      expect(status().classList.contains("srr-status-warn")).toBe(true)
   })
})

// Helper: invoke the pin action from the registered pinMenuHook (simulates the
// overflow "Download for offline" tap) and wait for the async pin to settle.
// Sets up a fake SW controller so pinCurrentFilter doesn't bail early.
async function invokePinAction(isUnreadOnly: boolean): Promise<void> {
   // Capture the pinMenuHook registered by app.ts during boot.
   let capturedHook: (() => { label: string; action: () => void } | null) | null = null
   dropdown.setPinMenuHook.mockImplementation((fn: () => { label: string; action: () => void } | null) => {
      capturedHook = fn
   })

   // In unread-only mode the filter must be active (a feed/tag scope, not [ALL])
   // so the snapshot note fires.
   nav.isUnreadOnly.mockReturnValue(isUnreadOnly)
   nav.filter = { feeds: new Map([[0, 0]]), saved: false, search: false, active: isUnreadOnly }

   // Stub a SW controller so pinCurrentFilter doesn't no-op.
   const fakePort = { onmessage: null }
   const fakeSW = { postMessage: vi.fn() }
   Object.defineProperty(navigator, "serviceWorker", {
      value: { controller: fakeSW, getRegistrations: () => Promise.resolve([]), register: () => Promise.resolve() },
      configurable: true,
   })
   // MessageChannel: the SW progress messages are sent over a port; simulate the
   // pin completing immediately (done===total) via the port's onmessage.
   const realMC = globalThis.MessageChannel
   const fakePort1 = { onmessage: null as ((e: MessageEvent) => void) | null }
   const fakePort2 = {}
   vi.stubGlobal("MessageChannel", function () {
      return { port1: fakePort1, port2: fakePort2 }
   })

   await boot()
   // Flush init then grab the hook.
   expect(capturedHook).not.toBeNull()
   const entry = capturedHook!()
   expect(entry).not.toBeNull()

   // Trigger the pin action (async).
   entry!.action()
   await flush()

   // Simulate the SW sending pin-progress: done=2, total=2 (all packs cached).
   if (fakePort1.onmessage) {
      fakePort1.onmessage(new MessageEvent("message", { data: { type: "pin-progress", done: 2, total: 2 } }))
   }
   await flush()

   // Restore globals.
   vi.stubGlobal("MessageChannel", realMC)
   Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true })
   void fakePort
}

describe("pinCurrentFilter — unread-snapshot note in the status bar", () => {
   const status = () => document.querySelector(".srr-status") as HTMLElement

   it("shows the snapshot caveat when pinning in unread-only mode with an active filter", async () => {
      await invokePinAction(true)
      const text = status().textContent ?? ""
      expect(text).toContain("Offline copy saved")
      expect(text).toContain("new unread won't update automatically")
   })

   it("does NOT show the snapshot caveat when pinning outside unread-only mode", async () => {
      await invokePinAction(false)
      const text = status().textContent ?? ""
      expect(text).toContain("Offline copy saved")
      expect(text).not.toContain("new unread")
   })
})
