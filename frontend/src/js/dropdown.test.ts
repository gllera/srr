import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// dropdown.ts now owns only the two centered modals — the image-proxy editor and
// the backup/restore dialog. The toolbar dropdown menus (filter picker + ⋯
// settings) were retired when those moved into the config surface (config.ts), so
// the feed-menu / overflow-menu / unread-badge / keyboard-roving / feed-health
// coverage moved to config.test.ts. These tests open each dialog directly (the way
// the config settings rows do) and exercise the modal behavior.
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
// A stand-in opener (the config settings row, in production) so the focus-restore
// tests have something to return focus to. dropdown.ts binds its dialog lookups at
// module load, so the scaffold must exist before import.
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
      expect(obj.v).toBe(1)
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
      // Saving a new endpoint kicks a real syncNow(true) cycle — stub the network
      // so the test asserts the kick without leaving jsdom.
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
