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
   peek: vi.fn<(span?: number) => Promise<IPeekItem[]>>(async () => []),
   savedCount: vi.fn(() => 0),
   SAVED_TOKEN: "~saved",
   filter: { active: false, saved: false, matches: vi.fn(() => true) },
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

   // R3-3: an Enter commit keeps the menu open, so rebuild() detaches the
   // focused control and the gated render() won't refocus the title — focus
   // would fall to <body>. The keyboard path must hand focus to the rebuilt
   // chip (mirrors the eye-toggle), not strand it.
   it("refocuses the img-proxy chip after an Enter commit (not <body>)", () => {
      openEditor()
      const input = $input()!
      input.value = "https://new.example/?url="
      key(input, "Enter")
      expect($icon()).not.toBeNull() // chip row rebuilt, menu still open
      expect(document.activeElement).toBe($icon())
      expect(document.activeElement).not.toBe(document.body)
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

// The inline-editor icons live in the channel menu, so a real bubbling click on
// them reaches app.ts's window-level "any click closes dropdowns" handler. These
// guard the regression where that handler shut the menu the instant the editor
// opened (the per-icon .click() tests above never see the window handler).
describe("dropdown: inline editors survive the window close handler", () => {
   let dropdown: Dropdown
   let closeHandler: (e: Event) => void

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      data.db.first_fetched = 0
      vi.resetModules()
      dropdown = await import("./dropdown")
      // Mirror app.ts:180-182 exactly.
      closeHandler = (e) => {
         if (!(e.target as HTMLElement).matches(".srr-dropdown-btn")) dropdown.closeAllDropdowns()
      }
      window.addEventListener("click", closeHandler)
   })
   afterEach(() => window.removeEventListener("click", closeHandler))

   // The svg inside the chip is the real click target a mouse would hit.
   const clickIcon = (value: string): void => {
      const icon = $menu().querySelector<HTMLAnchorElement>(`a[data-value="${value}"]`)!
      const target = (icon.querySelector("svg") ?? icon) as HTMLElement
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
   }

   it("calendar icon opens the date editor and keeps the menu open", () => {
      dropdown.showChannelMenu("", vi.fn())
      clickIcon("__date__")
      expect($menu().classList.contains("srr-open")).toBe(true)
      expect($menu().querySelector(".srr-date-input")).not.toBeNull()
   })

   it("image-proxy icon opens its editor and keeps the menu open", () => {
      dropdown.showChannelMenu("", vi.fn())
      clickIcon("__imgproxy__")
      expect($menu().classList.contains("srr-open")).toBe(true)
      expect($menu().querySelector(".srr-imgproxy-input")).not.toBeNull()
   })

   it("a navigation chip still closes the menu via the window handler", () => {
      dropdown.showChannelMenu("", vi.fn())
      const chip = $menu().querySelector<HTMLAnchorElement>('a[data-value="t:28800"]')!
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      expect($menu().classList.contains("srr-open")).toBe(false)
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
      dropdown.showChannelMenu("", vi.fn(), { viewIsList: () => true, selectFilter, reapplyFilter: vi.fn() })
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

describe("dropdown: unseen-only chip", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>
   const $chip = () => $menu().querySelector<HTMLAnchorElement>('a[data-value="__unread__"]')

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      guard = vi.fn((fn) => fn())
      nav.isUnreadOnly.mockReset().mockReturnValue(false)
      nav.setUnreadOnly.mockReset()
      nav.fromHash.mockClear()
      nav.switchFilter.mockReset()
      nav.getCurrentFilterKey.mockReturnValue("")
      vi.resetModules()
      dropdown = await import("./dropdown")
   })

   afterEach(() => {
      nav.isUnreadOnly.mockReturnValue(false)
      nav.getCurrentFilterKey.mockReturnValue("")
      dropdown.closeAllDropdowns()
   })

   it("renders the chip off by default and on when enabled", () => {
      dropdown.showChannelMenu("", guard)
      expect($chip()!.className).toContain("srr-unread-off")
      dropdown.closeAllDropdowns()
      nav.isUnreadOnly.mockReturnValue(true)
      dropdown.showChannelMenu("", guard)
      expect($chip()!.className).toContain("srr-unread-on")
   })

   it("toggles the mode and replays the raw hash for a non-tag filter, keeping the menu open", () => {
      dropdown.showChannelMenu("", guard) // [ALL] → getCurrentFilterKey "" → fromHash
      $chip()!.click()
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(true)
      expect(nav.fromHash).toHaveBeenCalled()
      expect(nav.switchFilter).not.toHaveBeenCalled()
      expect($menu().classList.contains("srr-open")).toBe(true)
   })

   it("re-resolves via switchFilter (resume at current position) when the current filter is a single tag", () => {
      nav.getCurrentFilterKey.mockReturnValue("news") // a tag: non-numeric, non-empty
      dropdown.showChannelMenu("", guard)
      $chip()!.click()
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(true)
      expect(nav.switchFilter).toHaveBeenCalledWith("news")
      expect(nav.fromHash).not.toHaveBeenCalled()
   })

   it("uses fromHash, not switchFilter, for a single-channel (numeric) filter", () => {
      nav.getCurrentFilterKey.mockReturnValue("42") // a channel id, not a tag
      dropdown.showChannelMenu("", guard)
      $chip()!.click()
      expect(nav.fromHash).toHaveBeenCalled()
      expect(nav.switchFilter).not.toHaveBeenCalled()
   })

   // BUG-3: the flip + re-apply must be atomic inside the guard, so a busy guard
   // (a nav already in flight, or a rapid double-click) drops the WHOLE toggle —
   // the chip never gets ahead of the applied nav state.
   it("a busy/dropped guard leaves the chip and mode untouched (no divergence)", () => {
      const busyGuard = vi.fn() // mimics app.ts guard returning early while busy
      dropdown.showChannelMenu("", busyGuard)
      expect($chip()!.className).toContain("srr-unread-off")
      $chip()!.click()
      expect(nav.setUnreadOnly).not.toHaveBeenCalled() // flip never ran
      expect($chip()!.className).toContain("srr-unread-off") // chip stayed off
      expect($menu().classList.contains("srr-open")).toBe(true)
   })

   // FIX D: the target mode is captured ONCE outside the guarded fn. guard's
   // error path re-invokes the SAME fn on Retry; if the fn read the live
   // !isUnreadOnly() it would flip BACK the already-applied toggle. Here the
   // nav re-apply rejects, then Retry runs the same fn again — setUnreadOnly
   // must get the SAME captured `want` both times, never toggled back.
   it("a rejected nav re-apply then Retry re-applies the SAME mode (idempotent)", async () => {
      // Faithfully simulate the real flip: setUnreadOnly drives isUnreadOnly, so
      // a buggy live `!isUnreadOnly()` read inside the fn would compute the
      // opposite on the retry and expose itself.
      let mode = false
      nav.isUnreadOnly.mockImplementation(() => mode)
      nav.setUnreadOnly.mockImplementation((on: boolean) => {
         mode = on
      })
      // The nav re-apply rejects once (cold-pack fetch fails), succeeds on Retry.
      nav.switchFilter.mockRejectedValueOnce(new Error("cold pack")).mockResolvedValueOnce({} as IShowFeed)
      nav.getCurrentFilterKey.mockReturnValue("news") // a tag → switchFilter route

      // A guard that mirrors app.ts: runs fn; on rejection it captures a Retry
      // that re-invokes the SAME fn (the closure app.ts hands showError).
      let retry: (() => void) | undefined
      const retryGuard = vi.fn((fn: () => Promise<IShowFeed>) => {
         const run = () => fn().catch(() => (retry = run))
         void run()
      })

      dropdown.showChannelMenu("", retryGuard)
      $chip()!.click() // first attempt → switchFilter rejects → retry armed
      await new Promise((r) => setTimeout(r))
      expect(nav.setUnreadOnly).toHaveBeenNthCalledWith(1, true)

      retry!() // user clicks Retry → same fn re-runs
      await new Promise((r) => setTimeout(r))
      // The captured `want` (true) is re-applied — NOT flipped back to false.
      expect(nav.setUnreadOnly).toHaveBeenNthCalledWith(2, true)
      expect(nav.switchFilter).toHaveBeenCalledTimes(2)
      expect(nav.switchFilter).toHaveBeenNthCalledWith(2, "news")
   })

   // BUG-5: Space-activating the chip detaches it on rebuild; focus must return
   // to the freshly-built chip (else the next Arrow restarts from the first row).
   // The roving handler activates via a synthetic .click() (detail === 0).
   it("restores focus to the eye chip after a keyboard (Space) toggle", () => {
      dropdown.showChannelMenu("", guard)
      $chip()!.focus()
      key($chip()!, " ")
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(true)
      // A new chip was built by rebuild(); focus landed back on it.
      expect(document.activeElement).toBe($chip())
   })

   // FIX E: a keyboard activation carries detail === 0 (Space → synthetic
   // .click()); even with the chip focused (as it is after BUG-5's refocus or
   // FIX A keeping it focused), it refocuses the rebuilt chip.
   it("refocuses the rebuilt chip on a detail:0 (keyboard) activation", () => {
      dropdown.showChannelMenu("", guard)
      $chip()!.focus()
      $chip()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }))
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(true)
      expect(document.activeElement).toBe($chip())
   })

   // FIX E: a real mouse click carries detail >= 1. Even though the browser
   // focuses the <a> chip on mousedown (so activeElement IS the chip at click
   // time), the handler must NOT treat it as keyboard, so it never refocuses
   // the rebuilt chip: the old chip detaches on rebuild and focus is not moved
   // back to the new one.
   it("does not refocus the chip on a detail:1 (real mouse) click", () => {
      dropdown.showChannelMenu("", guard)
      $chip()!.focus() // mimic the browser focusing the chip on mousedown
      $chip()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }))
      expect(nav.setUnreadOnly).toHaveBeenCalledWith(true)
      // No keyboard refocus: the freshly-rebuilt chip did NOT receive focus.
      expect(document.activeElement).not.toBe($chip())
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
