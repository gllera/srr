import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// dropdown.ts owns its DOM lookups at module load, so the skeleton must exist
// before import — hence vi.resetModules() + dynamic import per test run.
const data = vi.hoisted(() => {
   const mock = {
      db: {} as IDB,
      groupFeedsByTag: vi.fn(() => ({ tagged: new Map(), sortedTags: [] as string[], untagged: [] as IFeed[] })),
      feedTitle: (feedId: number) => mock.db.feeds?.[feedId]?.title ?? "[DELETED]",
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
   unreadCounts: vi.fn<(chs: IFeed[]) => Promise<Map<number, number>>>(async () => new Map()),
   // Synchronous plain sum of the already-computed counts map (mirrors the real
   // impl): a never-seen feed arrives as its full backlog, a positive number;
   // Math.max guards any stray negative / missing member down to 0. Tests that
   // pin the badge value override this implementation.
   tagUnreadFromCounts: vi.fn<(group: IFeed[], counts: Map<number, number>) => number>((group, counts) =>
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
// The image-proxy dialog scaffold — dropdown.ts queries .srr-imgproxy-dialog at
// module load and injects .srr-imgproxy-body into the card on open.
const DIALOG =
   `<div class="srr-imgproxy-dialog" role="dialog">` +
   `<div class="srr-imgproxy-card">` +
   `<h2 class="srr-imgproxy-title" id="srr-imgproxy-title">Image proxy</h2>` +
   `<p class="srr-imgproxy-desc"></p>` +
   `<div class="srr-imgproxy-body"></div>` +
   `</div></div>`
// The whole toolbar's dropdowns + the proxy dialog: dropdown.ts binds its DOM
// lookups at module load, so every menu/button/dialog it touches must exist
// before import.
const SKELETON = dd("srr-feed", "srr-feed-menu") + dd("srr-overflow", "srr-overflow-menu") + DIALOG

const $menu = () => document.getElementById("srr-feed-menu")!
const feed = (over: Partial<IFeed>): IFeed =>
   ({ id: 1, title: "Test", url: "http://test.com", total_art: 1, ...over }) as IFeed

function key(el: HTMLElement, k: string): void {
   el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))
}

describe("image-proxy dialog", () => {
   let dropdown: Dropdown
   const $dialog = () => document.querySelector<HTMLElement>(".srr-imgproxy-dialog")!
   const $input = () => $dialog().querySelector<HTMLInputElement>(".srr-imgproxy-input")
   const $btn = (cls: string) => $dialog().querySelector<HTMLButtonElement>(cls)
   const isOpen = () => $dialog().classList.contains("srr-open")

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })
   // Each open registers a capture-phase keydown listener on document; closing
   // removes it. Tear down any still-open dialog so a stale listener (on the
   // shared jsdom document) can't bleed into the next test.
   afterEach(() => {
      if ($dialog()?.classList.contains("srr-open")) key(document.body, "Escape")
   })

   it("the ⋯ overflow menu has an 'Image proxy…' row that opens the dialog and closes the menu", () => {
      dropdown.showOverflowMenu()
      const row = document.querySelector<HTMLElement>('#srr-overflow-menu a[data-value="~img-proxy"]')
      expect(row).not.toBeNull()
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      expect(isOpen()).toBe(true)
      expect($input()).not.toBeNull()
      expect(document.getElementById("srr-overflow-menu")!.classList.contains("srr-open")).toBe(false)
   })

   it("opens seeded from the stored prefix", () => {
      setImgProxy("https://p.example/?url=")
      dropdown.showImgProxyDialog()
      expect($input()).not.toBeNull()
      expect($input()!.value).toBe("https://p.example/?url=")
   })

   // Regression: re-opening must repopulate the single stable .srr-imgproxy-body
   // host, never stack a second editor (an earlier build appended a fresh body and
   // close() removed the wrong one, leaving a stale duplicate to accumulate).
   it("re-opening keeps exactly one editor body (no stacking)", () => {
      dropdown.showImgProxyDialog()
      key($input()!, "Escape")
      dropdown.showImgProxyDialog()
      expect($dialog().querySelectorAll(".srr-imgproxy-body").length).toBe(1)
      expect($dialog().querySelectorAll(".srr-imgproxy-input").length).toBe(1)
   })

   it("commits a valid prefix on Enter and closes", () => {
      dropdown.showImgProxyDialog()
      const input = $input()!
      input.value = " https://new.example/?url= " // trimmed on commit
      key(input, "Enter")
      expect(getImgProxy()).toBe("https://new.example/?url=")
      expect(isOpen()).toBe(false)
   })

   it("the Save button commits the typed prefix and closes", () => {
      dropdown.showImgProxyDialog()
      $input()!.value = "https://save.example/?url="
      $btn(".srr-imgproxy-save")!.click()
      expect(getImgProxy()).toBe("https://save.example/?url=")
      expect(isOpen()).toBe(false)
   })

   it("cancels on Escape without persisting", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyDialog()
      $input()!.value = "https://changed.example/?url="
      key($input()!, "Escape")
      expect(getImgProxy()).toBe("https://old.example/?url=")
      expect(isOpen()).toBe(false)
   })

   it("the Cancel button discards without persisting", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyDialog()
      $input()!.value = "https://changed.example/?url="
      $btn(".srr-imgproxy-cancel")!.click()
      expect(getImgProxy()).toBe("https://old.example/?url=")
      expect(isOpen()).toBe(false)
   })

   it("the Disable button (shown only when a proxy is set) stores the empty string and closes", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyDialog()
      const clear = $btn(".srr-imgproxy-clear")
      expect(clear).not.toBeNull()
      clear!.click()
      expect(getImgProxy()).toBe("")
      expect(isOpen()).toBe(false)
   })

   it("omits Disable when no proxy is set (Save-of-empty already covers it)", () => {
      dropdown.showImgProxyDialog()
      expect($btn(".srr-imgproxy-clear")).toBeNull()
   })

   it("rejects a schemeless prefix: flags the input, keeps the dialog open, stores nothing", () => {
      dropdown.showImgProxyDialog()
      const input = $input()!
      input.value = "foo"
      key(input, "Enter")
      expect(input.classList.contains("srr-input-invalid")).toBe(true)
      expect($input()).not.toBeNull() // still editing
      expect(isOpen()).toBe(true)
      expect(getImgProxy()).toBe("")
   })

   it("committing the unchanged value just closes", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyDialog()
      key($input()!, "Enter")
      expect(getImgProxy()).toBe("https://old.example/?url=")
      expect(isOpen()).toBe(false)
   })

   // On close, focus returns to whatever opened the dialog — the ⋯ button in the
   // real flow (closeAllDropdowns hands focus there before the modal opens).
   it("restores focus to the opener on close (not <body>)", () => {
      const overflowBtn = document.querySelector<HTMLButtonElement>(".srr-overflow")!
      overflowBtn.focus()
      dropdown.showImgProxyDialog()
      const input = $input()!
      input.value = "https://new.example/?url="
      key(input, "Enter")
      expect(isOpen()).toBe(false)
      expect(document.activeElement).toBe(overflowBtn)
      expect(document.activeElement).not.toBe(document.body)
   })

   it("a backdrop click cancels; a click on the card does not", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyDialog()
      const md = () => new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      // A press inside the card keeps the dialog open.
      $dialog().querySelector<HTMLElement>(".srr-imgproxy-card")!.dispatchEvent(md())
      expect(isOpen()).toBe(true)
      // A press on the backdrop (the overlay itself) closes without saving.
      $dialog().dispatchEvent(md())
      expect(isOpen()).toBe(false)
      expect(getImgProxy()).toBe("https://old.example/?url=")
   })

   it("traps Tab inside the dialog — wraps last→first and first→last (no escape to the dimmed page)", () => {
      setImgProxy("https://p.example/?url=") // Disable shown → [input, Disable, Cancel, Save]
      dropdown.showImgProxyDialog()
      const f = Array.from($dialog().querySelectorAll<HTMLElement>("input, button"))
      const first = f[0]
      const last = f[f.length - 1]
      last.focus()
      key(last, "Tab")
      expect(document.activeElement).toBe(first) // forward wrap
      first.focus()
      $dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }))
      expect(document.activeElement).toBe(last) // backward wrap
   })
})

// Clicking the overflow "Image proxy…" row opens the dialog AND bubbles on to
// app.ts's window-level "any click closes dropdowns" handler. The menu closing is
// expected; the just-opened dialog must survive (it isn't a dropdown). Guards the
// regression where that handler would shut a freshly-opened overlay.
describe("image-proxy dialog: survives the window close handler", () => {
   let dropdown: Dropdown
   let closeHandler: (e: Event) => void
   const $dialog = () => document.querySelector<HTMLElement>(".srr-imgproxy-dialog")!

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      vi.resetModules()
      dropdown = await import("./dropdown")
      // Mirror app.ts's window close handler exactly (closest, not matches: a
      // tap can land on a button's inner icon span).
      closeHandler = (e) => {
         if (!(e.target as HTMLElement).closest(".srr-dropdown-btn")) dropdown.closeAllDropdowns()
      }
      window.addEventListener("click", closeHandler)
   })
   afterEach(() => {
      window.removeEventListener("click", closeHandler)
      if ($dialog()?.classList.contains("srr-open")) key(document.body, "Escape")
   })

   it("stays open after the row click reaches the window close handler", () => {
      dropdown.showOverflowMenu()
      const row = document.querySelector<HTMLElement>('#srr-overflow-menu a[data-value="~img-proxy"]')!
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      expect($dialog().classList.contains("srr-open")).toBe(true)
      expect($dialog().querySelector(".srr-imgproxy-input")).not.toBeNull()
      // the menu it launched from is closed
      expect(document.getElementById("srr-overflow-menu")!.classList.contains("srr-open")).toBe(false)
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

   it("marks broken feeds and their tag header with a dot carrying the error", () => {
      const broken = feed({ id: 3, title: "Dead", ferr: "404 not found" })
      const healthy = feed({ id: 4, title: "Live" })
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [broken]]]),
         sortedTags: ["news"],
         untagged: [healthy],
      })
      dropdown.showFeedMenu("", guard)

      const deadRow = $menu().querySelector('a[data-value="3"]')!
      expect(deadRow.querySelector(".srr-err-dot")).not.toBeNull()
      expect(deadRow.getAttribute("title")).toBe("404 not found")
      expect(deadRow.getAttribute("aria-label")).toContain("feed error")
      expect($menu().querySelector('a[data-value="4"] .srr-err-dot')).toBeNull()
      // The collapsed tag group reveals the trouble inside it.
      expect($menu().querySelector('a[data-value="news"] .srr-err-dot')).not.toBeNull()
   })

   it("renders clean rows for healthy and error-free feeds", () => {
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "NoErr", ferr: undefined })],
      })
      dropdown.showFeedMenu("", guard)
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
      data.groupFeedsByTag.mockReturnValueOnce({ tagged: new Map(), sortedTags: [], untagged: [feed({ id: 1 })] })
      dropdown.showFeedMenu("", vi.fn())
      expect($menu().querySelector('a[data-value="~saved"]')).toBeNull()
   })

   it("shows ★ Saved with a count once there are saved articles", () => {
      nav.savedCount.mockReturnValue(7)
      data.groupFeedsByTag.mockReturnValueOnce({ tagged: new Map(), sortedTags: [], untagged: [feed({ id: 1 })] })
      dropdown.showFeedMenu("", vi.fn())
      const row = $menu().querySelector('a[data-value="~saved"]')!
      expect(row).not.toBeNull()
      expect(row.textContent).toContain("Saved")
      expect(row.querySelector(".srr-saved-num")!.textContent).toBe("7")
   })

   it("selecting ★ Saved calls onSelect with the saved token", () => {
      nav.savedCount.mockReturnValue(2)
      data.groupFeedsByTag.mockReturnValueOnce({ tagged: new Map(), sortedTags: [], untagged: [] })
      const onSelect = vi.fn()
      dropdown.showFeedMenu("", onSelect)
      $menu().querySelector<HTMLElement>('a[data-value="~saved"]')!.click()
      expect(onSelect).toHaveBeenCalledWith("~saved")
   })
})

describe("dropdown: unread badges", () => {
   let dropdown: Dropdown
   let guard: ReturnType<typeof vi.fn>

   const $badge = (value: string) => $menu().querySelector(`a[data-value="${value}"] .srr-unread`)
   // Drive the batched nav.unreadCounts from a per-feed count function.
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
      const a = feed({ id: 3, title: "A" })
      const b = feed({ id: 4, title: "B" })
      const c = feed({ id: 5, title: "C" })
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [a, b]]]),
         sortedTags: ["news"],
         untagged: [c],
      })
      counts((id) => (id === 3 ? 5 : id === 4 ? 8 : 0)) // 4 never-seen → its full backlog
      // The header badge is nav.tagUnreadFromCounts, derived synchronously from
      // the same counts map — not a second await pass. Pinned here to prove the
      // header uses that function's value, not an arithmetic sum of the rows.
      nav.tagUnreadFromCounts.mockReturnValue(7)
      dropdown.showFeedMenu("", guard)
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
      const a = feed({ id: 3, title: "A" })
      const b = feed({ id: 4, title: "B" })
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [a, b]]]),
         sortedTags: ["news"],
         untagged: [],
      })
      counts(() => 0)
      nav.tagUnreadFromCounts.mockReturnValue(0) // nothing unseen
      dropdown.showFeedMenu("", guard)
      await new Promise((r) => setTimeout(r))
      expect($badge("news")).toBeNull()
   })

   it("hides fully-read rows and tags when unseen-only is on, keeping unread and never-seen", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      const a = feed({ id: 3, title: "A" }) // unread > 0 → shown
      const b = feed({ id: 4, title: "B" }) // never seen → full backlog → shown
      const old = feed({ id: 7, title: "Old" }) // fully read → tag hidden
      const c = feed({ id: 5, title: "C" }) // untagged, read → hidden
      const d = feed({ id: 6, title: "D" }) // untagged, unread → shown
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map([
            ["archive", [old]],
            ["news", [a, b]],
         ]),
         sortedTags: ["archive", "news"],
         untagged: [c, d],
      })
      counts((id) => (id === 3 ? 4 : id === 4 ? 9 : id === 6 ? 2 : 0)) // 4 never-seen → full backlog
      dropdown.showFeedMenu("", guard)
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

   // R3-4: with unseen-only on, the CURRENTLY-APPLIED tag/feed must never
   // self-hide even when read down to 0 unseen this session — else it loses its
   // .srr-active styling and becomes keyboard-unreachable while you're on it.
   // The toolbar counter uses a frozen snapshot, so it stays visible regardless.
   it("does not hide the active tag's group when fully read, but hides a different fully-read tag", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      nav.getCurrentFilterKey.mockReturnValue("news") // the active filter is the news tag
      try {
         const a = feed({ id: 3, title: "A" }) // active tag member, fully read
         const b = feed({ id: 4, title: "B" }) // active tag member, fully read
         const old = feed({ id: 7, title: "Old" }) // inactive tag, fully read → hidden
         data.groupFeedsByTag.mockReturnValueOnce({
            tagged: new Map([
               ["archive", [old]],
               ["news", [a, b]],
            ]),
            sortedTags: ["archive", "news"],
            untagged: [],
         })
         counts(() => 0) // every feed fully read
         dropdown.showFeedMenu("news", guard)
         await new Promise((r) => setTimeout(r))
         const row = (v: string) => $menu().querySelector(`a[data-value="${v}"]`)!
         const groupHidden = (v: string) => row(v).closest(".srr-tag-group")!.classList.contains("srr-hidden")
         expect(groupHidden("3")).toBe(false) // active tag stays put despite all-read
         expect(groupHidden("7")).toBe(true) // a different fully-read tag is hidden
      } finally {
         nav.getCurrentFilterKey.mockReturnValue("")
      }
   })

   // R3-4: the active FEED row is exempt from hiding the same way.
   it("does not hide the active feed row when fully read", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      nav.getCurrentFilterKey.mockReturnValue("5") // the active filter is feed id 5
      try {
         data.groupFeedsByTag.mockReturnValueOnce({
            tagged: new Map(),
            sortedTags: [],
            untagged: [feed({ id: 5, title: "Active" }), feed({ id: 6, title: "Other" })],
         })
         counts(() => 0) // both fully read
         dropdown.showFeedMenu("", guard)
         await new Promise((r) => setTimeout(r))
         const hidden = (v: string) => $menu().querySelector(`a[data-value="${v}"]`)!.classList.contains("srr-hidden")
         expect(hidden("5")).toBe(false) // active feed stays put
         expect(hidden("6")).toBe(true) // an inactive fully-read feed is hidden
      } finally {
         nav.getCurrentFilterKey.mockReturnValue("")
      }
   })

   // G15 (bug #5): when the active filter is a single FEED that belongs to a tag
   // whose every member has 0 unread, the tag GROUP must not be hidden — the
   // exempted active-feed row is inside it and would become keyboard-unreachable.
   it("does not hide the tag group when the active feed is a member and all members are fully read", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      nav.getCurrentFilterKey.mockReturnValue("5") // active filter is feed id 5
      try {
         const a = feed({ id: 5, title: "Active" }) // active feed, in tag "news"
         const b = feed({ id: 6, title: "Sibling" }) // sibling in same tag, also fully read
         data.groupFeedsByTag.mockReturnValueOnce({
            tagged: new Map([["news", [a, b]]]),
            sortedTags: ["news"],
            untagged: [],
         })
         counts(() => 0) // both fully read
         dropdown.showFeedMenu("", guard)
         await new Promise((r) => setTimeout(r))
         const row = (v: string) => $menu().querySelector(`a[data-value="${v}"]`)!
         const groupHidden = (v: string) => row(v).closest(".srr-tag-group")!.classList.contains("srr-hidden")
         // The active feed's row should not be hidden
         expect(row("5").classList.contains("srr-hidden")).toBe(false) // active feed row exempt
         // And its containing group must also NOT be hidden
         expect(groupHidden("5")).toBe(false) // group stays visible (active member inside)
         expect(groupHidden("6")).toBe(false) // same group, still not hidden
      } finally {
         nav.getCurrentFilterKey.mockReturnValue("")
      }
   })

   it("hides nothing when unseen-only is off", async () => {
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Read" })],
      })
      counts(() => 0) // fully read
      dropdown.showFeedMenu("", guard)
      await new Promise((r) => setTimeout(r))
      expect($menu().querySelector('a[data-value="5"]')!.classList.contains("srr-hidden")).toBe(false)
   })

   // R3-4 boundary: the active-key exemption is "" for [ALL]/multi-token, which
   // must exempt NOTHING — a fully-read row in the global catch-up view still hides.
   it("hides a fully-read row in the global ([ALL], key '') unseen-only view — '' exempts nothing", async () => {
      nav.isUnreadOnly.mockReturnValue(true)
      nav.getCurrentFilterKey.mockReturnValue("") // [ALL] / multi-token
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Read" })],
      })
      counts(() => 0) // fully read
      dropdown.showFeedMenu("", guard)
      await new Promise((r) => setTimeout(r))
      expect($menu().querySelector('a[data-value="5"]')!.classList.contains("srr-hidden")).toBe(true)
   })

   it("caps the displayed count at 999+", async () => {
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 6, title: "Busy" })],
      })
      counts(() => 1500)
      dropdown.showFeedMenu("", guard)
      await vi.waitFor(() => expect($badge("6")).not.toBeNull())
      expect($badge("6")!.textContent).toBe("999+")
   })

   it("a fill that resolves after the menu closed never touches the DOM", async () => {
      let release!: (m: Map<number, number>) => void
      nav.unreadCounts.mockImplementation(() => new Promise<Map<number, number>>((r) => (release = r)))
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 7, title: "Slow" })],
      })
      dropdown.showFeedMenu("", guard)
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
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 3, title: "A" }), feed({ id: 4, title: "B" })],
      })
      dropdown.showFeedMenu("", guard)
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
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 3, title: "A" })],
      })
      dropdown.showFeedMenu("", guard)
      const list = items()
      key(document.body, "ArrowUp")
      expect(document.activeElement).toBe(list[list.length - 1])
      key(document.body, "Home")
      expect(document.activeElement).toBe(list[0])
      key(document.body, "End")
      expect(document.activeElement).toBe(list[list.length - 1])
   })

   it("skips feed rows hidden inside a collapsed tag group", () => {
      data.groupFeedsByTag.mockReturnValueOnce({
         tagged: new Map([["news", [feed({ id: 3, title: "Hidden" })]]]),
         sortedTags: ["news"],
         untagged: [feed({ id: 4, title: "Visible" })],
      })
      dropdown.showFeedMenu("", guard) // currentTag "" → news starts collapsed
      key(document.body, "End")
      expect((document.activeElement as HTMLElement).dataset.value).toBe("4")
      key(document.activeElement as HTMLElement, "ArrowUp")
      expect((document.activeElement as HTMLElement).dataset.value).toBe("news")
   })

   it("Space activates the focused item and the keys never leak to other handlers", () => {
      dropdown.showFeedMenu("", guard)
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
      dropdown.showFeedMenu("", guard)
      key(document.body, "ArrowDown")
      expect($menu().contains(document.activeElement)).toBe(true)
      dropdown.closeAllDropdowns()
      expect(document.activeElement).toBe(document.querySelector(".srr-feed"))
   })
})

// Title search no longer lives in a dropdown — it's a list filter mode
// (nav "q:<query>") driven by the pinned search bar in app.ts. The search SET
// behavior is covered in nav.test.ts (search filter mode) and the search index
// itself in search.test.ts / the contract suite.
