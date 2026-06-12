import { describe, it, expect, vi, beforeEach } from "vitest"

// dropdown.ts owns its DOM lookups at module load, so the skeleton must exist
// before import — hence vi.resetModules() + dynamic import per test run.
const data = vi.hoisted(() => ({
   groupChannelsByTag: vi.fn(() => ({ tagged: new Map(), sortedTags: [] as string[], untagged: [] as IChannel[] })),
   findChronForTimestamp: vi.fn(async () => 0),
}))
vi.mock("./data", () => data)

const nav = vi.hoisted(() => ({
   getCurrentFilterKey: vi.fn(() => ""),
   fromHash: vi.fn(),
   last: vi.fn(),
   goTo: vi.fn(),
   switchFilter: vi.fn(),
}))
vi.mock("./nav", () => nav)

import { getImgProxy, setImgProxy } from "./fmt"

type Dropdown = typeof import("./dropdown")

const SKELETON =
   '<div class="srr-dropdown">' +
   '<button class="srr-dropdown-btn srr-channel" aria-expanded="false"></button>' +
   '<div id="srr-channel-menu" class="srr-dropdown-menu" role="menu"></div>' +
   "</div>"

const $menu = () => document.getElementById("srr-channel-menu")!
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
