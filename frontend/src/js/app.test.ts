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
      currentTokens: vi.fn(() => [] as string[]),
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
      seek: vi.fn(async () => 0),
      unreadCounts: vi.fn(async () => new Map<number, number>()),
   }
})
vi.mock("./nav", () => nav)

const data = vi.hoisted(() => ({
   init: vi.fn(async () => {}),
   db: { total_art: 0, fetched_at: 0, feeds: {} } as unknown as IDB,
   feedTitle: vi.fn(() => "Feed"),
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
}))
vi.mock("./dropdown", () => dropdown)

vi.mock("./fmt", () => ({
   sanitizeHtml: (s: string) => s,
   formatDate: () => "01/01/2020 00:00",
   srcColorIndex: () => 0,
   timeAgo: () => "1h",
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
