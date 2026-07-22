import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { srcColorIndex } from "./fmt"
// pin.ts is NOT mocked — it's a thin localStorage registry (stateless: every
// call reads/writes srr-pins), so the top-level instance here and the fresh one
// app.ts imports after vi.resetModules() both see the same localStorage.
import { isPinned, listPins, pinFilter } from "./pin"

// app.ts is the DOM/async orchestrator: it has no exports, runs init() at import,
// and wires every listener. We mock its collaborators, seed the full toolbar +
// reader + popup skeleton, then drive it through real events (hashchange, click,
// keydown) and assert routing decisions / the guard mutex / the popup focus trap
// — the pure-logic P1s the heavy e2e-browser layer can't economically pin.

interface ShowFeed {
   article: { f: number; a: number; p: number; t: string; l: string; c: string }
   has_left: boolean
   has_right: boolean
   right_count: number
   feed?: { id: number; tag: string }
   placeholder?: boolean
   notStarted?: boolean
   startFeed?: number
   filtered?: boolean
}
const showFeed = (o: Partial<ShowFeed> = {}): ShowFeed => ({
   article: { f: 1, a: 0, p: 0, t: "Title", l: "", c: "<p>body</p>" },
   has_left: false,
   has_right: false,
   right_count: 0,
   ...o,
})

const nav = vi.hoisted(() => {
   const sf = () => ({
      article: { f: 1, a: 0, p: 0, t: "T", l: "", c: "<p>x</p>" },
      has_left: false,
      has_right: false,
      right_count: 0,
   })
   return {
      SAVED_TOKEN: "~saved",
      SEARCH_PREFIX: "q:",
      pruneSeen: vi.fn(),
      fromHash: vi.fn(async () => sf()),
      applyFilter: vi.fn(),
      tokensSuffix: vi.fn(() => ""),
      // The real implementations: pure grammar helpers with no nav state, so
      // faithful inline copies (not stubs) keep the routing tests accurate.
      hashPos: (hash: string) => {
         const bang = hash.indexOf("!")
         return bang === -1 ? hash : hash.substring(0, bang)
      },
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
      SAVED_TOKEN: "~saved",
      getCurrentFilterKey: vi.fn(() => ""),
      filterLabel: vi.fn((key: string) =>
         key === "" ? "All" : key === "~saved" ? "★ Saved" : /^\d+$/.test(key) ? data.feedTitle(Number(key)) : key,
      ),
      getFilterEntries: vi.fn(() => [""]),
      cycleFilter: vi.fn(async () => sf()),
      cycleToken: vi.fn(async () => ""),
      isSearchFilter: vi.fn(() => false),
      searchAvailable: vi.fn(() => true),
      searchQuery: vi.fn(() => ""),
      searchShort: vi.fn(() => false),
      searchTruncated: vi.fn(() => false),
      isUnreadOnly: vi.fn(() => false),
      setUnreadOnly: vi.fn(),
      markAllRead: vi.fn(() => true),
      markUnreadFrom: vi.fn(() => true),
      probeCurrent: vi.fn(async () => null),
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
      filterKey: vi.fn(() => ""),
      filter: { feeds: new Map<number, number>(), saved: false, search: false, active: false, tokens: [] as string[] },
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
   // The active store context app reads for the pin message base/mid and the
   // article base it hands the fmt sanitizer (home mid "0", loopback base).
   activeStore: () => ({ mid: "0", base: new URL("http://localhost/") }),
}))
vi.mock("./data", () => data)

const list = vi.hoisted(() => ({
   setup: vi.fn(),
   show: vi.fn(async () => {}),
   render: vi.fn(async () => {}),
   rerender: vi.fn(async () => {}),
   refresh: vi.fn(),
   invalidate: vi.fn(),
   moveSelection: vi.fn(async () => 0),
   // The shared directed empty-state element; the reader mounts it for placeholders.
   // The real wording/branches are exercised in list.test.ts — here it's a marker.
   emptyStateEl: vi.fn(() => {
      const e = document.createElement("div")
      e.className = "srr-list-empty"
      e.textContent = "No articles under this filter yet."
      return e
   }),
}))
vi.mock("./list", () => list)

const dropdown = vi.hoisted(() => ({
   setProfileImportHook: vi.fn(),
   showImgProxyDialog: vi.fn(),
   showBackupDialog: vi.fn(),
   showSyncDialog: vi.fn(),
   showContextMenu: vi.fn(),
}))
// The dialog openers are stubbed (their modals are dropdown.test.ts's business),
// but the real wrapTabFocus passes through — the error-popup focus-trap test
// below exercises it against app.ts's own popup markup.
vi.mock("./dropdown", async (importOriginal) => ({ ...(await importOriginal<object>()), ...dropdown }))

// Cross-device sync: app.ts only wires it (sync.init with the shared
// after-merge refresh, after the first route); the cycles themselves are
// sync.test.ts's business.
const sync = vi.hoisted(() => ({
   init: vi.fn(),
   syncNow: vi.fn(async () => {}),
}))
vi.mock("./sync", () => sync)

// Live content sync: app.ts only wires it (refresh.init with the background
// guard + after-store refresh). The refresh cycles themselves are
// refresh.test.ts's business.
const refresh = vi.hoisted(() => ({
   init: vi.fn(),
   refreshNow: vi.fn(async () => ""),
   lastRefreshError: vi.fn(() => ""),
}))
vi.mock("./refresh", () => refresh)

// The filter picker overlay is its own module; app.ts opens it from the
// now-viewing readout and passes {onSelect, onClose} to picker.setup — we mock
// it and capture those hooks. renderStatus backs the settings menu's footer.
const picker = vi.hoisted(() => ({
   setup: vi.fn(),
   open: vi.fn(),
   close: vi.fn(),
   render: vi.fn(),
   renderStatus: vi.fn(),
   isOpen: vi.fn(() => false),
}))
vi.mock("./picker", () => picker)
// The hooks object app.ts passes to picker.setup (onSelect / onClose) —
// captured for assertions.
const pickerHooks = () => (picker.setup as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]

vi.mock("./fmt", () => ({
   sanitizeFragment: (s: string) => {
      const t = document.createElement("template")
      t.innerHTML = s
      return t.content
   },
   formatDate: () => "01/01/2020 00:00",
   readerDateline: () => ({ text: "1h ago", title: "01/01/2020 00:00" }),
   srcColorIndex: () => 0,
   timeAgo: () => "1h",
   timeAgoProse: (unix: number) => (unix === 0 ? "just now" : "4 minutes ago"),
   isStale: (unix: number) => unix > 0 && unix < 1000,
   countBadge: (n: number) => (n > 999 ? "999+" : String(n)),
   CHECK_SVG: '<svg class="check"></svg>',
   collapseBrokenMedia: () => {},
}))

const gestures = vi.hoisted(() => {
   // One stable resetScroll instance the setupGestures() result closes over, so
   // tests can assert the reader render path reveals the toolbar through it.
   const resetScroll = vi.fn()
   return { resetScroll, setupGestures: vi.fn(() => ({ resetScroll })) }
})
vi.mock("./gestures", () => gestures)

const SKELETON = `
   <div class="srr-popup"><span class="srr-popup-text"></span>
      <button class="srr-popup-retry srr-hidden">Retry</button>
      <button class="srr-popup-close">x</button></div>
   <main class="srr-container">
      <div class="srr-searchbar"><input class="srr-search-input" /><button class="srr-search-clear"></button>
         <div class="srr-search-note"></div></div>
      <article class="srr-reader" hidden>
         <a class="srr-title-row"><div class="srr-kicker"><span class="srr-source"></span><span class="srr-desk"></span><time class="srr-date"></time></div><h1 class="srr-title" tabindex="-1"></h1></a>
         <div class="srr-content"></div></article>
      <div class="srr-list" hidden></div>
      <nav class="srr-toolbar">
         <button class="srr-back"><span class="srr-back-icon"></span><span class="srr-back-label"></span></button>
         <button class="srr-open-reader"></button>
         <button class="srr-feed"><span class="srr-feed-name"></span></button>
         <button class="srr-prev" disabled></button>
         <button class="srr-next" disabled><span class="srr-next-count"></span></button>
         <button class="srr-save" disabled></button>
         <button class="srr-filter"></button>
      </nav>
      <section class="srr-picker" hidden></section>
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
   // nav.filter is shared plain state, not a mock fn — reset it by hand so a
   // test that flips saved/search or seeds feeds can't leak into the next.
   nav.filter.feeds = new Map()
   nav.filter.saved = false
   nav.filter.search = false
   nav.filter.active = false
   nav.filter.tokens = []
   data.init.mockResolvedValue(undefined)
   nav.fromHash.mockResolvedValue(showFeed())
   // vi.clearAllMocks clears calls but NOT mockReturnValue — pin the picker's
   // open-state explicitly so a test that flips it can't leak into the next.
   picker.isOpen.mockReturnValue(false)
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

// The reader's programmatic scroll-to-top on every render must ALSO resync the
// toolbar auto-hide baseline (gestures.resetScroll), so the bottom bar is
// revealed on arrival instead of leaking the hidden state from the previous
// article — the reader can't rely on the scrollTo(0,0) scroll event firing
// (it doesn't when already at y=0, and mobile coalesces / mis-reads it).
describe("reader render — toolbar auto-hide reset (resetScroll)", () => {
   it("reveals the toolbar when an article is rendered", async () => {
      await boot()
      gestures.resetScroll.mockClear()
      hashTo("#2")
      await flush()
      expect(document.querySelector(".srr-reader")!.hasAttribute("hidden")).toBe(false) // reader shown
      expect(gestures.resetScroll).toHaveBeenCalled()
   })

   it("reveals the toolbar again on each subsequent navigation", async () => {
      await boot()
      hashTo("#2")
      await flush()
      gestures.resetScroll.mockClear()
      hashTo("#3") // step to the next article
      await flush()
      expect(gestures.resetScroll).toHaveBeenCalled()
   })

   it("reveals the toolbar on the directed empty-state (placeholder) render too", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(showFeed({ placeholder: true, has_right: false }))
      gestures.resetScroll.mockClear()
      hashTo("#5")
      await flush()
      // Placeholder path (renderEmptyReader) — still must reveal the bar.
      expect(gestures.resetScroll).toHaveBeenCalled()
   })
})

describe("next pill pending count", () => {
   const countEl = () => document.querySelector(".srr-next-count") as HTMLElement
   const nextBtn = () => document.querySelector(".srr-next") as HTMLButtonElement

   it("shows the pending digits and folds the count into the accessible name", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(showFeed({ has_right: true, right_count: 12 }))
      hashTo("#5")
      await flush()
      expect(countEl().textContent).toBe("12")
      expect(nextBtn().getAttribute("aria-label")).toBe("Next article — 12 remaining")
      expect(nextBtn().title).toContain("12 remaining")
   })

   it("caps the digits at 999+ like the picker badges", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(showFeed({ has_right: true, right_count: 4321 }))
      hashTo("#5")
      await flush()
      expect(countEl().textContent).toBe("999+")
      // The accessible name keeps the exact figure — the cap is a width concern.
      expect(nextBtn().getAttribute("aria-label")).toBe("Next article — 4321 remaining")
   })

   it("hides the digits only on an unknown (-1) count", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(showFeed({ has_right: true, right_count: -1 }))
      hashTo("#5")
      await flush()
      expect(countEl().textContent).toBe("") // degraded probe: pill works, digits hidden
      expect(nextBtn().getAttribute("aria-label")).toBe("Next article")
   })

   it("shows an explicit 0 on the disabled pill at the last article — nothing ahead, said out loud", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(showFeed({ has_right: false, right_count: 0 }))
      hashTo("#5")
      await flush()
      expect(nextBtn().disabled).toBe(true)
      expect(countEl().textContent).toBe("0")
      expect(nextBtn().getAttribute("aria-label")).toBe("Next article — 0 remaining")
   })

   it("clears stale digits when the placeholder renders", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(showFeed({ has_right: true, right_count: 3 }))
      hashTo("#5")
      await flush()
      expect(countEl().textContent).toBe("3")

      nav.fromHash.mockResolvedValue(
         showFeed({ placeholder: true, article: { f: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" } }),
      )
      hashTo("#6")
      await flush()
      expect(countEl().textContent).toBe("")
   })
})

describe("reader placeholder — directed empty state (no matching articles)", () => {
   it("mounts the shared empty state, hides the article chrome, and disables prev/next/save", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(
         showFeed({ placeholder: true, article: { f: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" } }),
      )
      hashTo("#5")
      await flush()

      const reader = document.querySelector(".srr-reader") as HTMLElement
      expect(reader.hasAttribute("hidden")).toBe(false) // reader surface is shown
      // The list's directed empty state is mounted in the content area instead of a
      // bare title + empty body.
      expect(list.emptyStateEl).toHaveBeenCalled()
      expect(reader.querySelector(".srr-content .srr-list-empty")).not.toBeNull()
      // Chrome hidden (no stray "[DELETED]" source for the synthetic feed 0), and
      // the bare placeholder title is cleared.
      expect(reader.classList.contains("srr-reader-empty")).toBe(true)
      expect((document.querySelector(".srr-title") as HTMLElement).textContent).toBe("")
      // Nothing to step to or save.
      expect((document.querySelector(".srr-prev") as HTMLButtonElement).disabled).toBe(true)
      expect((document.querySelector(".srr-next") as HTMLButtonElement).disabled).toBe(true)
      expect((document.querySelector(".srr-save") as HTMLButtonElement).disabled).toBe(true)
   })

   it("keeps Next armed (enabled + full-backlog pill) on the not-started placeholder", async () => {
      // nav.switchFilter arms the "not started" placeholder (has_right + the
      // backlog count): reading starts with a →/D/click/swipe from right here —
      // the placeholder must NOT force a detour through the list.
      await boot()
      nav.fromHash.mockResolvedValue(
         showFeed({
            placeholder: true,
            notStarted: true,
            startFeed: 3,
            has_right: true,
            right_count: 7,
            article: { f: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" },
         }),
      )
      hashTo("#5")
      await flush()

      // The empty state names the feed the armed Next opens (startFeed threads through).
      expect(list.emptyStateEl).toHaveBeenCalledWith({ notStarted: true, startFeed: 3 })
      const next = document.querySelector(".srr-next") as HTMLButtonElement
      expect(next.disabled).toBe(false)
      expect((document.querySelector(".srr-next-count") as HTMLElement).textContent).toBe("7")
      // Prev/save stay dead — nothing behind, nothing to save.
      expect((document.querySelector(".srr-prev") as HTMLButtonElement).disabled).toBe(true)
      expect((document.querySelector(".srr-save") as HTMLButtonElement).disabled).toBe(true)
      // The armed button really steps: a click routes to nav.right().
      nav.right.mockResolvedValue(showFeed({ article: { f: 1, a: 0, p: 0, t: "First", l: "", c: "<p>hi</p>" } }))
      next.click()
      await flush()
      expect(nav.right).toHaveBeenCalled()
   })

   it("clears the empty-state marker when a real article renders next", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(
         showFeed({ placeholder: true, article: { f: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" } }),
      )
      hashTo("#5")
      await flush()
      expect((document.querySelector(".srr-reader") as HTMLElement).classList.contains("srr-reader-empty")).toBe(true)

      nav.fromHash.mockResolvedValue(showFeed({ article: { f: 1, a: 0, p: 0, t: "Real", l: "", c: "<p>hi</p>" } }))
      hashTo("#6")
      await flush()
      const reader = document.querySelector(".srr-reader") as HTMLElement
      expect(reader.classList.contains("srr-reader-empty")).toBe(false)
      expect(reader.querySelector(".srr-list-empty")).toBeNull()
      expect((document.querySelector(".srr-title") as HTMLElement).textContent).toBe("Real")
   })

   it("moves focus into the visible content, not the hidden heading", async () => {
      // The empty state hides the whole title row; focus must land on .srr-content instead.
      await boot()
      nav.fromHash.mockResolvedValue(
         showFeed({ placeholder: true, article: { f: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" } }),
      )
      hashTo("#5")
      await flush()
      expect(document.activeElement).toBe(document.querySelector(".srr-content"))
   })
})

describe("reader titleless feeds (Telegram-style: title duplicates the body)", () => {
   it("flags the reader titleless and points the masthead permalink at the article link", async () => {
      await boot()
      // Feed 7 is flagged nt (its titles duplicate the content lead).
      data.db.feeds = { 7: { nt: true } } as unknown as IDB["feeds"]
      nav.fromHash.mockResolvedValue(
         showFeed({ article: { f: 7, a: 0, p: 0, t: "Dup line", l: "http://example.com/p/7", c: "<p>Dup line</p>" } }),
      )
      hashTo("#7")
      await flush()
      const reader = document.querySelector(".srr-reader") as HTMLElement
      expect(reader.classList.contains("srr-reader-titleless")).toBe(true)
      // The whole masthead row is the permalink; on a titleless feed the visible
      // source · date row stands in for the hidden title.
      expect((document.querySelector(".srr-title-row") as HTMLAnchorElement).getAttribute("href")).toBe(
         "http://example.com/p/7",
      )
   })

   it("keeps the heading but still offers the masthead permalink on an ordinary feed", async () => {
      await boot()
      // Feed 1 has no nt flag (absent from the map); its article carries a link.
      nav.fromHash.mockResolvedValue(
         showFeed({ article: { f: 1, a: 0, p: 0, t: "Real", l: "http://example.com/p/1", c: "<p>x</p>" } }),
      )
      hashTo("#8")
      await flush()
      const reader = document.querySelector(".srr-reader") as HTMLElement
      expect(reader.classList.contains("srr-reader-titleless")).toBe(false)
      // The masthead row is the permalink regardless of titleless; app.ts sets
      // its href on every linked article.
      expect((document.querySelector(".srr-title-row") as HTMLAnchorElement).getAttribute("href")).toBe(
         "http://example.com/p/1",
      )
   })

   it("moves focus into the visible content, not the hidden heading", async () => {
      // feed.nt hides the <h1>; focus must land on .srr-content instead.
      await boot()
      data.db.feeds = { 7: { nt: true } } as unknown as IDB["feeds"]
      nav.fromHash.mockResolvedValue(
         showFeed({ article: { f: 7, a: 0, p: 0, t: "Dup line", l: "http://example.com/p/7", c: "<p>Dup line</p>" } }),
      )
      hashTo("#7")
      await flush()
      expect(document.activeElement).toBe(document.querySelector(".srr-content"))
   })
})

describe("reader compaction tombstone (§9.3 — expired article, no stored content)", () => {
   it("renders 'no longer stored' when the article payload is absent, keeping source + date", async () => {
      await boot()
      // `srr compact` drops c/t/l and keeps f/a/p — the wire line has no `c`.
      nav.fromHash.mockResolvedValue(showFeed({ article: { f: 1, a: 0, p: 1700000000 } as unknown as IArticle }))
      hashTo("#42")
      await flush()
      const content = document.querySelector(".srr-content") as HTMLElement
      expect(content.querySelector(".srr-expired-note")?.textContent).toBe("This article is no longer stored")
      // It is NOT the "(no matching articles)" empty state — the reader chrome stays.
      expect(content.querySelector(".srr-list-empty")).toBeNull()
      const reader = document.querySelector(".srr-reader") as HTMLElement
      expect(reader.classList.contains("srr-reader-empty")).toBe(false)
      // Source · date still render (the masthead is intact — a sibling of [DELETED]).
      expect((document.querySelector(".srr-date") as HTMLElement).hidden).toBe(false)
   })

   it("renders normal content when the payload is present (no false tombstone)", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(showFeed({ article: { f: 1, a: 0, p: 0, c: "<p>alive</p>" } as IArticle }))
      hashTo("#43")
      await flush()
      const content = document.querySelector(".srr-content") as HTMLElement
      expect(content.querySelector(".srr-expired-note")).toBeNull()
      expect(content.textContent).toContain("alive")
   })
})

describe("reader dateline + permalink structure", () => {
   // readerDateline is mocked to a constant {text,title}; these assert app.ts's
   // render actually WIRES it into the masthead date element and shapes the permalink
   // — the integration the unit tests of readerDateline itself can't cover.
   it("wires the relative dateline into the masthead date text + hover title", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(
         showFeed({ article: { f: 1, a: 0, p: 1700000000, t: "Real", l: "http://example.com/p/1", c: "<p>x</p>" } }),
      )
      hashTo("#9")
      await flush()
      const date = document.querySelector(".srr-date") as HTMLElement
      // The mock's text and title are DISTINCT strings, so a text↔title transposition
      // in the render path (el.date.textContent vs el.date.title) is caught here.
      expect(date.textContent).toBe("1h ago")
      expect(date.title).toBe("01/01/2020 00:00")
      expect(date.hidden).toBe(false)
   })

   it("hides the masthead date on an undated (p=0) article", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(
         showFeed({ article: { f: 1, a: 0, p: 0, t: "Real", l: "http://example.com/p/1", c: "<p>x</p>" } }),
      )
      hashTo("#10")
      await flush()
      const date = document.querySelector(".srr-date") as HTMLElement
      expect(date.hidden).toBe(true)
      expect(date.textContent).toBe("")
   })

   it("the masthead permalink is one anchor with no nested <a> inside it", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(
         showFeed({ article: { f: 1, a: 0, p: 1700000000, t: "Real", l: "http://example.com/p/1", c: "<p>x</p>" } }),
      )
      hashTo("#11")
      await flush()
      const row = document.querySelector(".srr-title-row") as HTMLAnchorElement
      expect(row.tagName).toBe("A")
      // The inner title <a> was unwrapped (globe icon removed) so the whole row is the
      // single "open original" link — there must be no invalid nested anchor.
      expect(row.querySelectorAll("a").length).toBe(0)
   })
})

describe("reader desk (the article's tag, shown above the byline)", () => {
   it("fills the desk with the feed's tag", async () => {
      await boot()
      data.db.feeds = { 3: { tag: "ofertas" } } as unknown as IDB["feeds"]
      nav.fromHash.mockResolvedValue(showFeed({ article: { f: 3, a: 0, p: 0, t: "Deal", l: "", c: "<p>x</p>" } }))
      hashTo("#3")
      await flush()
      // CSS uppercases it; app.ts prepends the "#". :not(:empty) reveals it.
      expect((document.querySelector(".srr-desk") as HTMLElement).textContent).toBe("#ofertas")
   })

   it("leaves the desk empty (hidden) for an untagged feed", async () => {
      await boot()
      data.db.feeds = { 1: {} } as unknown as IDB["feeds"]
      nav.fromHash.mockResolvedValue(showFeed({ article: { f: 1, a: 0, p: 0, t: "Plain", l: "", c: "<p>x</p>" } }))
      hashTo("#4")
      await flush()
      expect((document.querySelector(".srr-desk") as HTMLElement).textContent).toBe("")
   })
})

describe("back-button filter breadcrumb (which lane is the reader in)", () => {
   const backLabel = () => document.querySelector(".srr-back-label") as HTMLElement
   const back = () => document.querySelector(".srr-back") as HTMLButtonElement

   it("names a tag filter as a hashtag and folds it into the button's accessible name", async () => {
      await boot()
      nav.getCurrentFilterKey.mockReturnValue("info")
      hashTo("#3!info")
      await flush()
      expect(backLabel().textContent).toBe("#info")
      expect(back().getAttribute("aria-label")).toBe("Back to list — filtered: #info")
      expect(back().title).toBe("Back to list — filtered: #info")
   })

   it("names a single-feed filter by title, tinted with its source color", async () => {
      await boot()
      nav.getCurrentFilterKey.mockReturnValue("7")
      hashTo("#3!7")
      await flush()
      expect(backLabel().textContent).toBe("Feed") // data.feedTitle mock
      expect(backLabel().dataset.src).toBe(String(srcColorIndex(7)))
   })

   it("names the saved smart-folder without a hashtag", async () => {
      await boot()
      nav.getCurrentFilterKey.mockReturnValue("~saved")
      hashTo("#3!~saved")
      await flush()
      expect(backLabel().textContent).toBe("★ Saved")
      expect(backLabel().dataset.src).toBeUndefined()
   })

   it("stays empty (hidden) on the unfiltered wire — silence means [ALL]", async () => {
      await boot()
      // clearAllMocks resets calls, not mockReturnValue — pin the key explicitly.
      nav.getCurrentFilterKey.mockReturnValue("")
      hashTo("#3")
      await flush()
      expect(backLabel().textContent).toBe("")
      expect(back().getAttribute("aria-label")).toBe("Back to list")
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

   it("self-heals a wedged mutex so a stalled navigation stops dropping later navs forever", async () => {
      await boot()
      // A navigation whose promise never settles — a fetch with no timeout that
      // stalls mid-body — leaves busy stuck true. This is the reported bug: from
      // then on every guard()-routed action (swipe/arrows/buttons) silently
      // no-ops until the page is reloaded.
      nav.fromHash.mockImplementationOnce(() => new Promise<never>(() => {}))
      hashTo("#2")
      await flush()
      expect(nav.fromHash).toHaveBeenCalledTimes(1)
      nav.fromHash.mockResolvedValue(showFeed())
      // Far past any bounded operation the held mutex is treated as stale, so a
      // fresh navigation reclaims it instead of being dropped (swipe works again).
      try {
         vi.useFakeTimers()
         vi.setSystemTime(Date.now() + 10 * 60_000)
         hashTo("#3")
         await vi.advanceTimersByTimeAsync(0)
      } finally {
         vi.useRealTimers()
      }
      expect(nav.fromHash).toHaveBeenLastCalledWith("3")
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

   // The reader's filter button can open the picker OVER the reader (view stays
   // "reader"), so a one-finger swipe on the overlay must not step/bell the reader
   // underneath — same guard the keymap and two-finger cycle already have.
   it("a one-finger swipe is inert while the picker overlay is open", async () => {
      await boot()
      hashTo("#2")
      await flush()
      const reader = document.querySelector(".srr-reader") as HTMLElement
      reader.classList.remove("srr-bell-right")
      nav.right.mockClear()
      picker.isOpen.mockReturnValue(true)
      // The gesture deps app passed to setupGestures — goNext IS the committed swipe.
      const deps = gestures.setupGestures.mock.calls[0][0] as { goNext: () => void }
      deps.goNext()
      expect(nav.right).not.toHaveBeenCalled()
      expect(reader.classList.contains("srr-bell-right")).toBe(false)
      picker.isOpen.mockReturnValue(false)
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

   it("closes the error popup on an outside mousedown", async () => {
      await boot()
      nav.fromHash.mockRejectedValue(new Error("boom"))
      hashTo("#5")
      await flush()
      expect(popup().classList.contains("srr-open")).toBe(true)
      // A press anywhere outside the popup dismisses it (the window mousedown
      // handler); body is not inside .srr-popup.
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      expect(popup().classList.contains("srr-open")).toBe(false)
   })
})

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

// The list-vs-reader routing in the picker's onSelect callback lives in app.ts.
// These tests pin that decision, per surface: picking from the LIST re-filters
// the list in place (selectFilter → applyFilter + goToList); picking from the
// READER stays in the reader on the picked lane's resume article (switchFilter,
// the same semantics as the W/S / two-finger filter cycle).
describe("filter picker — the toolbar's filter button (both surfaces)", () => {
   it("tapping the filter button on the LIST opens the picker overlay", async () => {
      await boot() // boots into the list (hash "" → list surface)
      picker.open.mockClear()
      document.querySelector(".srr-filter")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      expect(picker.open).toHaveBeenCalledTimes(1)
      // The overlay is not a view of its own — the list stays the surface under it.
      expect(document.body.classList.contains("srr-view-list")).toBe(true)
   })

   it("onSelect closes the picker and re-filters the LIST (not the reader)", async () => {
      await boot() // list surface
      nav.switchFilter.mockClear()
      nav.applyFilter.mockClear()
      picker.close.mockClear()
      pickerHooks()!.onSelect("42")
      await flush()
      expect(picker.close).toHaveBeenCalled()
      expect(nav.applyFilter).toHaveBeenCalledWith(["42"])
      // List path only — a pick must NOT take the reader path (switchFilter).
      expect(nav.switchFilter).not.toHaveBeenCalled()
      expect(document.body.classList.contains("srr-view-list")).toBe(true)
      expect(list.show).toHaveBeenCalled()
      expect(document.querySelector(".srr-reader")!.hasAttribute("hidden")).toBe(true)
   })

   it("onSelect('') routes to [ALL] (empty token list)", async () => {
      await boot()
      nav.applyFilter.mockClear()
      pickerHooks()!.onSelect("")
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith([])
   })

   it("the same filter button opens the picker overlay over the reader", async () => {
      await boot()
      hashTo("#2")
      await flush()
      picker.open.mockClear()
      document.querySelector(".srr-filter")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      expect(picker.open).toHaveBeenCalledTimes(1)
      // The overlay is not a view of its own — the reader stays the surface under it.
      expect(document.body.classList.contains("srr-view-list")).toBe(false)
   })

   it("onSelect from the reader stays in the reader — switchFilter, not the list path", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.switchFilter.mockClear()
      nav.applyFilter.mockClear()
      picker.close.mockClear()
      pickerHooks()!.onSelect("42")
      await flush()
      expect(picker.close).toHaveBeenCalled()
      expect(nav.switchFilter).toHaveBeenCalledWith("42")
      expect(nav.applyFilter).not.toHaveBeenCalled() // no list re-filter …
      expect(document.body.classList.contains("srr-view-list")).toBe(false) // … and no surface switch
      expect(document.querySelector(".srr-reader")!.hasAttribute("hidden")).toBe(false)
   })

   it("onClose just closes the overlay — the list underneath never moved", async () => {
      await boot()
      picker.close.mockClear()
      list.show.mockClear()
      pickerHooks()!.onClose()
      expect(picker.close).toHaveBeenCalledTimes(1)
      expect(list.show).not.toHaveBeenCalled() // no re-render, no navigation
   })

   // "Show read" moved from the settings gear to the picker header; app.ts wires
   // the picker's onToggleShowRead hook to flip unread-only and reconcile whichever
   // surface the overlay is open over (the picker re-renders its own rows itself).
   it("onToggleShowRead over the list flips unread-only and rebuilds the list", async () => {
      await boot() // list surface
      nav.isUnreadOnly.mockReturnValue(false) // read shown → toggle turns unread-only on
      nav.setUnreadOnly.mockClear()
      list.rerender.mockClear()
      list.invalidate.mockClear()
      pickerHooks()!.onToggleShowRead()
      await flush()
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(true)
      expect(list.rerender).toHaveBeenCalledTimes(1) // visible list rebuilds now
      expect(list.invalidate).not.toHaveBeenCalled()
      expect(nav.probeCurrent).not.toHaveBeenCalled() // no reader on screen
   })

   it("onToggleShowRead over the reader (a real article) flips it, defers the hidden list, and re-probes the reader", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.currentChron.mockReturnValue(2) // a real article on screen (not a placeholder)
      nav.isUnreadOnly.mockReturnValue(true) // unread-only → toggle turns it off
      nav.setUnreadOnly.mockClear()
      list.rerender.mockClear()
      list.invalidate.mockClear()
      nav.probeCurrent.mockClear()
      pickerHooks()!.onToggleShowRead()
      await flush()
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(false)
      expect(list.invalidate).toHaveBeenCalledTimes(1) // hidden list: deferred rebuild
      expect(list.rerender).not.toHaveBeenCalled() // never rebuild a display:none list
      expect(nav.probeCurrent).toHaveBeenCalledTimes(1) // reader chrome re-derives
   })

   it("onToggleShowRead over a reader PLACEHOLDER (currentChron < 0) re-runs the switch, not a no-op reprobe", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.currentChron.mockReturnValue(-1) // reader shows a "Not started"/"caught up" placeholder
      nav.getCurrentFilterKey.mockReturnValue("7")
      nav.isUnreadOnly.mockReturnValue(true)
      nav.setUnreadOnly.mockClear()
      nav.switchFilter.mockClear()
      nav.probeCurrent.mockClear()
      pickerHooks()!.onToggleShowRead()
      await flush()
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(false)
      // probeCurrent no-ops for pos < 0, so the surface must re-resolve via switchFilter
      expect(nav.switchFilter).toHaveBeenCalledWith("7")
      expect(nav.probeCurrent).not.toHaveBeenCalled()
   })

   it("onToggleShowRead over a MULTI-token reader placeholder does not teleport to [ALL]", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.currentChron.mockReturnValue(-1) // placeholder
      nav.filter.active = true
      nav.filter.tokens = ["5", "9"] // multi-token (URL-only) filter, e.g. #!5+9
      nav.getCurrentFilterKey.mockReturnValue("") // getCurrentFilterKey collapses multi-token to ""
      nav.isUnreadOnly.mockReturnValue(true)
      nav.switchFilter.mockClear()
      pickerHooks()!.onToggleShowRead()
      await flush()
      // switchFilter("") would re-filter to [ALL] and teleport the reader off
      // feeds 5+9 — the multi-token placeholder must be left untouched instead.
      expect(nav.switchFilter).not.toHaveBeenCalled()
   })
})

describe("settings menu — the now-viewing readout", () => {
   // The items + opts app.ts handed to the (mocked) showContextMenu on its last open.
   type Item = { label: string; action: () => void; checked?: boolean; disabled?: boolean }
   const menuCall = () => {
      const call = dropdown.showContextMenu.mock.calls.at(-1)
      return { items: call?.[1] as Item[], opts: call?.[2] as { footer?: HTMLElement } | undefined }
   }
   const openMenu = () =>
      document.querySelector<HTMLButtonElement>(".srr-feed")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))

   it("opens an anchored menu with search and the three dialogs (Show read lives in the filter picker now)", async () => {
      await boot()
      openMenu()
      expect(dropdown.showContextMenu).toHaveBeenCalledWith(
         document.querySelector(".srr-feed"),
         expect.anything(),
         expect.anything(),
      )
      const { items } = menuCall()
      // No SW controller in jsdom → the contextual pin row is absent. "Show read"
      // moved to the filter picker's header (see the picker toggle tests).
      expect(items.map((i) => i.label)).toEqual(["Search articles…", "Image proxy…", "Backup / Restore…", "Sync…"])
   })

   it("'Search articles…' leaves the menu for the list with search applied", async () => {
      await boot()
      openMenu()
      nav.applyFilter.mockClear()
      menuCall()
         .items.find((i) => i.label === "Search articles…")!
         .action()
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith(["q:"])
      // Still the list surface — search is a list activity (the bar's visibility
      // itself tracks nav.isSearchFilter, mocked elsewhere).
      expect(document.body.classList.contains("srr-view-list")).toBe(true)
   })

   it("lists search disabled (not hidden) while the index rebuilds", async () => {
      await boot()
      nav.searchAvailable.mockReturnValue(false)
      openMenu()
      expect(menuCall().items.find((i) => i.label === "Search articles…")!.disabled).toBe(true)
      nav.searchAvailable.mockReturnValue(true)
   })

   it("the dialog rows open the image-proxy, backup, and sync modals", async () => {
      await boot()
      openMenu()
      const { items } = menuCall()
      items.find((i) => i.label === "Image proxy…")!.action()
      items.find((i) => i.label === "Backup / Restore…")!.action()
      items.find((i) => i.label === "Sync…")!.action()
      expect(dropdown.showImgProxyDialog).toHaveBeenCalledTimes(1)
      expect(dropdown.showBackupDialog).toHaveBeenCalledTimes(1)
      expect(dropdown.showSyncDialog).toHaveBeenCalledTimes(1)
   })

   it("hands the menu a status footer built by picker.renderStatus", async () => {
      await boot()
      picker.renderStatus.mockClear()
      openMenu()
      const { opts } = menuCall()
      expect(opts?.footer).toBeInstanceOf(HTMLElement)
      expect(picker.renderStatus).toHaveBeenCalledWith(opts!.footer)
   })
})

describe("the frontier menu — right-click / long-press on the reader's next pill, + the reader's U key", () => {
   // The items app.ts handed to the (mocked) showContextMenu on its last open.
   const menuItems = () =>
      dropdown.showContextMenu.mock.calls.at(-1)?.[1] as { label: string; action: () => void }[] | undefined
   const rightClick = (sel: string) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      document.querySelector(sel)!.dispatchEvent(e)
      return e
   }

   it("offers both actions on the reader's next pill and consumes the right-click", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.isSearchFilter.mockReturnValue(false) // vi.fn return values leak across tests
      nav.filter.feeds = new Map([[1, 0]])
      nav.currentChron.mockReturnValue(7)
      const e = rightClick(".srr-next")
      expect(e.defaultPrevented).toBe(true) // ours, not the browser's menu
      expect(dropdown.showContextMenu).toHaveBeenCalledWith(document.querySelector(".srr-next"), expect.anything())
      expect(menuItems()!.map((i) => i.label)).toEqual(["Mark all read", "Mark unread from here"])
   })

   it("'Mark all read' raises and (unread-only, reader view) re-applies + invalidates the hidden list", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.isSearchFilter.mockReturnValue(false)
      nav.filter.feeds = new Map([[1, 0]])
      nav.isUnreadOnly.mockReturnValue(true)
      nav.applyFilter.mockClear()
      rightClick(".srr-next")
      menuItems()!
         .find((i) => i.label === "Mark all read")!
         .action()
      expect(nav.markAllRead).toHaveBeenCalledTimes(1)
      // Unread-only: the membership changed wholesale — re-apply the current
      // tokens and drop the hidden list's built window for the next show().
      expect(nav.applyFilter).toHaveBeenCalledWith([])
      expect(list.invalidate).toHaveBeenCalledTimes(1)
      expect(nav.probeCurrent).toHaveBeenCalledTimes(1) // reader chrome re-derives
   })

   it("the lane readout is NOT an anchor — its right-click falls through to the browser's menu", async () => {
      await boot() // list surface
      nav.isSearchFilter.mockReturnValue(false)
      nav.filter.feeds = new Map([[1, 0]])
      nav.currentChron.mockReturnValue(7) // items WOULD apply — the anchor is what's absent
      const e = rightClick(".srr-feed")
      expect(e.defaultPrevented).toBe(false)
      expect(dropdown.showContextMenu).not.toHaveBeenCalled()
   })

   it("with read items shown nothing re-applies; only the reader chrome re-probes", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.isSearchFilter.mockReturnValue(false)
      nav.filter.feeds = new Map([[1, 0]])
      nav.isUnreadOnly.mockReturnValue(false)
      nav.applyFilter.mockClear()
      rightClick(".srr-next")
      menuItems()!
         .find((i) => i.label === "Mark all read")!
         .action()
      expect(nav.markAllRead).toHaveBeenCalledTimes(1)
      expect(nav.applyFilter).not.toHaveBeenCalled()
      expect(list.rerender).not.toHaveBeenCalled()
      expect(list.invalidate).not.toHaveBeenCalled()
      expect(nav.probeCurrent).toHaveBeenCalledTimes(1)
   })

   it("'Mark unread from here' rewinds from the current article and re-probes the reader chrome", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.isSearchFilter.mockReturnValue(false)
      nav.filter.feeds = new Map([[1, 0]])
      nav.currentChron.mockReturnValue(7)
      rightClick(".srr-next")
      menuItems()!
         .find((i) => i.label === "Mark unread from here")!
         .action()
      expect(nav.markUnreadFrom).toHaveBeenCalledWith(7)
      expect(nav.probeCurrent).toHaveBeenCalledTimes(1)
   })

   it("stays silent in peek modes / with nothing to act on — the native menu is left alone", async () => {
      await boot()
      nav.isSearchFilter.mockReturnValue(false)
      nav.currentChron.mockReturnValue(-1)
      // Empty membership + no current article: nothing applies.
      expect(rightClick(".srr-next").defaultPrevented).toBe(false)
      nav.filter.feeds = new Map([[1, 0]])
      nav.filter.saved = true
      expect(rightClick(".srr-next").defaultPrevented).toBe(false)
      nav.filter.saved = false
      nav.isSearchFilter.mockReturnValue(true)
      expect(rightClick(".srr-next").defaultPrevented).toBe(false)
      expect(dropdown.showContextMenu).not.toHaveBeenCalled()
   })

   it("opens on a 500ms touch hold (iOS has no contextmenu) and swallows the lift's click", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.isSearchFilter.mockReturnValue(false)
      nav.filter.feeds = new Map([[1, 0]])
      nav.currentChron.mockReturnValue(7)
      const next = document.querySelector(".srr-next") as HTMLButtonElement
      next.disabled = false
      vi.useFakeTimers()
      try {
         // jsdom has no PointerEvent ctor; a MouseEvent with pointerType grafted
         // on walks the same listener path.
         const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
         Object.defineProperty(down, "pointerType", { value: "touch" })
         next.dispatchEvent(down)
         vi.advanceTimersByTime(500)
         expect(dropdown.showContextMenu).toHaveBeenCalledTimes(1)
         // The finger lift produces a click on the button — it must not ALSO
         // step to the next article.
         next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
         expect(nav.right).not.toHaveBeenCalled()
         // …and the swallow is one-shot: the next tap navigates again.
         next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
         expect(nav.right).toHaveBeenCalledTimes(1)
      } finally {
         vi.useRealTimers()
      }
   })

   it("a touch hold on the lane readout opens no frontier menu; its lift's click stays the plain settings tap", async () => {
      await boot() // list surface — the readout is a tap-to-open-settings button only
      nav.isSearchFilter.mockReturnValue(false)
      nav.filter.feeds = new Map([[1, 0]])
      nav.currentChron.mockReturnValue(7)
      const readout = document.querySelector(".srr-feed") as HTMLButtonElement
      vi.useFakeTimers()
      try {
         const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
         Object.defineProperty(down, "pointerType", { value: "touch" })
         readout.dispatchEvent(down)
         vi.advanceTimersByTime(500)
         expect(dropdown.showContextMenu).not.toHaveBeenCalled() // no frontier menu on the hold
         readout.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
         // The hold was just a tap: the lift's click opens the settings menu.
         expect(dropdown.showContextMenu).toHaveBeenCalledTimes(1)
         expect(dropdown.showContextMenu).toHaveBeenCalledWith(readout, expect.anything(), expect.anything())
      } finally {
         vi.useRealTimers()
      }
   })

   it("U in the reader rewinds from the current article (the keyboard shortcut)", async () => {
      await boot()
      hashTo("#2")
      await flush()
      nav.isSearchFilter.mockReturnValue(false)
      nav.currentChron.mockReturnValue(2)
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }))
      expect(nav.markUnreadFrom).toHaveBeenCalledWith(2)
   })
})

describe("cross-device sync wiring", () => {
   it("boots sync with the shared after-merge refresh (list view → rerender)", async () => {
      await boot() // list surface
      expect(sync.init).toHaveBeenCalledTimes(1)
      const afterMerge = sync.init.mock.calls[0][0] as () => void
      // An interaction first: the pre-interaction boot merge re-anchors instead
      // (covered in the profile re-anchor suite) — this test pins the GENTLE path.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      nav.pruneSeen.mockClear()
      list.rerender.mockClear()
      picker.render.mockClear()
      picker.isOpen.mockReturnValue(true)
      afterMerge()
      expect(nav.pruneSeen).toHaveBeenCalledTimes(1)
      expect(list.rerender).toHaveBeenCalledTimes(1)
      expect(picker.render).toHaveBeenCalledTimes(1) // open picker re-derives badges
      picker.isOpen.mockReturnValue(false)
   })

   it("the status callback refills an OPEN settings menu's footer, and skips a closed one", async () => {
      await boot()
      const onStatus = sync.init.mock.calls[0][1] as () => void
      // Open the menu; the real showContextMenu attaches the footer to the DOM —
      // the mock must too, since the callback gates on footer.isConnected.
      dropdown.showContextMenu.mockImplementation((_a: HTMLElement, _i: unknown, opts?: { footer?: HTMLElement }) => {
         if (opts?.footer) document.body.appendChild(opts.footer)
      })
      document.querySelector<HTMLButtonElement>(".srr-feed")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      const footer = (dropdown.showContextMenu.mock.calls.at(-1)?.[2] as { footer: HTMLElement }).footer
      picker.renderStatus.mockClear()
      onStatus()
      expect(picker.renderStatus).toHaveBeenCalledWith(footer) // live refill in place
      footer.remove() // the menu closed
      picker.renderStatus.mockClear()
      onStatus()
      expect(picker.renderStatus).not.toHaveBeenCalled() // disconnected footer → skipped
   })

   it("skips the list rebuild while the reader is on screen (show() re-derives on return)", async () => {
      await boot("#2") // reader surface
      const afterMerge = sync.init.mock.calls[0][0] as () => void
      list.rerender.mockClear()
      afterMerge()
      expect(list.rerender).not.toHaveBeenCalled()
   })
})

describe("live content sync wiring", () => {
   it("wires refresh.init with the background guard and after-store refresh", async () => {
      await boot()
      expect(refresh.init).toHaveBeenCalledTimes(1)
      expect(typeof refresh.init.mock.calls[0][0]).toBe("function") // guardBg
      expect(typeof refresh.init.mock.calls[0][1]).toBe("function") // refreshAfterStore
   })
})

// The navigator half of the sync feature: the profile syncs on PAGE LOAD (there
// is deliberately no button) — when the boot pull CHANGES the read state (read
// elsewhere, then reload this tab: the device-switch moment), the navigable
// range is stale, so before the first interaction the list re-derives its
// filter bounds from the new seen map and re-anchors at the new resume
// position. Everything after the first interaction stays gentle.
describe("profile re-anchor — the boot pull changed read positions", () => {
   it("re-anchors the list before any interaction (device-switch moment)", async () => {
      await boot() // list view, nothing touched yet
      const afterMerge = sync.init.mock.calls[0][0] as () => void
      nav.applyFilter.mockClear()
      list.render.mockClear()
      list.rerender.mockClear()
      afterMerge()
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith([]) // re-snapshot bounds for the current tokens
      expect(list.render).toHaveBeenCalledTimes(1) // the full re-anchor…
      expect(list.rerender).not.toHaveBeenCalled() // …not the gentle rebuild
   })

   it("a merge after the first interaction stays gentle (no re-anchor)", async () => {
      await boot()
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      const afterMerge = sync.init.mock.calls[0][0] as () => void
      nav.applyFilter.mockClear()
      list.render.mockClear()
      list.rerender.mockClear()
      afterMerge()
      await flush()
      expect(list.render).not.toHaveBeenCalled()
      expect(list.rerender).toHaveBeenCalledTimes(1)
   })

   it("exempts the saved/search peek modes (gentle rebuild instead)", async () => {
      await boot()
      nav.filter.saved = true
      try {
         const afterMerge = sync.init.mock.calls[0][0] as () => void
         nav.applyFilter.mockClear()
         list.render.mockClear()
         list.rerender.mockClear()
         afterMerge()
         await flush()
         expect(nav.applyFilter).not.toHaveBeenCalled()
         expect(list.render).not.toHaveBeenCalled()
         expect(list.rerender).toHaveBeenCalledTimes(1)
      } finally {
         nav.filter.saved = false
      }
   })

   it("a boot merge in the READER stays gentle (restored positions and deep links hold)", async () => {
      await boot("#2") // reader view, no interaction
      const afterMerge = sync.init.mock.calls[0][0] as () => void
      list.render.mockClear()
      afterMerge()
      await flush()
      expect(list.render).not.toHaveBeenCalled()
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

   it("picker open → Escape closes the overlay and stays on the list", async () => {
      await boot()
      picker.isOpen.mockReturnValue(true)
      picker.close.mockClear()
      nav.goTo.mockClear()
      nav.last.mockClear()
      esc()
      await flush()
      expect(picker.close).toHaveBeenCalled()
      // No surface toggle underneath — the list is exactly where it was.
      expect(nav.goTo).not.toHaveBeenCalled()
      expect(nav.last).not.toHaveBeenCalled()
      expect(document.body.classList.contains("srr-view-list")).toBe(true)
   })

   it("the list keymap is inert while the picker overlay is open", async () => {
      await boot()
      picker.isOpen.mockReturnValue(true)
      list.moveSelection.mockClear()
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }))
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }))
      expect(list.moveSelection).not.toHaveBeenCalled()
      expect(document.body.classList.contains("srr-searching")).toBe(false)
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

describe("list cycle keys — W/S and ↑/↓ step the filter on the list too", () => {
   const key = (k: string) => {
      const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
      document.dispatchEvent(e)
      return e
   }

   it("W/↑ re-filter the list to the previous lane, S/↓ to the next", async () => {
      await boot()
      nav.getFilterEntries.mockReturnValue(["", "news", "7"])
      for (const [k, dir, token] of [
         ["w", -1, "news"],
         ["ArrowUp", -1, "news"],
         ["s", 1, "7"],
         ["ArrowDown", 1, "7"],
      ] as const) {
         nav.cycleToken.mockClear().mockResolvedValue(token)
         nav.applyFilter.mockClear()
         const e = key(k)
         await flush()
         expect(e.defaultPrevented).toBe(true)
         expect(nav.cycleToken).toHaveBeenCalledWith(dir)
         // The gesture/keyboard cycle rides selectFilter — the list re-filters in
         // place (no reader entry), same path as a picker row.
         expect(nav.applyFilter).toHaveBeenCalledWith([token])
         expect(document.body.classList.contains("srr-view-list")).toBe(true)
      }
   })

   it("only the latest rapid press applies its token; a superseded press's late resolution is dropped", async () => {
      // The round-1 fix used a held boolean that could LATCH cycling off if a
      // cycleToken never settled; round-2 replaced it with a freshness token. Drive
      // two overlapping presses whose cycleToken resolutions settle OUT OF ORDER.
      await boot()
      picker.isOpen.mockReturnValue(false)
      nav.getFilterEntries.mockReturnValue(["", "news", "7"])
      nav.applyFilter.mockClear()
      let resolveFirst!: (t: string) => void
      let resolveSecond!: (t: string) => void
      nav.cycleToken
         .mockClear()
         .mockImplementationOnce(() => new Promise<string>((r) => (resolveFirst = r)))
         .mockImplementationOnce(() => new Promise<string>((r) => (resolveSecond = r)))
      key("w") // press A → cycleToken call #1
      key("s") // press B (the latest) → call #2, bumps the freshness gen
      // The latest press resolves first and applies — a never-settling press A can't
      // latch cycling off (the round-1 bug).
      resolveSecond("latest")
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledTimes(1)
      expect(nav.applyFilter).toHaveBeenCalledWith(["latest"])
      // Press A resolves LATE with a stale token → discarded (its gen was superseded).
      resolveFirst("stale")
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledTimes(1)
      expect(nav.applyFilter).not.toHaveBeenCalledWith(["stale"])
   })

   it("a single-lane rotation leaves the vertical keys to native scrolling", async () => {
      await boot()
      nav.getFilterEntries.mockReturnValue([""])
      nav.cycleToken.mockClear()
      for (const k of ["w", "ArrowUp", "s", "ArrowDown"]) {
         const e = key(k)
         expect(e.defaultPrevented).toBe(false)
      }
      expect(nav.cycleToken).not.toHaveBeenCalled()
   })

   it("inert while the picker overlay is open", async () => {
      await boot()
      nav.getFilterEntries.mockReturnValue(["", "news"])
      picker.isOpen.mockReturnValue(true)
      nav.cycleToken.mockClear()
      nav.applyFilter.mockClear()
      key("w")
      key("ArrowDown")
      await flush()
      expect(nav.cycleToken).not.toHaveBeenCalled()
      expect(nav.applyFilter).not.toHaveBeenCalled()
   })
})

// The freshness / degradation status readout lives in the settings menu's
// footer now (picker.renderStatus, covered in picker.test.ts), so app.ts no
// longer owns a status banner — that describe was removed with the move.

// Helper: invoke the pin action from the settings menu's contextual pin row
// (simulates the "Download for offline" tap) and wait for the async pin to
// settle. Sets up a fake SW controller so pinCurrentFilter doesn't bail early.
async function invokePinAction(isUnreadOnly: boolean): Promise<void> {
   // In unread-only mode the filter must be active (a feed/tag scope, not [ALL])
   // so the snapshot note fires.
   nav.isUnreadOnly.mockReturnValue(isUnreadOnly)
   nav.filter = { feeds: new Map([[0, 0]]), saved: false, search: false, active: isUnreadOnly, tokens: [] }

   // Stub a SW controller so the pin row appears and pinCurrentFilter doesn't no-op.
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
   // Open the settings menu and find the contextual pin row among its items.
   document.querySelector<HTMLButtonElement>(".srr-feed")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
   const items = dropdown.showContextMenu.mock.calls.at(-1)?.[1] as { label: string; action: () => void }[]
   const entry = items.find((i) => i.label === "Download for offline")
   expect(entry).not.toBeUndefined()

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

// The SW-stub tests below (and the existing invokePinAction) leave
// navigator.serviceWorker defined as `undefined`, which keeps
// `"serviceWorker" in navigator` true and makes the next clean boot's
// SW-register block throw on `.getRegistrations()`. Remove the own property so a
// fresh boot sees the jsdom default (absent) — the state the app expects in dev.
function clearServiceWorker() {
   if (Object.prototype.hasOwnProperty.call(navigator, "serviceWorker"))
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker
}

describe("search-bar hints (syncSearchBar)", () => {
   beforeEach(clearServiceWorker)
   const note = () => document.querySelector(".srr-search-note") as HTMLElement

   it("shows the short-query hint", async () => {
      await boot()
      nav.isSearchFilter.mockReturnValue(true)
      nav.searchQuery.mockReturnValue("ab")
      nav.searchShort.mockReturnValue(true)
      hashTo("#!q:ab") // route into the list under a search filter
      await flush()
      expect(note().textContent).toContain("Short words search only recent articles")
      expect(note().hidden).toBe(false)
      // Reset the leaked return values (vi.clearAllMocks keeps them — see beforeEach).
      nav.isSearchFilter.mockReturnValue(false)
      nav.searchQuery.mockReturnValue("")
      nav.searchShort.mockReturnValue(false)
   })

   it("shows the truncated-results hint", async () => {
      await boot()
      nav.isSearchFilter.mockReturnValue(true)
      nav.searchQuery.mockReturnValue("climate")
      nav.searchShort.mockReturnValue(false) // not short → falls through to the truncation note
      nav.searchTruncated.mockReturnValue(true)
      hashTo("#!q:climate")
      await flush()
      expect(note().textContent).toContain("Showing the most recent matches")
      expect(note().hidden).toBe(false)
      nav.isSearchFilter.mockReturnValue(false)
      nav.searchQuery.mockReturnValue("")
      nav.searchTruncated.mockReturnValue(false)
   })
})

describe("search input keys — leaving / applying from the pinned bar", () => {
   beforeEach(clearServiceWorker)
   const input = () => document.querySelector(".srr-search-input") as HTMLInputElement

   it("search-input Escape exits and stops the Escape ladder", async () => {
      await boot() // list surface
      nav.applyFilter.mockClear()
      nav.last.mockClear()
      nav.goTo.mockClear()
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      await flush()
      // exitSearch ran (selectFilter("") → applyFilter([]))…
      expect(nav.applyFilter).toHaveBeenCalledWith([])
      // …and stopPropagation kept the document Escape ladder from also firing (it
      // would have entered the reader via enterReader → nav.last / nav.goTo).
      expect(nav.last).not.toHaveBeenCalled()
      expect(nav.goTo).not.toHaveBeenCalled()
      expect(document.body.classList.contains("srr-view-list")).toBe(true)
   })

   it("search-input Enter applies immediately", async () => {
      await boot()
      // applySearchQuery bails unless the list is in search mode.
      nav.isSearchFilter.mockReturnValue(true)
      input().value = "climate"
      nav.applyFilter.mockClear()
      // Enter applies straight through (no 200ms input debounce, which rides the
      // "input" event, not keydown).
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith(["q:climate"])
      nav.isSearchFilter.mockReturnValue(false)
   })

   it("the clear button exits search", async () => {
      await boot()
      nav.applyFilter.mockClear()
      document.querySelector(".srr-search-clear")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await flush()
      expect(nav.applyFilter).toHaveBeenCalledWith([])
   })
})

describe("reader keymap — the f key (open in a new tab)", () => {
   beforeEach(clearServiceWorker)
   it("the f key opens the current article link in a new tab", async () => {
      await boot()
      nav.fromHash.mockResolvedValue(
         showFeed({ article: { f: 1, a: 0, p: 0, t: "T", l: "http://example.com/a", c: "<p>x</p>" } }),
      )
      hashTo("#2") // into the reader, article carries a link
      await flush()
      const link = document.querySelector(".srr-title-row") as HTMLAnchorElement
      let modClick = false
      link.addEventListener("click", (e) => {
         const m = e as MouseEvent
         modClick = m.ctrlKey && m.metaKey
         e.preventDefault() // suppress jsdom navigation
      })
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }))
      expect(modClick).toBe(true) // a ctrl/meta click = open in a new tab

      // No-op when the article has no link (the linkless render removes the href).
      nav.fromHash.mockResolvedValue(showFeed({ article: { f: 1, a: 0, p: 0, t: "T", l: "", c: "<p>x</p>" } }))
      hashTo("#3")
      await flush()
      const link2 = document.querySelector(".srr-title-row") as HTMLAnchorElement
      expect(link2.getAttribute("href")).toBeNull()
      let fired = false
      link2.addEventListener("click", () => (fired = true))
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }))
      expect(fired).toBe(false)
   })
})

describe("offline pin — unpin subtraction & SW purge", () => {
   it("unpin posts only names not still needed by another pinned scope", async () => {
      // Two pinned scopes — the current [ALL] ("") and a feed ("7") — sharing the
      // latest packs. Unpinning [ALL] must keep the shared names (the feed still
      // needs them) and delete only [ALL]'s unique finalized pack.
      pinFilter("", ["idx/L1.gz", "data/L1.gz", "data/3.gz"])
      pinFilter("7", ["idx/L1.gz", "data/L1.gz", "data/9.gz"])
      const fakeSW = { postMessage: vi.fn() }
      Object.defineProperty(navigator, "serviceWorker", {
         value: { controller: fakeSW, getRegistrations: () => Promise.resolve([]), addEventListener: () => {} },
         configurable: true,
      })
      try {
         await boot()
         document
            .querySelector<HTMLButtonElement>(".srr-feed")!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }))
         const items = dropdown.showContextMenu.mock.calls.at(-1)?.[1] as { label: string; action: () => void }[]
         const remove = items.find((i) => i.label === "Remove offline copy")
         expect(remove).not.toBeUndefined()
         remove!.action()
         // Only the name unique to this scope is dropped; the shared latest packs stay.
         expect(fakeSW.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "unpin", names: ["data/3.gz"] }),
         )
      } finally {
         Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true })
      }
   })

   it("clears the local pin registry when the SW reports pins-purged", async () => {
      pinFilter("42", ["idx/L1.gz"])
      expect(listPins().size).toBe(1)
      let onMessage: ((e: MessageEvent) => void) | undefined
      Object.defineProperty(navigator, "serviceWorker", {
         value: {
            addEventListener: (type: string, h: (e: MessageEvent) => void) => {
               if (type === "message") onMessage = h
            },
            getRegistrations: () => Promise.resolve([]),
         },
         configurable: true,
      })
      try {
         await boot()
         expect(onMessage).toBeDefined() // app wired the SW message listener
         onMessage!(new MessageEvent("message", { data: { type: "pins-purged" } }))
         expect(listPins().size).toBe(0) // clearAllPins() emptied the registry
      } finally {
         Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true })
      }
   })
})

// The existing invokePinAction sends {done,total} with NO `cached`; here the SW
// reports `cached` so the record-vs-warn completion branch is pinned.
async function firePin(cached: number): Promise<void> {
   nav.isUnreadOnly.mockReturnValue(false)
   nav.filter = { feeds: new Map([[0, 0]]), saved: false, search: false, active: false, tokens: [] }
   const fakeSW = { postMessage: vi.fn() }
   Object.defineProperty(navigator, "serviceWorker", {
      value: { controller: fakeSW, getRegistrations: () => Promise.resolve([]), addEventListener: () => {} },
      configurable: true,
   })
   const realMC = globalThis.MessageChannel
   const fakePort1 = { onmessage: null as ((e: MessageEvent) => void) | null }
   vi.stubGlobal("MessageChannel", function () {
      return { port1: fakePort1, port2: {} }
   })
   await boot()
   document.querySelector<HTMLButtonElement>(".srr-feed")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
   const items = dropdown.showContextMenu.mock.calls.at(-1)?.[1] as { label: string; action: () => void }[]
   items.find((i) => i.label === "Download for offline")!.action()
   await flush()
   fakePort1.onmessage?.(new MessageEvent("message", { data: { type: "pin-progress", done: 2, total: 2, cached } }))
   await flush()
   vi.stubGlobal("MessageChannel", realMC)
   Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true })
}

describe("offline pin — record vs warn on completion", () => {
   const status = () => document.querySelector(".srr-pin-progress") as HTMLElement

   it("a pin that cached nothing warns and records no pin", async () => {
      await firePin(0)
      expect(status().textContent).toContain("Couldn't save offline copy")
      // cached === 0 → unpinFilter path, so nothing lands in the registry.
      expect(listPins().size).toBe(0)
   })

   it("a successful pin records the scope to the registry", async () => {
      await firePin(2)
      expect(status().textContent).toContain("Offline copy saved")
      expect(isPinned("")).toBe(true)
      expect(listPins().get("")?.names).toEqual(["idx/L1.gz", "data/L1.gz"])
   })
})
