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
      listAnchor: vi.fn(async () => -1),
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
   setProfileImportHook: vi.fn(),
   showImgProxyDialog: vi.fn(),
   showBackupDialog: vi.fn(),
}))
vi.mock("./dropdown", () => dropdown)

// The config surface is its own module; app.ts drives it via showConfig/config.open
// and the hooks it passes to config.setup. We mock it and capture those hooks.
const config = vi.hoisted(() => ({
   setup: vi.fn(),
   open: vi.fn(),
   close: vi.fn(),
   render: vi.fn(),
   refreshStatus: vi.fn(),
   isOpen: vi.fn(() => false),
}))
vi.mock("./config", () => config)
// The hooks object app.ts passes to config.setup (onSelect / onUnreadToggle /
// onClose / pinEntry / openImgProxy / openBackup) — captured for assertions.
const configHooks = () => (config.setup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]

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
         <button class="srr-open-reader"></button>
         <span class="srr-feed"></span>
         <button class="srr-prev" disabled></button>
         <button class="srr-next" disabled></button>
         <button class="srr-save" disabled></button>
         <button class="srr-settings"></button>
      </nav>
      <section class="srr-config" hidden></section>
      <div class="srr-pin-progress" hidden></div>
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

// The list-vs-reader routing in the config picker's onSelect callback lives in
// app.ts. These tests pin that decision: picking a filter opens the reader at that
// filter (guard(switchFilter)), NOT the list (selectFilter / applyFilter).
describe("list → reader — open-article button", () => {
   it("enters the reader at the current article (the tap counterpart of Escape)", async () => {
      await boot() // list surface
      nav.currentChron.mockReturnValue(5)
      nav.goTo.mockClear()
      document
         .querySelector<HTMLButtonElement>(".srr-open-reader")!
         .dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await flush()
      expect(nav.goTo).toHaveBeenCalledWith(5)
      expect(document.body.classList.contains("srr-view-list")).toBe(false)
      expect(document.querySelector(".srr-reader")!.hasAttribute("hidden")).toBe(false)
   })

   it("falls back to the newest article when nothing is current (currentChron < 0)", async () => {
      await boot()
      nav.currentChron.mockReturnValue(-1)
      nav.listAnchor.mockResolvedValue(-1)
      nav.last.mockClear()
      document
         .querySelector<HTMLButtonElement>(".srr-open-reader")!
         .dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await flush()
      expect(nav.last).toHaveBeenCalled()
      expect(document.body.classList.contains("srr-view-list")).toBe(false)
   })
})

describe("config surface — open + filter / settings routing", () => {
   // The config entry point is the settings gear now; the now-viewing readout is a
   // plain label.
   const clickConfig = () =>
      document
         .querySelector<HTMLButtonElement>(".srr-settings")!
         .dispatchEvent(new MouseEvent("click", { bubbles: true }))

   it("the now-viewing readout is a plain label, not a config trigger", async () => {
      await boot() // boots into the list (hash "" → list surface)
      config.open.mockClear()
      document.querySelector(".srr-feed")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      expect(config.open).not.toHaveBeenCalled()
      expect(document.body.classList.contains("srr-view-config")).toBe(false)
   })

   it("the list's settings gear opens config too (the explicit settings entry)", async () => {
      await boot() // list surface
      config.open.mockClear()
      document
         .querySelector<HTMLButtonElement>(".srr-settings")!
         .dispatchEvent(new MouseEvent("click", { bubbles: true }))
      expect(config.open).toHaveBeenCalledTimes(1)
      expect(document.body.classList.contains("srr-view-config")).toBe(true)
   })

   it("the reader's settings gear opens config too (the gear lives on both surfaces)", async () => {
      await boot()
      hashTo("#2") // numeric hash → reader surface
      await flush()
      config.open.mockClear()
      document
         .querySelector<HTMLButtonElement>(".srr-settings")!
         .dispatchEvent(new MouseEvent("click", { bubbles: true }))
      expect(config.open).toHaveBeenCalledTimes(1)
      expect(document.body.classList.contains("srr-view-config")).toBe(true)
   })

   it("config onSearch leaves config for the list with search applied", async () => {
      await boot()
      // Open config (settings gear), then trigger the Search row's hook.
      clickConfig()
      expect(document.body.classList.contains("srr-view-config")).toBe(true)
      nav.applyFilter.mockClear()
      configHooks()!.onSearch()
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith(["q:"])
      expect(document.body.classList.contains("srr-view-config")).toBe(false)
   })

   it("config.onSelect opens the reader at the picked filter (switchFilter), not the list", async () => {
      await boot() // list surface
      nav.switchFilter.mockClear()
      nav.applyFilter.mockClear()
      configHooks()!.onSelect("42")
      await flush()
      expect(nav.switchFilter).toHaveBeenCalledWith("42")
      // Reader path only — it must NOT take the list filter path (applyFilter/goToList).
      expect(nav.applyFilter).not.toHaveBeenCalled()
      expect(document.body.classList.contains("srr-view-list")).toBe(false)
      expect(document.querySelector(".srr-reader")!.hasAttribute("hidden")).toBe(false)
   })

   it("config.onUnreadToggle flips unread-only and rebuilds the list", async () => {
      await boot()
      nav.setUnreadOnly.mockClear()
      list.rerender.mockClear()
      configHooks()!.onUnreadToggle()
      await flush()
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(true) // isUnreadOnly() mock = false → toggle on
      expect(list.rerender).toHaveBeenCalled()
   })

   it("config settings hooks open the image-proxy and backup dialogs", async () => {
      await boot()
      const hooks = configHooks()!
      hooks.openImgProxy()
      hooks.openBackup()
      expect(dropdown.showImgProxyDialog).toHaveBeenCalledTimes(1)
      expect(dropdown.showBackupDialog).toHaveBeenCalledTimes(1)
   })
})

describe("first-run unread-only default", () => {
   it("enables unread-only on first run when no preference is stored", async () => {
      // beforeEach cleared localStorage → the key is absent (never chosen).
      await boot()
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(true)
   })

   it("respects a stored preference and does not force unread-only on at boot", async () => {
      localStorage.setItem("srr-unread-only", "0")
      await boot()
      expect(nav.setUnreadOnly).not.toHaveBeenCalled()
   })
})

describe("Escape — surface toggle ladder", () => {
   const esc = () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
   const openConfig = () =>
      document
         .querySelector<HTMLButtonElement>(".srr-settings")!
         .dispatchEvent(new MouseEvent("click", { bubbles: true }))

   it("reader → list", async () => {
      await boot()
      hashTo("#3") // into the reader
      await flush()
      expect(document.body.classList.contains("srr-view-list")).toBe(false)
      esc()
      await flush()
      expect(document.body.classList.contains("srr-view-list")).toBe(true)
   })

   it("list → reader: opens the selected row (currentChron)", async () => {
      await boot()
      nav.currentChron.mockReturnValue(5)
      nav.goTo.mockClear()
      esc()
      await flush()
      expect(nav.goTo).toHaveBeenCalledWith(5)
   })

   it("list → reader: no selection → opens the filter's oldest unseen (listAnchor)", async () => {
      await boot()
      nav.currentChron.mockReturnValue(-1)
      nav.listAnchor.mockResolvedValue(8)
      nav.goTo.mockClear()
      esc()
      await flush()
      expect(nav.goTo).toHaveBeenCalledWith(8)
   })

   it("list → reader: nothing unseen → opens the newest (last)", async () => {
      await boot()
      nav.currentChron.mockReturnValue(-1)
      nav.listAnchor.mockResolvedValue(-1)
      nav.goTo.mockClear()
      nav.last.mockClear()
      esc()
      await flush()
      expect(nav.goTo).not.toHaveBeenCalled()
      expect(nav.last).toHaveBeenCalledTimes(1)
   })

   it("config open → closes config → reader", async () => {
      await boot()
      openConfig()
      expect(document.body.classList.contains("srr-view-config")).toBe(true)
      config.close.mockClear()
      esc()
      await flush()
      expect(config.close).toHaveBeenCalled()
      expect(document.body.classList.contains("srr-view-config")).toBe(false)
   })

   it("an open error popup closes first and does not toggle surfaces", async () => {
      await boot()
      nav.goTo.mockClear()
      document.querySelector(".srr-popup")!.classList.add("srr-open")
      esc()
      await flush()
      expect(document.querySelector(".srr-popup")!.classList.contains("srr-open")).toBe(false)
      expect(nav.goTo).not.toHaveBeenCalled()
   })
})

// The freshness / degradation status line moved into the config surface
// (config.refreshStatus, covered in config.test.ts), so app.ts no longer owns a
// status banner — that describe was removed with the move.

// Helper: invoke the pin action from the pinEntry hook app.ts hands to
// config.setup (simulates the config "Download for offline" tap) and wait for the
// async pin to settle. Sets up a fake SW controller so pinCurrentFilter doesn't
// bail early.
async function invokePinAction(isUnreadOnly: boolean): Promise<void> {
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
   // Grab the pinEntry hook app.ts passed to config.setup and resolve it.
   const pinEntry = configHooks()!.pinEntry as () => { label: string; action: () => void } | null
   const entry = pinEntry()
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
   // Pin progress/caveat now renders in the dedicated non-live .srr-pin-progress
   // node (not the aria-live .srr-status banner) — see fe-feat#F2/F3/F4 fixes.
   const status = () => document.querySelector(".srr-pin-progress") as HTMLElement

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
