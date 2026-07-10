import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// dropdown.ts now owns the centered modals — the image-proxy editor, the
// backup/restore dialog, the sync editor — plus the anchored context menu
// (showContextMenu, the card behind both the frontier menu and the gear's
// settings menu: checked toggle rows, disabled rows, and an optional status
// footer). The filter-picker rendering lives in picker.ts (covered in
// picker.test.ts). These tests open each dialog/menu directly and exercise
// its behavior.
import { getImgProxy, setImgProxy } from "./fmt"

type Dropdown = typeof import("./dropdown")

// The image-proxy dialog scaffold — dropdown.ts queries .srr-imgproxy-dialog at
// module load and injects .srr-imgproxy-body into the card on open.
const IMG_DIALOG =
   `<div class="srr-imgproxy-dialog" role="dialog">` +
   `<div class="srr-imgproxy-card">` +
   `<h2 class="srr-imgproxy-title" id="srr-imgproxy-title">Image proxy</h2>` +
   `<p class="srr-imgproxy-desc"></p>` +
   `<div class="srr-imgproxy-body"></div>` +
   `</div></div>`
// Backup dialog scaffold — mirrors the imgproxy dialog shape.
const BACKUP_DIALOG =
   `<div class="srr-backup-dialog" role="dialog">` +
   `<div class="srr-backup-card">` +
   `<h2 class="srr-backup-title" id="srr-backup-title">Backup / Restore</h2>` +
   `<div class="srr-backup-body"></div>` +
   `</div></div>`
// Sync dialog scaffold — same editor shape as the imgproxy dialog.
const SYNC_DIALOG =
   `<div class="srr-sync-dialog" role="dialog">` +
   `<div class="srr-sync-card">` +
   `<h2 class="srr-sync-title" id="srr-sync-title">Sync</h2>` +
   `<div class="srr-sync-body"></div>` +
   `</div></div>`
// A stand-in opener (a config quick-action / the frontier menu's toolbar anchor,
// in production) so the focus-restore tests have something to return focus to.
// dropdown.ts binds its dialog lookups at module load, so the scaffold must
// exist before import.
const OPENER = `<button class="srr-opener"></button>`
const SKELETON = OPENER + IMG_DIALOG + BACKUP_DIALOG + SYNC_DIALOG

function key(el: HTMLElement, k: string, shiftKey = false): void {
   el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }))
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

   it("defaults a schemeless prefix to https and adds a trailing slash on commit", () => {
      dropdown.showImgProxyDialog()
      $input()!.value = "images.weserv.nl"
      $btn(".srr-imgproxy-save")!.click()
      expect(getImgProxy()).toBe("https://images.weserv.nl/")
      expect(isOpen()).toBe(false)
   })

   it("rejects an explicit non-http(s) scheme: flags the input, keeps the dialog open, stores nothing", () => {
      dropdown.showImgProxyDialog()
      const input = $input()!
      input.value = "ftp://evil/"
      key(input, "Enter")
      expect(input.classList.contains("srr-input-invalid")).toBe(true)
      expect($input()).not.toBeNull() // still editing
      expect(isOpen()).toBe(true)
      expect(getImgProxy()).toBe("")
   })

   it("editing clears the invalid marker on the proxy input", () => {
      dropdown.showImgProxyDialog()
      const input = $input()!
      input.value = "ftp://evil/"
      key(input, "Enter") // rejected → flags .srr-input-invalid
      expect(input.classList.contains("srr-input-invalid")).toBe(true)
      input.dispatchEvent(new Event("input", { bubbles: true }))
      expect(input.classList.contains("srr-input-invalid")).toBe(false)
   })

   it("committing the unchanged value just closes", () => {
      setImgProxy("https://old.example/?url=")
      dropdown.showImgProxyDialog()
      key($input()!, "Enter")
      expect(getImgProxy()).toBe("https://old.example/?url=")
      expect(isOpen()).toBe(false)
   })

   // On close, focus returns to whatever opened the dialog — the config settings
   // row in the real flow.
   it("restores focus to the opener on close (not <body>)", () => {
      const opener = document.querySelector<HTMLButtonElement>(".srr-opener")!
      opener.focus()
      dropdown.showImgProxyDialog()
      const input = $input()!
      input.value = "https://new.example/?url="
      key(input, "Enter")
      expect(isOpen()).toBe(false)
      expect(document.activeElement).toBe(opener)
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

describe("backup/restore dialog", () => {
   let dropdown: Dropdown
   const $dialog = () => document.querySelector<HTMLElement>(".srr-backup-dialog")!
   const $exportArea = () => $dialog().querySelector<HTMLTextAreaElement>(".srr-backup-export")
   const $importArea = () => $dialog().querySelector<HTMLTextAreaElement>(".srr-backup-import")
   const $prefsCheck = () => $dialog().querySelector<HTMLInputElement>(".srr-backup-prefs")
   const $btn = (cls: string) => $dialog().querySelector<HTMLButtonElement>(cls)
   const isOpen = () => $dialog().classList.contains("srr-open")

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      vi.resetModules()
      dropdown = await import("./dropdown")
   })
   afterEach(() => {
      if ($dialog()?.classList.contains("srr-open")) {
         $dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      }
   })

   it("opens with export textarea pre-seeded with the current profile JSON", () => {
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 5 }))
      localStorage.setItem("srr-saved", JSON.stringify([3, 7]))
      dropdown.showBackupDialog()
      const exportText = $exportArea()!.value
      const obj = JSON.parse(exportText)
      expect(obj.v).toBe(2)
      expect(obj.seen).toEqual({ "feed:1": 5 })
      expect(obj.saved).toEqual([3, 7])
   })

   it("a valid paste into the import area and clicking Import merges and closes", () => {
      const blob = JSON.stringify({ v: 1, seen: { "feed:2": 10 }, saved: [1, 2], unreadOnly: false, imgProxy: "" })
      const onImport = vi.fn()
      dropdown.showBackupDialog(onImport)
      $importArea()!.value = blob
      $btn(".srr-backup-import-btn")!.click()
      expect(isOpen()).toBe(false)
      expect(onImport).toHaveBeenCalledTimes(1)
      // data was merged
      const seen = JSON.parse(localStorage.getItem("srr-seen")!)
      expect(seen["feed:2"]).toBe(10)
   })

   it("invalid JSON in the import area shows an error message and keeps the dialog open", () => {
      dropdown.showBackupDialog()
      $importArea()!.value = "not valid json"
      $btn(".srr-backup-import-btn")!.click()
      expect(isOpen()).toBe(true)
      const errEl = $dialog().querySelector(".srr-backup-import-error")
      expect(errEl).not.toBeNull()
      expect(errEl!.textContent).toBeTruthy()
   })

   it("prefs checkbox defaults to unchecked and gates pref import", () => {
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [], unreadOnly: true, imgProxy: "https://p.example/?url=" })
      dropdown.showBackupDialog()
      // checkbox must default to unchecked (off)
      expect($prefsCheck()!.checked).toBe(false)
      $importArea()!.value = blob
      $btn(".srr-backup-import-btn")!.click()
      // prefs NOT applied because checkbox was off
      expect(localStorage.getItem("srr-unread-only")).toBeNull()
      expect(localStorage.getItem("srr-img-proxy") ?? "").toBe("")
   })

   it("checking prefs checkbox applies preferences on import", () => {
      const blob = JSON.stringify({ v: 1, seen: {}, saved: [], unreadOnly: true, imgProxy: "https://p.example/?url=" })
      dropdown.showBackupDialog()
      $prefsCheck()!.checked = true
      $importArea()!.value = blob
      $btn(".srr-backup-import-btn")!.click()
      expect(localStorage.getItem("srr-unread-only")).toBe("1")
      expect(localStorage.getItem("srr-img-proxy")).toBe("https://p.example/?url=")
   })

   it("Escape closes the dialog without importing", () => {
      dropdown.showBackupDialog()
      $dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      expect(isOpen()).toBe(false)
   })

   it("a backdrop click closes the dialog; a click on the card does not", () => {
      dropdown.showBackupDialog()
      $dialog()
         .querySelector(".srr-backup-card")!
         .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      expect(isOpen()).toBe(true)
      $dialog().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      expect(isOpen()).toBe(false)
   })

   it("re-opening keeps exactly one editor body (no stacking)", () => {
      dropdown.showBackupDialog()
      $dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      dropdown.showBackupDialog()
      expect($dialog().querySelectorAll(".srr-backup-body").length).toBe(1)
      expect($dialog().querySelectorAll(".srr-backup-export").length).toBe(1)
   })

   it("restores focus to the opener on close", () => {
      const opener = document.querySelector<HTMLButtonElement>(".srr-opener")!
      opener.focus()
      dropdown.showBackupDialog()
      $dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(opener)
   })

   it("backup Copy writes the profile to the clipboard", () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
      try {
         dropdown.showBackupDialog()
         const text = $exportArea()!.value
         $btn(".srr-backup-copy")!.click()
         expect(writeText).toHaveBeenCalledWith(text)
      } finally {
         delete (navigator as { clipboard?: unknown }).clipboard
      }
   })

   it("backup Copy falls back to execCommand when clipboard is unavailable", () => {
      // No Clipboard API → the handler takes the select() + execCommand("copy") path.
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
      const execCommand = vi.fn()
      Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true })
      const selectSpy = vi.spyOn(HTMLTextAreaElement.prototype, "select").mockImplementation(() => {})
      try {
         dropdown.showBackupDialog()
         $btn(".srr-backup-copy")!.click()
         expect(selectSpy).toHaveBeenCalled()
         expect(execCommand).toHaveBeenCalledWith("copy")
      } finally {
         selectSpy.mockRestore()
         delete (navigator as { clipboard?: unknown }).clipboard
         delete (document as { execCommand?: unknown }).execCommand
      }
   })

   it("backup Download saves srr-profile.json", () => {
      vi.useFakeTimers()
      const createObjectURL = vi.fn(() => "blob:fake-url")
      const revokeObjectURL = vi.fn()
      const origCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL")
      const origRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")
      Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true, writable: true })
      Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true, writable: true })
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
      try {
         dropdown.showBackupDialog()
         $btn(".srr-backup-download")!.click()
         expect(createObjectURL).toHaveBeenCalledTimes(1)
         // vitest records each call's `this` (the clicked anchor) in mock.instances.
         const clicked = clickSpy.mock.instances[0] as HTMLAnchorElement
         expect(clicked).toBeDefined()
         expect(clicked.download).toBe("srr-profile.json")
         // revokeObjectURL is deferred (setTimeout 10s) so the download can start.
         expect(revokeObjectURL).not.toHaveBeenCalled()
         vi.advanceTimersByTime(10000)
         expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url")
      } finally {
         clickSpy.mockRestore()
         if (origCreate) Object.defineProperty(URL, "createObjectURL", origCreate)
         else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
         if (origRevoke) Object.defineProperty(URL, "revokeObjectURL", origRevoke)
         else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
         vi.useRealTimers()
      }
   })

   it("editing the import box clears the error", () => {
      dropdown.showBackupDialog()
      $importArea()!.value = "not valid json"
      $btn(".srr-backup-import-btn")!.click()
      const errEl = $dialog().querySelector<HTMLElement>(".srr-backup-import-error")!
      expect(errEl.hidden).toBe(false)
      $importArea()!.dispatchEvent(new Event("input", { bubbles: true }))
      expect(errEl.hidden).toBe(true)
   })
})

describe("sync dialog", () => {
   let dropdown: Dropdown
   let sync: typeof import("./sync")
   let fetchMock: ReturnType<typeof vi.fn>
   const $dialog = () => document.querySelector<HTMLElement>(".srr-sync-dialog")!
   const $input = () => $dialog().querySelector<HTMLInputElement>(".srr-sync-input")
   const $btn = (cls: string) => $dialog().querySelector<HTMLButtonElement>(cls)
   const isOpen = () => $dialog().classList.contains("srr-open")

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      localStorage.clear()
      // Saving a new endpoint kicks a real syncNow({manual:true}) cycle — stub
      // the network so the test asserts the kick without leaving jsdom.
      fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ v: 1 }) }))
      vi.stubGlobal("fetch", fetchMock)
      vi.resetModules()
      sync = await import("./sync")
      dropdown = await import("./dropdown")
   })
   afterEach(() => {
      if ($dialog()?.classList.contains("srr-open")) key(document.body, "Escape")
      vi.unstubAllGlobals()
   })

   it("opens seeded from the stored endpoint", () => {
      sync.setSyncUrl("https://sync.example/profile")
      dropdown.showSyncDialog()
      expect($input()!.value).toBe("https://sync.example/profile")
   })

   it("Save normalizes (https default, no trailing slash), stores, and kicks a first cycle", async () => {
      dropdown.showSyncDialog()
      $input()!.value = "sync.example/profile"
      $btn(".srr-sync-save")!.click()
      expect(isOpen()).toBe(false)
      expect(sync.getSyncUrl()).toBe("https://sync.example/profile")
      await Promise.resolve()
      expect(fetchMock).toHaveBeenCalledWith("https://sync.example/profile", expect.anything())
   })

   it("rejects an invalid URL, marks the input, and stays open", () => {
      dropdown.showSyncDialog()
      $input()!.value = "javascript:alert(1)"
      $btn(".srr-sync-save")!.click()
      expect(isOpen()).toBe(true)
      expect($input()!.classList.contains("srr-input-invalid")).toBe(true)
      expect(sync.getSyncUrl()).toBe("")
   })

   it("Disable appears only when an endpoint is set, and clears it without a cycle", () => {
      dropdown.showSyncDialog()
      expect($btn(".srr-sync-clear")).toBeNull()
      key(document.body, "Escape")

      sync.setSyncUrl("https://sync.example/profile")
      dropdown.showSyncDialog()
      $btn(".srr-sync-clear")!.click()
      expect(isOpen()).toBe(false)
      expect(sync.getSyncUrl()).toBe("")
      expect(fetchMock).not.toHaveBeenCalled()
   })

   it("opening one modal closes another (shared shell, no stacking)", () => {
      dropdown.showImgProxyDialog()
      dropdown.showSyncDialog()
      expect(document.querySelector(".srr-imgproxy-dialog")!.classList.contains("srr-open")).toBe(false)
      expect(isOpen()).toBe(true)
   })
})

describe("anchored context menu (showContextMenu)", () => {
   let dropdown: Dropdown
   const $menu = () => document.querySelector<HTMLElement>(".srr-ctxmenu")
   const $items = () => [...document.querySelectorAll<HTMLButtonElement>(".srr-ctxmenu-item")]
   const anchor = () => document.querySelector<HTMLButtonElement>(".srr-opener")!

   beforeEach(async () => {
      document.body.innerHTML = SKELETON
      vi.resetModules()
      dropdown = await import("./dropdown")
   })
   // The open menu holds document/window listeners; dismiss it so they can't
   // bleed into the next test (same discipline as the modal describes above).
   afterEach(() => {
      if ($menu()) key(document.body, "Escape")
   })

   it("renders one menuitem row per action and no menu for an empty list", () => {
      dropdown.showContextMenu(anchor(), [])
      expect($menu()).toBeNull()
      dropdown.showContextMenu(anchor(), [
         { label: "Mark all read", action: vi.fn() },
         { label: "Mark unread from here", action: vi.fn() },
      ])
      expect($menu()!.getAttribute("role")).toBe("menu")
      expect($items().map((b) => b.textContent)).toEqual(["Mark all read", "Mark unread from here"])
      expect($items().every((b) => b.getAttribute("role") === "menuitem")).toBe(true)
   })

   it("an item click closes first, then runs its action", () => {
      const order: string[] = []
      dropdown.showContextMenu(anchor(), [{ label: "A", action: () => order.push($menu() ? "open" : "closed") }])
      $items()[0].click()
      expect(order).toEqual(["closed"]) // no menu left behind if the action throws up a dialog
      expect($menu()).toBeNull()
   })

   it("focuses the container; arrows enter the items and step with wrap-around", () => {
      dropdown.showContextMenu(anchor(), [
         { label: "A", action: vi.fn() },
         { label: "B", action: vi.fn() },
      ])
      // The container holds focus on open (no item painted pre-selected); the
      // arrows enter the items at the matching end and then step with wrap.
      expect(document.activeElement).toBe($menu())
      key($menu()!, "ArrowDown")
      expect(document.activeElement).toBe($items()[0])
      key($items()[0], "ArrowDown")
      expect(document.activeElement).toBe($items()[1])
      key($items()[1], "ArrowDown") // wraps
      expect(document.activeElement).toBe($items()[0])
      key($items()[0], "ArrowUp") // wraps back
      expect(document.activeElement).toBe($items()[1])
   })

   it("ArrowUp from the fresh container enters at the last item", () => {
      dropdown.showContextMenu(anchor(), [
         { label: "A", action: vi.fn() },
         { label: "B", action: vi.fn() },
      ])
      key($menu()!, "ArrowUp")
      expect(document.activeElement).toBe($items()[1])
   })

   it("traps Tab within the menu items so focus can't escape behind the open menu", () => {
      dropdown.showContextMenu(anchor(), [
         { label: "A", action: vi.fn() },
         { label: "B", action: vi.fn() },
      ])
      key($menu()!, "Tab") // from the fresh container → first item
      expect(document.activeElement).toBe($items()[0])
      key($items()[0], "Tab")
      expect(document.activeElement).toBe($items()[1])
      key($items()[1], "Tab") // wraps forward
      expect(document.activeElement).toBe($items()[0])
      $items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }))
      expect(document.activeElement).toBe($items()[1]) // Shift+Tab wraps backward
   })

   it("Escape closes and restores focus to the anchor", () => {
      dropdown.showContextMenu(anchor(), [{ label: "A", action: vi.fn() }])
      key(document.body, "Escape")
      expect($menu()).toBeNull()
      expect(document.activeElement).toBe(anchor())
   })

   it("a press outside dismisses without firing any action", () => {
      const action = vi.fn()
      dropdown.showContextMenu(anchor(), [{ label: "A", action }])
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }))
      expect($menu()).toBeNull()
      expect(action).not.toHaveBeenCalled()
   })

   it("shares the modals' single-closer slot: opening a modal closes the menu and vice versa", () => {
      dropdown.showContextMenu(anchor(), [{ label: "A", action: vi.fn() }])
      dropdown.showImgProxyDialog()
      expect($menu()).toBeNull()
      expect(document.querySelector(".srr-imgproxy-dialog")!.classList.contains("srr-open")).toBe(true)
      dropdown.showContextMenu(anchor(), [{ label: "A", action: vi.fn() }])
      expect(document.querySelector(".srr-imgproxy-dialog")!.classList.contains("srr-open")).toBe(false)
      expect($menu()).not.toBeNull()
   })

   it("a checked item is a menuitemcheckbox with aria-checked; plain items stay menuitem", () => {
      dropdown.showContextMenu(anchor(), [
         { label: "Show read", checked: true, action: vi.fn() },
         { label: "Off toggle", checked: false, action: vi.fn() },
         { label: "Plain", action: vi.fn() },
      ])
      const [on, off, plain] = $items()
      expect(on.getAttribute("role")).toBe("menuitemcheckbox")
      expect(on.getAttribute("aria-checked")).toBe("true")
      expect(off.getAttribute("role")).toBe("menuitemcheckbox")
      expect(off.getAttribute("aria-checked")).toBe("false")
      expect(plain.getAttribute("role")).toBe("menuitem")
      expect(plain.hasAttribute("aria-checked")).toBe(false)
   })

   it("a disabled item is inert and the arrows skip it", () => {
      const dead = vi.fn()
      dropdown.showContextMenu(anchor(), [
         { label: "A", action: vi.fn() },
         { label: "Search articles…", action: dead, disabled: true },
         { label: "B", action: vi.fn() },
      ])
      const disabled = $items()[1]
      expect(disabled.disabled).toBe(true)
      disabled.click()
      expect(dead).not.toHaveBeenCalled()
      expect($menu()).not.toBeNull() // a dead click doesn't dismiss the menu
      // Arrow stepping never lands on it: A → B → wrap back to A.
      key($menu()!, "ArrowDown")
      expect(document.activeElement).toBe($items()[0])
      key($items()[0], "ArrowDown")
      expect(document.activeElement).toBe($items()[2])
      key($items()[2], "ArrowDown")
      expect(document.activeElement).toBe($items()[0])
   })

   it("appends an opts.footer block after the items, non-interactive to the arrows", () => {
      const footer = document.createElement("div")
      footer.textContent = "Updated 2 hours ago"
      dropdown.showContextMenu(anchor(), [{ label: "A", action: vi.fn() }], { footer })
      expect(footer.parentElement).toBe($menu())
      expect(footer.classList.contains("srr-ctxmenu-footer")).toBe(true)
      expect($menu()!.lastElementChild).toBe(footer) // after every item row
      // The arrows only ever step the action rows.
      key($menu()!, "ArrowUp")
      expect(document.activeElement).toBe($items()[0])
   })
})
