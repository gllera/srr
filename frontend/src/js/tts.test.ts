import { beforeEach, describe, expect, it, vi } from "vitest"

import { wireTTS } from "./tts"

// jsdom implements no media playback: audio.paused stays true and nothing
// fires on its own. The tests drive the same signals the browser would —
// set currentTime, dispatch "timeupdate" — which is exactly the surface
// tts.ts consumes. currentTime > 0 doubles as the "narration has started"
// state the click-arming rule keys on.

function mount(tableAttr: string, body: string) {
   const title = document.createElement("h1")
   const content = document.createElement("div")
   const audioAttr = tableAttr ? ` data-tts-t="${tableAttr}"` : ""
   content.innerHTML = `<p><audio${audioAttr} src="x.wav"></audio></p>` + body
   document.body.replaceChildren(title, content)
   wireTTS({ title, content })
   const audio = content.querySelector("audio") as HTMLAudioElement
   return { title, content, audio }
}

function tick(audio: HTMLAudioElement, t: number) {
   audio.currentTime = t
   audio.dispatchEvent(new Event("timeupdate"))
}

describe("highlight follow", () => {
   beforeEach(() => document.body.replaceChildren())

   it("highlights the block whose span contains currentTime", () => {
      const { content, audio } = mount("0,5,10", '<p data-tts="1">a</p><p data-tts="2">b</p>')
      tick(audio, 6)
      expect(content.querySelector(".srr-tts-current")?.getAttribute("data-tts")).toBe("1")
      tick(audio, 10) // boundary is inclusive on the right segment
      expect(content.querySelector(".srr-tts-current")?.getAttribute("data-tts")).toBe("2")
   })

   it("segment 0 falls back to the title node when unstamped", () => {
      const { title, audio } = mount("0,5", '<p data-tts="1">a</p>')
      tick(audio, 2)
      expect(title.classList.contains("srr-tts-current")).toBe(true)
      tick(audio, 7)
      expect(title.classList.contains("srr-tts-current")).toBe(false)
   })

   it("a missing stamp means no highlight, not a crash", () => {
      const { content, audio } = mount("0,5,10", '<p data-tts="1">a</p>')
      tick(audio, 12) // segment 2 exists in the table, not in the DOM
      expect(content.querySelector(".srr-tts-current")).toBeNull()
   })

   it("ended clears the highlight and the host class", () => {
      const { content, audio } = mount("0,5", '<p data-tts="1">a</p>')
      tick(audio, 6)
      expect(content.classList.contains("srr-tts-live")).toBe(true)
      audio.dispatchEvent(new Event("ended"))
      expect(content.querySelector(".srr-tts-current")).toBeNull()
      expect(content.classList.contains("srr-tts-live")).toBe(false)
   })

   it("no narration audio -> inert (no classes, no throw)", () => {
      const { content } = mount("", '<p data-tts="1">a</p>')
      expect(content.classList.contains("srr-tts-live")).toBe(false)
   })

   it("a malformed table -> inert", () => {
      const { content, audio } = mount("0,abc", '<p data-tts="1">a</p>')
      tick(audio, 1)
      expect(content.querySelector(".srr-tts-current")).toBeNull()
   })

   it("a decreasing table -> inert", () => {
      const { content, audio } = mount("0,5,3", '<p data-tts="1">a</p>')
      tick(audio, 1)
      expect(content.querySelector(".srr-tts-current")).toBeNull()
   })
})

describe("click to seek", () => {
   beforeEach(() => document.body.replaceChildren())

   it("clicking a stamped block seeks to its start (once started)", () => {
      const { content, audio } = mount("0,5,10", '<p data-tts="1">a</p><p data-tts="2">b</p>')
      tick(audio, 1) // started
      content.querySelector('[data-tts="2"]')!.dispatchEvent(new Event("click", { bubbles: true }))
      expect(audio.currentTime).toBe(10)
   })

   it("title clicks stay permalink clicks — never a seek", () => {
      // Production masthead: the h1 sits inside the a.srr-title-row permalink.
      const row = document.createElement("a")
      row.className = "srr-title-row"
      const title = document.createElement("h1")
      row.append(title)
      const content = document.createElement("div")
      content.innerHTML = '<p><audio data-tts-t="0,5" src="x.wav"></audio></p><p data-tts="1">a</p>'
      document.body.replaceChildren(row, content)
      wireTTS({ title, content })
      const audio = content.querySelector("audio") as HTMLAudioElement
      audio.currentTime = 4
      audio.dispatchEvent(new Event("timeupdate"))
      expect(title.classList.contains("srr-tts-current")).toBe(true) // highlight still works
      title.dispatchEvent(new Event("click", { bubbles: true }))
      expect(audio.currentTime).toBe(4) // click untouched — the permalink owns it
   })

   it("duplicate stamps: the first claims the highlight, but any duplicate seeks by its own attribute", () => {
      const { content, audio } = mount("0,5,10", '<p data-tts="1">a</p><p data-tts="1">b</p>')
      tick(audio, 6) // segment 1 is current
      const dupes = content.querySelectorAll('[data-tts="1"]')
      expect(content.querySelector(".srr-tts-current")).toBe(dupes[0]) // first claim wins the map
      dupes[1].dispatchEvent(new Event("click", { bubbles: true }))
      expect(audio.currentTime).toBe(5) // the losing duplicate still seeks by ITS OWN attribute
   })

   it("seeking while paused stays paused", () => {
      const { content, audio } = mount("0,5,10", '<p data-tts="1">a</p><p data-tts="2">b</p>')
      tick(audio, 1) // started, still paused (jsdom never actually plays)
      const play = vi.spyOn(audio, "play")
      content.querySelector('[data-tts="2"]')!.dispatchEvent(new Event("click", { bubbles: true }))
      expect(audio.currentTime).toBe(10)
      expect(play).not.toHaveBeenCalled()
   })

   it("never seeks before the narration has started", () => {
      const { content, audio } = mount("0,5", '<p data-tts="1">a</p>')
      content.querySelector('[data-tts="1"]')!.dispatchEvent(new Event("click", { bubbles: true }))
      expect(audio.currentTime).toBe(0) // untouched — paused at 0 means cold
   })

   it("clicks on interactive descendants pass through", () => {
      const { content, audio } = mount("0,5", '<p data-tts="1"><a href="https://e.com/">x</a></p>')
      tick(audio, 1)
      content.querySelector("a")!.dispatchEvent(new Event("click", { bubbles: true }))
      expect(audio.currentTime).toBe(1)
   })
})

describe("re-wiring", () => {
   beforeEach(() => document.body.replaceChildren())

   it("wiring a new article drops the old binding", () => {
      const first = mount("0,5", '<p data-tts="1">a</p>')
      tick(first.audio, 6)
      const second = mount("0,5", '<p data-tts="1">b</p>')
      // Old audio still emits (it was relocated, say) — must not paint the
      // new surface.
      tick(first.audio, 1)
      expect(second.content.querySelector(".srr-tts-current")).toBeNull()
   })

   it("re-wiring an empty surface clears the old binding and classes", () => {
      const first = mount("0,5", '<p data-tts="1">a</p>')
      tick(first.audio, 6)
      expect(first.content.classList.contains("srr-tts-live")).toBe(true)
      const title = document.createElement("h1")
      const content = document.createElement("div")
      document.body.replaceChildren(title, content)
      wireTTS({ title, content }) // no narration audio here
      tick(first.audio, 7) // old audio still playing somewhere (mini-player)
      expect(first.content.classList.contains("srr-tts-live")).toBe(false)
      expect(content.classList.contains("srr-tts-live")).toBe(false)
      expect(document.querySelector(".srr-tts-current")).toBeNull()
   })
})
