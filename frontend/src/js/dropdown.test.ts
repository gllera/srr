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
   unreadCounts: vi.fn<(chs: IChannel[]) => Promise<Map<number, number>>>(async () => new Map()),
   // Synchronous plain sum of the already-computed counts map (mirrors the real
   // impl): a never-seen channel arrives as its full backlog, a positive number;
   // Math.max guards any stray negative / missing member down to 0. Tests that
   // pin the badge value override this implementation.
   tagUnreadFromCounts: vi.fn<(group: IChannel[], counts: Map<number, number>) => number>((group, counts) =>
      group.reduce((sum, ch) => sum + Math.max(0, counts.get(ch.id) ?? 0), 0),
   ),
   isUnreadOnly: vi.fn(() => false),
   setUnreadOnly: vi.fn<(on: boolean) => void>(),
   savedCount: vi.fn(() => 0),
   SAVED_TOKEN: "~saved",
   filter: { active: false, saved: false, matches: vi.fn(() => true) },
}))
vi.mock("./nav", () => nav)

import { getImgProxy, setImgProxy } from "./fmt"

type Dropdown = typeof import("./dropdown")

const dd = (btn: string, menuId: string) =>
   `<div class="srr-dropdown"><button class="srr-dropdown-btn ${btn}" aria-expanded="false"></button>` +
   `<div id="${menuId}" class="srr-dropdown-menu" role="menu"></div></div>`
// The whole toolbar's dropdowns: dropdown.ts binds its DOM lookups at module
// load, so every menu/button it touches must exist before import.
const SKELETON = dd("srr-channel", "srr-channel-menu") + dd("srr-imgproxy", "srr-imgproxy-menu")

const $menu = () => document.getElementById("srr-channel-menu")!
const chan = (over: Partial<IChannel>): IChannel =>
   ({ id: 1, title: "Test", feeds: [{ url: "http://test.com" }], total_art: 1, ...over }) as IChannel

function key(el: HTMLElement, k: string): void {
   el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))
}

describe("dropdown: image-proxy menu", () => {
   let dropdown: Dropdown
   const $imenu = () => document.getElementById("srr-imgproxy-menu")!
   const $input = () => $imenu().querySelector<HTMLInputElement>(".srr-imgproxy-input")

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   it("opens with the editor seeded from the stored prefix", () => {
      setImgProxy("https://p.example/?url=")
      dropdown.showImgProxyMenu()
      const input = $input()
      expect(input).not.toBeNull()
      expect(input!.value).toBe("https://p.example/?url=")
   })

   it("commits a valid prefix on Enter and closes the menu", () => {
      dropdown.showImgProxyMenu()
      const input = $input()!
      input.value = " https://new.example/?url= " // trimmed on commit
      key(input, "Enter")
      expect(getImgProxy()).toBe("https://new.example/?url=")
      expect($imenu().classList.contains("srr-open")).toBe(false)
   })

   it("cancels on Escape without persisting", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyMenu()
      const input = $input()!
      input.value = "https://changed.example/?url="
      key(input, "Escape")
      expect(getImgProxy()).toBe("https://old.example/?url=")
      expect($imenu().classList.contains("srr-open")).toBe(false)
   })

   it("clear button stores the empty string (disables the proxy) and closes", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyMenu()
      $imenu().querySelector<HTMLButtonElement>(".srr-imgproxy-clear")!.click()
      expect(getImgProxy()).toBe("")
      expect($imenu().classList.contains("srr-open")).toBe(false)
   })

   it("rejects a schemeless prefix: flags the input, keeps the menu open, stores nothing", () => {
      dropdown.showImgProxyMenu()
      const input = $input()!
      input.value = "foo"
      key(input, "Enter")
      expect(input.classList.contains("srr-input-invalid")).toBe(true)
      expect($input()).not.toBeNull() // still editing
      expect($imenu().classList.contains("srr-open")).toBe(true)
      expect(getImgProxy()).toBe("")
   })

   it("committing the unchanged value just closes the menu", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyMenu()
      key($input()!, "Enter")
      expect(getImgProxy()).toBe("https://old.example/?url=")
      expect($imenu().classList.contains("srr-open")).toBe(false)
   })

   // closeAllDropdowns hands focus from a menu-internal element back to the
   // menu's toolbar button, so an Enter commit lands on the 🖼 button, not <body>.
   it("hands focus back to the toolbar button on commit (not <body>)", () => {
      dropdown.showImgProxyMenu()
      const input = $input()!
      input.value = "https://new.example/?url="
      input.focus()
      key(input, "Enter")
      expect($imenu().classList.contains("srr-open")).toBe(false)
      expect(document.activeElement).toBe(document.querySelector(".srr-imgproxy"))
      expect(document.activeElement).not.toBe(document.body)
   })
})

describe("jump: native date picker", () => {
   let dropdown: Dropdown
   let input: HTMLInputElement

   // Assign showPicker as an own property so it shadows whatever jsdom's
   // prototype provides (which throws "not implemented"); returns the spy.
   const stubPicker = (impl: () => void = () => {}): ReturnType<typeof vi.fn> => {
      const spy = vi.fn(impl)
      ;(input as unknown as { showPicker: () => void }).showPicker = spy
      return spy
   }

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      data.db.first_fetched = 0
      vi.resetModules()
      dropdown = await import("./dropdown")
      input = document.createElement("input")
      input.type = "date"
      document.body.appendChild(input)
   })

   it("clamps the calendar to [first_fetched, today] and pops the native picker", () => {
      data.db.first_fetched = new Date(2020, 0, 15).getTime() / 1000
      const picker = stubPicker()
      dropdown.openDatePicker(input)
      expect(input.min).toBe("2020-01-15") // archive start bounds the picker
      expect(input.max).not.toBe("") // today bounds the other end
      expect(input.value).toBe("") // empty so re-picking the same day re-jumps
      expect(picker).toHaveBeenCalledTimes(1)
   })

   it("leaves min unset when the store has no first_fetched", () => {
      data.db.first_fetched = 0
      stubPicker()
      dropdown.openDatePicker(input)
      expect(input.min).toBe("")
   })

   it("falls back to focus() when showPicker is unavailable", () => {
      stubPicker(() => {
         throw new Error("not supported")
      })
      const focus = vi.spyOn(input, "focus")
      dropdown.openDatePicker(input)
      expect(focus).toHaveBeenCalledTimes(1)
   })

   it("hands local midnight of the picked date to onPick (does not open the reader)", () => {
      const onPick = vi.fn()
      input.value = "2024-06-12"
      dropdown.dateJump(input, onPick)
      expect(onPick).toHaveBeenCalledWith(new Date(2024, 5, 12).getTime() / 1000)
   })

   it("does nothing when no date is set (cancelled picker)", () => {
      const onPick = vi.fn()
      input.value = ""
      dropdown.dateJump(input, onPick)
      expect(onPick).not.toHaveBeenCalled()
   })
})

// The image-proxy editor lives inside a dropdown menu, so a real bubbling click
// reaches app.ts's window-level "any click closes dropdowns" handler. This guards
// the regression where that handler shut the menu the instant the editor opened
// (the .click() tests above never see it).
describe("dropdown: inline editors survive the window close handler", () => {
   let dropdown: Dropdown
   let closeHandler: (e: Event) => void

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      data.db.first_fetched = 0
      vi.resetModules()
      dropdown = await import("./dropdown")
      // Mirror app.ts's window close handler exactly (closest, not matches: a
      // tap can land on a button's inner icon span).
      closeHandler = (e) => {
         if (!(e.target as HTMLElement).closest(".srr-dropdown-btn")) dropdown.closeAllDropdowns()
      }
      window.addEventListener("click", closeHandler)
   })
   afterEach(() => window.removeEventListener("click", closeHandler))

   it("clicking inside the image-proxy editor keeps its menu open", () => {
      dropdown.showImgProxyMenu()
      const input = document.querySelector<HTMLInputElement>("#srr-imgproxy-menu .srr-imgproxy-input")!
      input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      expect(document.getElementById("srr-imgproxy-menu")!.classList.contains("srr-open")).toBe(true)
      expect(input.isConnected).toBe(true)
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

describe("dropdown: saved row", () => {
   let dropdown: Dropdown

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      nav.savedCount.mockReturnValue(0)
      vi.resetModules()
      dropdown = await import("./dropdown")
   })
   afterEach(() => nav.savedCount.mockReturnValue(0))

   it("hides the ★ Saved row when nothing is saved", () => {
      data.groupChannelsByTag.mockReturnValueOnce({ tagged: new Map(), sortedTags: [], untagged: [chan({ id: 1 })] })
      dropdown.showChannelMenu("", vi.fn())
      expect($menu().querySelector('a[data-value="~saved"]')).toBeNull()
   })

   it("shows ★ Saved with a count once there are saved articles", () => {
      nav.savedCount.mockReturnValue(7)
      data.groupChannelsByTag.mockReturnValueOnce({ tagged: new Map(), sortedTags: [], untagged: [chan({ id: 1 })] })
      dropdown.showChannelMenu("", vi.fn())
      const row = $menu().querySelector('a[data-value="~saved"]')!
      expect(row).not.toBeNull()
      expect(row.textContent).toContain("Saved")
      expect(row.querySelector(".srr-saved-num")!.textContent).toBe("7")
   })

   it("on the list, selecting ★ Saved routes to host.selectFilter", () => {
      nav.savedCount.mockReturnValue(2)
      data.groupChannelsByTag.mockReturnValueOnce({ tagged: new Map(), sortedTags: [], untagged: [] })
      const selectFilter = vi.fn()
      dropdown.showChannelMenu("", vi.fn(), { viewIsList: () => true, selectFilter })
      $menu().querySelector<HTMLElement>('a[data-value="~saved"]')!.click()
      expect(selectFilter).toHaveBeenCalledWith("~saved")
   })
})

describe("dropdown: unread badges", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   const $badge = (value: string) => $menu().querySelector(`a[data-value="${value}"] .srr-unread`)
   // Drive the batched nav.unreadCounts from a per-channel count function.
   const counts = (by: (id: number) => number) =>
      nav.unreadCounts.mockImplementation(async (chs) => new Map(chs.map((ch) => [ch.id, by(ch.id)])))

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn()
      nav.unreadCounts.mockClear()
      nav.tagUnreadFromCounts.mockClear()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   afterEach(() => {
      nav.unreadCounts.mockImplementation(async () => new Map())
      nav.tagUnreadFromCounts.mockImplementation((group, counts) =>
         group.reduce((sum, ch) => sum + Math.max(0, counts.get(ch.id) ?? 0), 0),
      )
      nav.isUnreadOnly.mockReturnValue(false)
   })

   it("badges rows from unreadCounts and the tag header from tagUnreadFromCounts, hiding only zero", async () => {
      const a = chan({ id: 3, title: "A" })
      const b = chan({ id: 4, title: "B" })
      const c = chan({ id: 5, title: "C" })
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [a, b]]]),
         sortedTags: ["news"],
         untagged: [c],
      })
      counts((id) => (id === 3 ? 5 : id === 4 ? 8 : 0)) // 4 never-seen → its full backlog
      // The header badge is nav.tagUnreadFromCounts, derived synchronously from
      // the same counts map — not a second await pass. Pinned here to prove the
      // header uses that function's value, not an arithmetic sum of the rows.
      nav.tagUnreadFromCounts.mockReturnValue(7)
      dropdown.showChannelMenu("", guard)
      await vi.waitFor(() => expect($badge("3")).not.toBeNull())
      expect($badge("3")!.textContent).toBe("5")
      expect($badge("4")!.textContent).toBe("8") // never seen → full backlog badged
      expect($badge("5")).toBeNull() // fully read → no badge
      const headerBadge = $badge("news")!
      expect(headerBadge.textContent).toBe("7") // the tag's own count, not 5 + 8
      // Derived from the group + the same counts map already in hand — no
      // re-scan of the idx packs.
      const counts34 = nav.unreadCounts.mock.results[0].value
      expect(nav.tagUnreadFromCounts).toHaveBeenCalledWith([a, b], await counts34)
      // sits before the collapse toggle, not after the chevron
      expect(headerBadge.nextElementSibling?.className).toBe("srr-tag-toggle")
   })

   it("hides the tag header badge when tagUnreadFromCounts is zero", async () => {
      const a = chan({ id: 3, title: "A" })
      const b = chan({ id: 4, title: "B" })
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [a, b]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      counts(() => 0)
      nav.tagUnreadFromCounts.mockReturnValue(0) // nothing unseen
      dropdown.showChannelMenu("", guard)
      await new Promise((r) => setTimeout(r))
      expect($badge("news")).toBeNull()
   })

   it("hides fully-read rows and tags when unseen-only is on, keeping unread and never-seen", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      const a = chan({ id: 3, title: "A" }) // unread > 0 → shown
      const b = chan({ id: 4, title: "B" }) // never seen → full backlog → shown
      const old = chan({ id: 7, title: "Old" }) // fully read → tag hidden
      const c = chan({ id: 5, title: "C" }) // untagged, read → hidden
      const d = chan({ id: 6, title: "D" }) // untagged, unread → shown
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map([
            ["archive", [old]],
            ["news", [a, b]],
         ]),
         sortedTags: ["archive", "news"],
         untagged: [c, d],
      })
      counts((id) => (id === 3 ? 4 : id === 4 ? 9 : id === 6 ? 2 : 0)) // 4 never-seen → full backlog
      dropdown.showChannelMenu("", guard)
      await vi.waitFor(() => expect($badge("3")).not.toBeNull())
      const row = (v: string) => $menu().querySelector(`a[data-value="${v}"]`)!
      const groupHidden = (v: string) => row(v).closest(".srr-tag-group")!.classList.contains("srr-hidden")
      const hidden = (v: string) => row(v).classList.contains("srr-hidden")
      expect(hidden("3")).toBe(false) // unread
      expect(hidden("4")).toBe(false) // never seen → full backlog, has unseen content
      expect(hidden("5")).toBe(true) // fully read untagged
      expect(hidden("6")).toBe(false) // unread untagged
      expect(groupHidden("3")).toBe(false) // news has unread + never-seen
      expect(groupHidden("7")).toBe(true) // archive: only member fully read
   })

   // R3-4: with unseen-only on, the CURRENTLY-APPLIED tag/channel must never
   // self-hide even when read down to 0 unseen this session — else it loses its
   // .srr-active styling and becomes keyboard-unreachable while you're on it.
   // The toolbar counter uses a frozen snapshot, so it stays visible regardless.
   it("does not hide the active tag's group when fully read, but hides a different fully-read tag", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      nav.getCurrentFilterKey.mockReturnValue("news") // the active filter is the news tag
      try {
         const a = chan({ id: 3, title: "A" }) // active tag member, fully read
         const b = chan({ id: 4, title: "B" }) // active tag member, fully read
         const old = chan({ id: 7, title: "Old" }) // inactive tag, fully read → hidden
         data.groupChannelsByTag.mockReturnValueOnce({
            tagged: new Map([
               ["archive", [old]],
               ["news", [a, b]],
            ]),
            sortedTags: ["archive", "news"],
            untagged: [],
         })
         counts(() => 0) // every channel fully read
         dropdown.showChannelMenu("news", guard)
         await new Promise((r) => setTimeout(r))
         const row = (v: string) => $menu().querySelector(`a[data-value="${v}"]`)!
         const groupHidden = (v: string) => row(v).closest(".srr-tag-group")!.classList.contains("srr-hidden")
         expect(groupHidden("3")).toBe(false) // active tag stays put despite all-read
         expect(groupHidden("7")).toBe(true) // a different fully-read tag is hidden
      } finally {
         nav.getCurrentFilterKey.mockReturnValue("")
      }
   })

   // R3-4: the active CHANNEL row is exempt from hiding the same way.
   it("does not hide the active channel row when fully read", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      nav.getCurrentFilterKey.mockReturnValue("5") // the active filter is channel id 5
      try {
         data.groupChannelsByTag.mockReturnValueOnce({
            tagged: new Map(),
            sortedTags: [],
            untagged: [chan({ id: 5, title: "Active" }), chan({ id: 6, title: "Other" })],
         })
         counts(() => 0) // both fully read
         dropdown.showChannelMenu("", guard)
         await new Promise((r) => setTimeout(r))
         const hidden = (v: string) => $menu().querySelector(`a[data-value="${v}"]`)!.classList.contains("srr-hidden")
         expect(hidden("5")).toBe(false) // active channel stays put
         expect(hidden("6")).toBe(true) // an inactive fully-read channel is hidden
      } finally {
         nav.getCurrentFilterKey.mockReturnValue("")
      }
   })

   it("hides nothing when unseen-only is off", async () => {
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [chan({ id: 5, title: "Read" })],
      })
      counts(() => 0) // fully read
      dropdown.showChannelMenu("", guard)
      await new Promise((r) => setTimeout(r))
      expect($menu().querySelector('a[data-value="5"]')!.classList.contains("srr-hidden")).toBe(false)
   })

   it("caps the displayed count at 999+", async () => {
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [chan({ id: 6, title: "Busy" })],
      })
      counts(() => 1500)
      dropdown.showChannelMenu("", guard)
      await vi.waitFor(() => expect($badge("6")).not.toBeNull())
      expect($badge("6")!.textContent).toBe("999+")
   })

   it("a fill that resolves after the menu closed never touches the DOM", async () => {
      let release!: (m: Map<number, number>) => void
      nav.unreadCounts.mockImplementation(() => new Promise<Map<number, number>>((r) => (release = r)))
      data.groupChannelsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [chan({ id: 7, title: "Slow" })],
      })
      dropdown.showChannelMenu("", guard)
      dropdown.closeAllDropdowns()
      release(new Map([[7, 9]]))
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

// Title search no longer lives in a dropdown — it's a list filter mode
// (nav "q:<query>") driven by the pinned search bar in app.ts. The search SET
// behavior is covered in nav.test.ts (search filter mode) and the search index
// itself in search.test.ts / the contract suite.
