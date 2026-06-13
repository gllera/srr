import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// dropdown.ts owns its DOM lookups at module load, so the skeleton must exist
// before import — hence vi.resetModules() + dynamic import per test run.
const data = vi.hoisted(() => {
   const mock = {
      db: { first_fetched: 0 } as IDB,
      groupChannelsByTag: vi.fn(() => ({ tagged: new Map(), sortedTags: [] as string[], untagged: [] as IChannel[] })),
      findChronForTimestamp: vi.fn(async () => 0),
      channelTitle: (chanId: number) => mock.db.channels?.[chanId]?.title ?? "[DELETED]",
   }
   return mock
})
vi.mock("./data", () => data)

const nav = vi.hoisted(() => ({
   getCurrentFilterKey: vi.fn(() => ""),
   fromHash: vi.fn(),
   last: vi.fn(),
   goTo: vi.fn(),
   switchFilter: vi.fn(),
   unreadCount: vi.fn<(ch: IChannel) => Promise<number>>(async () => -1),
   tagUnreadCount: vi.fn<(tag: string, group: IChannel[]) => Promise<number>>(async () => -1),
   peek: vi.fn<(span?: number) => Promise<IPeekItem[]>>(async () => []),
   filter: { active: false, matches: vi.fn(() => true) },
}))
vi.mock("./nav", () => nav)

const searchMod = vi.hoisted(() => ({
   available: vi.fn(() => true),
   shortQuery: vi.fn(() => false),
   search: vi.fn(),
}))
vi.mock("./search", () => searchMod)

import { getImgProxy, setImgProxy } from "./fmt"

type Dropdown = typeof import("./dropdown")

const SKELETON =
   '<div class="srr-dropdown">' +
   '<button class="srr-dropdown-btn srr-channel" aria-expanded="false"></button>' +
   '<div id="srr-channel-menu" class="srr-dropdown-menu" role="menu"></div>' +
   "</div>" +
   '<div class="srr-dropdown">' +
   '<button class="srr-dropdown-btn srr-counter" aria-expanded="false"></button>' +
   '<div id="srr-peek-menu" class="srr-dropdown-menu" role="menu"></div>' +
   "</div>" +
   '<div class="srr-dropdown">' +
   '<button class="srr-dropdown-btn srr-search" aria-expanded="false"></button>' +
   '<div id="srr-search-menu" class="srr-dropdown-menu" role="menu"></div>' +
   "</div>"

const $menu = () => document.getElementById("srr-channel-menu")!
const chan = (over: Partial<IChannel>): IChannel =>
   ({ id: 1, title: "Test", feeds: [{ url: "http://test.com" }], total_art: 1, ...over }) as IChannel
const $input = () => $menu().querySelector<HTMLInputElement>(".srr-imgproxy-input")
const $icon = () => $menu().querySelector<HTMLAnchorElement>('a[data-value="__imgproxy__"]')

function key(el: HTMLElement, k: string): void {
   el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))
}

describe("dropdown: image-proxy inline editor", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   // Opens the channel menu and expands the proxy editor.
   function openEditor(): void {
      dropdown.showChannelMenu("", guard)
      $icon()!.click()
   }

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   it("expands the editor seeded from the stored prefix on icon click", () => {
      setImgProxy("https://p.example/?url=")
      openEditor()
      const input = $input()
      expect(input).not.toBeNull()
      expect(input!.value).toBe("https://p.example/?url=")
      expect($icon()).toBeNull() // chip row swapped out while editing
   })

   it("commits a valid prefix on Enter, re-renders via guard, and collapses", () => {
      openEditor()
      const input = $input()!
      input.value = " https://new.example/?url= " // trimmed on commit
      key(input, "Enter")
      expect(getImgProxy()).toBe("https://new.example/?url=")
      expect(guard).toHaveBeenCalledTimes(1)
      expect($input()).toBeNull()
      expect($icon()).not.toBeNull()
   })

   it("cancels on Escape without persisting", () => {
      setImgProxy("https://old.example/?url=")
      openEditor()
      const input = $input()!
      input.value = "https://changed.example/?url="
      key(input, "Escape")
      expect(getImgProxy()).toBe("https://old.example/?url=")
      expect(guard).not.toHaveBeenCalled()
      expect($input()).toBeNull()
   })

   it("clear button stores the empty string (disables the proxy)", () => {
      setImgProxy("https://old.example/?url=")
      openEditor()
      $menu().querySelector<HTMLButtonElement>(".srr-imgproxy-clear")!.click()
      expect(getImgProxy()).toBe("")
      expect(guard).toHaveBeenCalledTimes(1)
      expect($input()).toBeNull()
   })

   it("rejects a schemeless prefix: flags the input, keeps editing, stores nothing", () => {
      openEditor()
      const input = $input()!
      input.value = "foo"
      key(input, "Enter")
      expect(input.classList.contains("srr-input-invalid")).toBe(true)
      expect($input()).not.toBeNull() // still editing
      expect(getImgProxy()).toBe("")
      expect(guard).not.toHaveBeenCalled()
   })

   it("committing the unchanged value collapses without a re-render", () => {
      setImgProxy("https://old.example/?url=")
      openEditor()
      key($input()!, "Enter")
      expect(guard).not.toHaveBeenCalled()
      expect($input()).toBeNull()
   })

   it("reopening the menu starts collapsed", () => {
      openEditor()
      dropdown.closeAllDropdowns()
      dropdown.showChannelMenu("", guard)
      expect($input()).toBeNull()
      expect($icon()).not.toBeNull()
   })
})

const $dateIcon = () => $menu().querySelector<HTMLAnchorElement>('a[data-value="__date__"]')
const $dateInput = () => $menu().querySelector<HTMLInputElement>(".srr-date-input")

describe("dropdown: date jump", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   // Opens the channel menu and expands the date editor.
   function openEditor(): void {
      dropdown.showChannelMenu("", guard)
      $dateIcon()!.click()
   }

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn()
      nav.goTo.mockClear()
      data.findChronForTimestamp.mockClear()
      data.db.first_fetched = 0
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   it("swaps the chip row for a date editor on icon click", () => {
      data.db.first_fetched = new Date(2020, 0, 15).getTime() / 1000
      openEditor()
      const input = $dateInput()!
      expect(input).not.toBeNull()
      expect($dateIcon()).toBeNull() // chip row swapped out while editing
      expect(input.min).toBe("2020-01-15") // archive start bounds the picker
      expect(input.max).not.toBe("") // today bounds the other end
   })

   it("jumps to local midnight of the picked date and closes the menu", async () => {
      data.findChronForTimestamp.mockResolvedValueOnce(42)
      openEditor()
      const input = $dateInput()!
      input.value = "2024-06-12"
      input.dispatchEvent(new Event("change"))
      expect(guard).toHaveBeenCalledTimes(1)
      expect($menu().classList.contains("srr-open")).toBe(false)
      await (guard.mock.calls[0][0] as () => Promise<unknown>)()
      expect(data.findChronForTimestamp).toHaveBeenCalledWith(new Date(2024, 5, 12).getTime() / 1000)
      expect(nav.goTo).toHaveBeenCalledWith(42)
   })

   it("navigates once when Enter re-fires change on a committed value", () => {
      openEditor()
      const input = $dateInput()!
      input.value = "2024-06-12"
      input.dispatchEvent(new Event("change"))
      key(input, "Enter")
      expect(guard).toHaveBeenCalledTimes(1)
   })

   it("Enter with an empty value flags the input and stays editing", () => {
      openEditor()
      const input = $dateInput()!
      key(input, "Enter")
      expect(input.classList.contains("srr-input-invalid")).toBe(true)
      expect($dateInput()).not.toBeNull() // still editing
      expect(guard).not.toHaveBeenCalled()
   })

   it("Escape cancels back to the chip row without navigating", () => {
      openEditor()
      key($dateInput()!, "Escape")
      expect($dateInput()).toBeNull()
      expect($dateIcon()).not.toBeNull()
      expect(guard).not.toHaveBeenCalled()
   })
})

describe("dropdown: feed-error badges", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   it("marks broken channels and their tag header with a dot carrying the error", () => {
      const broken = chan({ id: 3, title: "Dead", feeds: [{ url: "u", ferr: "404 not found" }] })
      const healthy = chan({ id: 4, title: "Live" })
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [broken]]]),
         sortedTags: ["news"],
         untagged: [healthy],
      })
      dropdown.showChannelMenu("", guard)

      const deadRow = $menu().querySelector('a[data-value="3"]')!
      expect(deadRow.querySelector(".srr-err-dot")).not.toBeNull()
      expect(deadRow.getAttribute("title")).toBe("404 not found")
      expect(deadRow.getAttribute("aria-label")).toContain("feed error")
      expect($menu().querySelector('a[data-value="4"] .srr-err-dot')).toBeNull()
      // The collapsed tag group reveals the trouble inside it.
      expect($menu().querySelector('a[data-value="news"] .srr-err-dot')).not.toBeNull()
   })

   it("renders clean rows for healthy and null-feeds channels", () => {
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [chan({ id: 5, title: "NullFeeds", feeds: null })],
      })
      dropdown.showChannelMenu("", guard)
      expect($menu().querySelector(".srr-err-dot")).toBeNull()
   })
})

describe("dropdown: unread badges", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   const $badge = (value: string) => $menu().querySelector(`a[data-value="${value}"] .srr-unread`)

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn()
      nav.unreadCount.mockClear()
      nav.tagUnreadCount.mockClear()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   afterEach(() => {
      nav.unreadCount.mockImplementation(async () => -1)
      nav.tagUnreadCount.mockImplementation(async () => -1)
   })

   it("badges channels async and shows the tag's own unread on the header, hiding unknown and zero", async () => {
      const a = chan({ id: 3, title: "A" })
      const b = chan({ id: 4, title: "B" })
      const c = chan({ id: 5, title: "C" })
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [a, b]]]),
         sortedTags: ["news"],
         untagged: [c],
      })
      nav.unreadCount.mockImplementation(async (ch) => (ch.id === 3 ? 5 : ch.id === 4 ? -1 : 0))
      // The header badge is nav.tagUnreadCount (right of the tag's furthest-read
      // channel), not the arithmetic sum of the child rows.
      nav.tagUnreadCount.mockImplementation(async (tag) => (tag === "news" ? 7 : -1))
      dropdown.showChannelMenu("", guard)
      await vi.waitFor(() => expect($badge("3")).not.toBeNull())
      expect($badge("3")!.textContent).toBe("5")
      expect($badge("4")).toBeNull() // never seen → unknown, no badge
      expect($badge("5")).toBeNull() // fully read → no badge
      const headerBadge = $badge("news")!
      expect(headerBadge.textContent).toBe("7") // the tag's own count, not 5 + (−1)
      expect(nav.tagUnreadCount).toHaveBeenCalledWith("news", [a, b])
      // sits before the collapse toggle, not after the chevron
      expect(headerBadge.nextElementSibling?.className).toBe("srr-tag-toggle")
   })

   it("hides the tag header badge when the tag is unknown (-1)", async () => {
      const a = chan({ id: 3, title: "A" })
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [a]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      nav.unreadCount.mockImplementation(async () => -1)
      nav.tagUnreadCount.mockImplementation(async () => -1)
      dropdown.showChannelMenu("", guard)
      await new Promise((r) => setTimeout(r))
      expect($badge("news")).toBeNull()
   })

   it("caps the displayed count at 999+", async () => {
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [chan({ id: 6, title: "Busy" })],
      })
      nav.unreadCount.mockImplementation(async () => 1500)
      dropdown.showChannelMenu("", guard)
      await vi.waitFor(() => expect($badge("6")).not.toBeNull())
      expect($badge("6")!.textContent).toBe("999+")
   })

   it("a fill that resolves after the menu closed never touches the DOM", async () => {
      let release!: (n: number) => void
      nav.unreadCount.mockImplementation(() => new Promise<number>((r) => (release = r)))
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [chan({ id: 7, title: "Slow" })],
      })
      dropdown.showChannelMenu("", guard)
      dropdown.closeAllDropdowns()
      release(9)
      await new Promise((r) => setTimeout(r))
      expect($menu().querySelector(".srr-unread")).toBeNull()
   })
})

describe("dropdown: menu keyboard navigation", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   const items = () => Array.from($menu().querySelectorAll<HTMLElement>('[role="menuitem"]'))

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   afterEach(() => {
      // neutralize this instance's document-level handler for later describes
      dropdown.closeAllDropdowns()
   })

   it("ArrowDown/ArrowUp rove focus through the open menu, wrapping at the ends", () => {
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [chan({ id: 3, title: "A" }), chan({ id: 4, title: "B" })],
      })
      dropdown.showChannelMenu("", guard)
      const list = items()
      key(document.body, "ArrowDown")
      expect(document.activeElement).toBe(list[0])
      key(list[0], "ArrowDown")
      expect(document.activeElement).toBe(list[1])
      key(list[1], "ArrowUp")
      expect(document.activeElement).toBe(list[0])
      key(list[0], "ArrowUp") // wraps
      expect(document.activeElement).toBe(list[list.length - 1])
      key(list[list.length - 1], "ArrowDown") // wraps back
      expect(document.activeElement).toBe(list[0])
   })

   it("Home/End jump to the first/last item; ArrowUp with no focus starts at the end", () => {
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [chan({ id: 3, title: "A" })],
      })
      dropdown.showChannelMenu("", guard)
      const list = items()
      key(document.body, "ArrowUp")
      expect(document.activeElement).toBe(list[list.length - 1])
      key(document.body, "Home")
      expect(document.activeElement).toBe(list[0])
      key(document.body, "End")
      expect(document.activeElement).toBe(list[list.length - 1])
   })

   it("skips channel rows hidden inside a collapsed tag group", () => {
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [chan({ id: 3, title: "Hidden" })]]]),
         sortedTags: ["news"],
         untagged: [chan({ id: 4, title: "Visible" })],
      })
      dropdown.showChannelMenu("", guard) // currentTag "" → news starts collapsed
      key(document.body, "End")
      expect((document.activeElement as HTMLElement).dataset.value).toBe("4")
      key(document.activeElement as HTMLElement, "ArrowUp")
      expect((document.activeElement as HTMLElement).dataset.value).toBe("news")
   })

   it("Space activates the focused item and the keys never leak to other handlers", () => {
      dropdown.showChannelMenu("", guard)
      const leak = vi.fn()
      document.addEventListener("keydown", leak) // bubble phase, like app.ts shortcuts
      try {
         key(document.body, "ArrowDown")
         const all = $menu().querySelector<HTMLAnchorElement>('a[data-value=""]')!
         all.focus()
         key(all, " ")
         expect(guard).toHaveBeenCalledTimes(1) // [ALL] row activated → switchFilter route
         expect(leak).not.toHaveBeenCalled()
      } finally {
         document.removeEventListener("keydown", leak)
      }
   })

   it("closing hands focus back to the menu's button", () => {
      dropdown.showChannelMenu("", guard)
      key(document.body, "ArrowDown")
      expect($menu().contains(document.activeElement)).toBe(true)
      dropdown.closeAllDropdowns()
      expect(document.activeElement).toBe(document.querySelector(".srr-channel"))
   })
})

describe("dropdown: headlines peek", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   const $peek = () => document.getElementById("srr-peek-menu")!
   const $rows = () => Array.from($peek().querySelectorAll<HTMLAnchorElement>("a[data-value]"))
   const item = (chron: number, over: Partial<IPeekItem> = {}): IPeekItem => ({
      chron,
      title: `T${chron}`,
      when: 0,
      s: 1,
      current: false,
      ...over,
   })

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn()
      data.db.channels = { 1: chan({ id: 1, title: "Chan" }) } as unknown as IDB["channels"]
      nav.peek.mockClear()
      nav.goTo.mockClear()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   afterEach(() => {
      dropdown.closeAllDropdowns()
      nav.peek.mockImplementation(async () => [])
   })

   it("renders rows newest-first with the current row marked", async () => {
      nav.peek.mockResolvedValueOnce([item(1), item(2, { current: true }), item(3)])
      dropdown.showPeekMenu(guard)
      expect($peek().classList.contains("srr-open")).toBe(true)
      await vi.waitFor(() => expect($rows().length).toBe(3))
      expect($rows().map((r) => r.dataset.value)).toEqual(["3", "2", "1"])
      expect($rows()[1].classList.contains("srr-active")).toBe(true)
      expect($rows()[1].getAttribute("aria-current")).toBe("true")
      expect($rows()[0].querySelector(".srr-peek-title")!.textContent).toBe("T3")
      expect($rows()[0].querySelector(".srr-peek-meta")!.textContent).toContain("Chan")
   })

   it("clicking a row jumps to its chronIdx via the guard", async () => {
      nav.peek.mockResolvedValueOnce([item(7), item(8, { current: true })])
      dropdown.showPeekMenu(guard)
      await vi.waitFor(() => expect($rows().length).toBe(2))
      $peek().querySelector<HTMLAnchorElement>('a[data-value="7"]')!.click()
      expect(guard).toHaveBeenCalledTimes(1)
      await (guard.mock.calls[0][0] as () => Promise<unknown>)()
      expect(nav.goTo).toHaveBeenCalledWith(7)
   })

   it("only one dropdown opens at a time, and reinvoking toggles closed", () => {
      dropdown.showChannelMenu("", guard)
      expect($menu().classList.contains("srr-open")).toBe(true)
      dropdown.showPeekMenu(guard)
      expect($menu().classList.contains("srr-open")).toBe(false)
      expect($peek().classList.contains("srr-open")).toBe(true)
      dropdown.showPeekMenu(guard)
      expect($peek().classList.contains("srr-open")).toBe(false)
   })

   it("a fill that resolves after the menu closed never touches the DOM", async () => {
      let release!: (items: IPeekItem[]) => void
      nav.peek.mockImplementationOnce(() => new Promise<IPeekItem[]>((r) => (release = r)))
      dropdown.showPeekMenu(guard)
      dropdown.closeAllDropdowns()
      release([item(1)])
      await new Promise((r) => setTimeout(r))
      expect($rows().length).toBe(0) // still just the loading placeholder
   })
})

describe("dropdown: title search", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   const $smenu = () => document.getElementById("srr-search-menu")!
   const $input = () => $smenu().querySelector<HTMLInputElement>(".srr-search-input")
   const $rows = () => Array.from($smenu().querySelectorAll<HTMLAnchorElement>("a[data-value]"))
   const $note = () => $smenu().querySelector(".srr-search-note")

   const hit = (chron: number, t: string, s = 1) => ({ chron, s, w: 1000, t })
   async function* gen(batches: ReturnType<typeof hit>[][]) {
      for (const b of batches) yield b
   }

   function type(q: string): void {
      const input = $input()!
      input.value = q
      key(input, "Enter") // immediate path — the debounce test covers the timer
   }

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn((fn: () => Promise<unknown>) => fn())
      data.db.channels = { 1: chan({ id: 1, title: "Chan" }) } as unknown as IDB["channels"]
      searchMod.available.mockReturnValue(true)
      searchMod.search.mockReset()
      nav.goTo.mockClear()
      nav.filter.active = false
      nav.filter.matches.mockImplementation(() => true)
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   afterEach(() => {
      dropdown.closeAllDropdowns()
      vi.useRealTimers()
   })

   it("shows the unavailable note instead of an input when the index isn't published", () => {
      searchMod.available.mockReturnValue(false)
      dropdown.showSearchMenu(guard)
      expect($input()).toBeNull()
      expect($note()!.textContent).toContain("not published")
   })

   it("runs the query on Enter, streams rows newest-first, and navigates on click", async () => {
      searchMod.search.mockImplementation(() => gen([[hit(100010, "Alpha latest")], [hit(7, "Alpha old")]]))
      dropdown.showSearchMenu(guard)
      type("alpha")
      await vi.waitFor(() => expect($rows().length).toBe(2))
      expect(searchMod.search).toHaveBeenCalledWith("alpha", 100, expect.any(Function))
      expect($rows().map((r) => r.dataset.value)).toEqual(["100010", "7"])
      expect($rows()[0].querySelector(".srr-peek-title")!.textContent).toBe("Alpha latest")
      expect($rows()[0].querySelector(".srr-peek-meta")!.textContent).toContain("Chan")
      expect($note()).toBeNull() // the status row is removed once done
      $smenu().querySelector<HTMLAnchorElement>('a[data-value="7"]')!.click()
      expect(nav.goTo).toHaveBeenCalledWith(7)
   })

   it("debounces the input event", () => {
      vi.useFakeTimers()
      searchMod.search.mockImplementation(() => gen([]))
      dropdown.showSearchMenu(guard)
      const input = $input()!
      input.value = "alp"
      input.dispatchEvent(new Event("input", { bubbles: true }))
      expect(searchMod.search).not.toHaveBeenCalled()
      vi.advanceTimersByTime(200)
      expect(searchMod.search).toHaveBeenCalledWith("alp", 100, expect.any(Function))
   })

   it("hands the active channel filter to search as the accept predicate", async () => {
      nav.filter.active = true
      nav.filter.matches.mockImplementation((s: number) => s === 1)
      // The mock applies accept like the real search() does, so this pins
      // both that the predicate is passed and that it implements the filter.
      searchMod.search.mockImplementation((_q: string, _limit: number, accept: (s: number, chron: number) => boolean) =>
         gen([[hit(10, "Keep", 1), hit(9, "Drop", 2)].filter((h) => accept(h.s, h.chron))]),
      )
      dropdown.showSearchMenu(guard)
      type("x")
      await vi.waitFor(() => expect($rows().length).toBe(1))
      expect($rows()[0].dataset.value).toBe("10")
   })

   it("reports no matches", async () => {
      searchMod.search.mockImplementation(() => gen([]))
      dropdown.showSearchMenu(guard)
      type("nothing")
      await vi.waitFor(() => expect($note()!.textContent).toBe("No matches"))
   })
})
