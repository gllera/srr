import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// data.ts fires a db.gz fetch at module load, so it is mocked wholesale (the
// house pattern — see app.test.ts / list.test.ts). fmt is mocked only for
// srcColorIndex; urlish and keys are side-effect-free and used for real, which
// is the point of the persisted-src validation tests below.
const data = vi.hoisted(() => ({
   feedTitle: (id: number) => (id === 7 ? "The Daily" : `Feed ${id}`),
   activeStore: () => ({ mid: "0", base: new URL("https://cdn.example/store/") }),
}))
vi.mock("./data", () => data)
vi.mock("./fmt", () => ({
   srcColorIndex: () => 3,
   stampSrc: (n: HTMLElement) => (n.dataset.src = "3"),
   // The REAL bodies: safeSrc's store-base bound is what this suite's persisted
   // -blob cases assert, so a stub would test nothing. Kept byte-equivalent to
   // fmt.ts — a protocol-relative "//host" counts as relative precisely so the
   // bounds check below rejects it.
   isRelative: (v: string) => !/^[a-z][a-z0-9+.-]*:/i.test(v),
   resolvePackRelative: (v: string, base: URL) => {
      try {
         const resolved = new URL(v, base).href
         return resolved.startsWith(base.href) ? resolved : null
      } catch {
         return null
      }
   },
}))
// The chip's long-press menu goes through the shared anchored card; mocking it
// keeps this suite off dropdown's DOM and lets tests invoke item actions. The
// bindPressMenu shim keeps only the contract this suite drives — a contextmenu
// on the anchor opens the freshly-derived items through showContextMenu — while
// the full trigger wiring (touch-hold, click swallow) is dropdown.ts's own.
const dropdown = vi.hoisted(() => {
   const showContextMenu = vi.fn()
   return {
      showContextMenu,
      // The dock's secondary gesture, same contract: a contextmenu runs
      // the act (and a taken gesture keeps the browser's menu away).
      bindSecondaryPress: vi.fn((anchor: HTMLElement, act: () => boolean) => {
         anchor.addEventListener("contextmenu", (e) => {
            if (act()) e.preventDefault()
         })
      }),
      bindPressMenu: vi.fn((anchor: HTMLElement, items: () => unknown[]) => {
         anchor.addEventListener("contextmenu", (e) => {
            const list = items()
            if (list.length > 0) {
               showContextMenu(anchor, list)
               e.preventDefault()
            }
         })
      }),
      // The real four-line factory: the queue rows this suite drives are BUILT
      // from it, so a stub that returned nothing would test an empty panel.
      btn: (className: string, label: string, text: string, onClick: () => void) => {
         const b = document.createElement("button")
         b.type = "button"
         b.className = className
         b.textContent = text
         b.setAttribute("aria-label", label)
         b.addEventListener("click", onClick)
         return b
      },
   }
})
vi.mock("./dropdown", () => dropdown)

const SKELETON = `
   <article class="srr-reader" hidden><div class="srr-content"></div></article>
   <div class="srr-player" tabindex="-1" hidden>
      <div class="srr-player-media"></div>
      <button class="srr-player-expand"></button>
      <div class="srr-player-cover" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
      <div class="srr-player-body">
         <button class="srr-player-title"><span class="srr-player-source"></span><span class="srr-player-name"></span></button>
         <div class="srr-player-seek" role="slider" tabindex="0"><div class="srr-player-seek-fill"></div></div>
         <div class="srr-player-times"><span class="srr-player-time"></span><span class="srr-player-duration"></span></div>
      </div>
      <button class="srr-player-close"></button>
      <div class="srr-player-controls">
         <button class="srr-player-rate"></button>
         <button class="srr-player-prev" hidden></button>
         <button class="srr-player-back"></button>
         <button class="srr-player-toggle"></button>
         <button class="srr-player-fwd"></button>
         <button class="srr-player-next" hidden></button>
      </div>
      <section class="srr-player-upnext">
         <h2>Up next <span class="srr-player-count"></span></h2>
         <div class="srr-player-list" role="list"></div>
         <p class="srr-player-empty"></p>
      </section>
   </div>
   <button class="srr-player-dock" hidden><span class="srr-player-eq"></span></button>`

type Player = typeof import("./player")
let player: Player
const deps = { openArticle: vi.fn(), rememberPosition: vi.fn(), readPosition: vi.fn() }

const q = <T extends Element>(sel: string) => document.querySelector(sel) as T
const bar = () => q<HTMLElement>(".srr-player")
// The playlist's current row ✕ — the one way to drop the current episode
// (the view's own ✕ only hides the view).
const removeNow = () => q<HTMLButtonElement>(".srr-player-row-now .srr-player-row-remove").click()
const content = () => q<HTMLElement>(".srr-content")
const media = () => q<HTMLElement>(".srr-player-media")

// jsdom implements neither play() nor pause(); `paused` is a read-only getter, so
// "playing" is simulated by redefining it on the instance.
const playing = (m: HTMLMediaElement, isPlaying = true) =>
   Object.defineProperty(m, "paused", { value: !isPlaying, writable: true, configurable: true })

const withDuration = (m: HTMLMediaElement, d: number) =>
   Object.defineProperty(m, "duration", { value: d, writable: true, configurable: true })

// Render n <audio> elements into the content host, as sanitizeFragment would.
const putAudio = (n = 1) => {
   content().innerHTML = Array.from({ length: n }, (_, i) => `<audio src="assets/aa/${i}.mp3" controls></audio>`).join(
      "",
   )
   return [...content().querySelectorAll("audio")] as HTMLMediaElement[]
}

const MOUNTED = { mid: "0", chron: 42, title: "Episode 12", feedId: 7 }

// Claim an element the way a real tap does: queue it (the player controls its
// queue only — see "outside media" below), then a `play` event, which player.ts
// catches with a capture-phase document listener (`play` does not bubble).
//
// Into an IDLE player the add alone starts it (startIfIdle), which calls the
// mocked play() — a mock that fires no `play` event, so press() stands in for
// the one a real play() would dispatch. That play() call is the claim's own and
// is cleared, so a test counts only what comes after.
const claim = (m: HTMLMediaElement) => {
   enqueue(m)
   press(m)
   vi.mocked(HTMLMediaElement.prototype.play).mockClear()
}
// An episode already playing, from another article (adopted into the bar):
// adds after this only QUEUE, since just the first add into an idle player plays.
const playElsewhere = () => {
   player.noteMounted({ ...MOUNTED, chron: 99, title: "Elsewhere" })
   claim(putAudio(1)[0])
   player.adoptFromContent()
   player.noteMounted(MOUNTED)
}
// A queue restored at boot with nothing claimed — the READY bar, the one way to
// hold a queue while idle now that the first add plays at once.
const seedQueue = (...entries: { chron: number; title: string }[]) => {
   localStorage.setItem(
      "srr-player",
      JSON.stringify({
         queue: entries.map((e) => ({
            chron: e.chron,
            index: 0,
            src: `assets/aa/${e.chron}.mp3`,
            kind: "audio",
            title: e.title,
            feedId: 7,
         })),
      }),
   )
   player.restorePersisted()
}
// A bare press of play — no queueing.
const press = (m: HTMLMediaElement) => {
   playing(m)
   m.dispatchEvent(new Event("play"))
}
// Queue an in-content element through its own chip, as the user does.
const enqueue = (m: HTMLMediaElement) => {
   player.injectQueueChips()
   const chip = m.nextElementSibling as HTMLButtonElement
   if (chip.getAttribute("aria-pressed") !== "true") chip.click()
}

beforeEach(async () => {
   document.body.innerHTML = SKELETON
   document.body.className = ""
   // The skeleton mirrors index.html, where the reader starts hidden; showReader()
   // is what reveals it, and the reader IS the surface you press play on.
   q<HTMLElement>(".srr-reader").hidden = false
   localStorage.clear()
   HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
   HTMLMediaElement.prototype.pause = vi.fn()
   HTMLMediaElement.prototype.load = vi.fn()
   // jsdom has no Element.scrollTo (every browser does); the playlist's
   // follow-the-current-episode scroll calls it.
   Element.prototype.scrollTo = vi.fn()
   vi.resetModules()
   player = await import("./player")
   deps.openArticle.mockClear()
   deps.rememberPosition.mockClear()
   deps.readPosition.mockReset() // default: no remembered position
   dropdown.showContextMenu.mockClear()
   player.setup(deps)
   player.noteMounted(MOUNTED)
})

// The long-press/right-click menu's item list, as handed to the (mocked) card.
type ChipMenuItem = { label: string; action: () => void; disabled?: boolean }
const menuItems = (call = 0) => dropdown.showContextMenu.mock.calls[call][1] as ChipMenuItem[]

describe("claiming an episode", () => {
   it("claims a played in-content element and labels the bar from the mounted article", () => {
      const [m] = putAudio()
      claim(m)
      expect(player.isActive()).toBe(true)
      expect(q(".srr-player-source").textContent).toBe("The Daily")
      expect(q(".srr-player-name").textContent).toBe("Episode 12")
      expect(bar().dataset.src).toBe("3")
   })

   it("shows even while its own article is on screen — the bar ignores what you are reading", () => {
      const [m] = putAudio()
      claim(m)
      // Claimed in place: the element stays in the prose, the bar shows anyway.
      expect(content().contains(m)).toBe(true)
      expect(bar().hidden).toBe(false)
      // Folded: the dock (the corner circle) shows it, with the page clearance
      // that keeps it off the last line of text.
      expect(q<HTMLElement>(".srr-player-dock").hidden).toBe(false)
      expect(document.body.classList.contains("srr-playing")).toBe(true)
   })

   it("shows once the article surface is hidden behind the list", () => {
      const [m] = putAudio()
      claim(m)
      q<HTMLElement>(".srr-reader").hidden = true
      // Re-sync happens on any media event; a pause is the cheapest.
      m.dispatchEvent(new Event("pause"))
      expect(bar().hidden).toBe(false)
      // Folded: the dock (the corner circle) shows it, with the page clearance
      // that keeps it off the last line of text.
      expect(q<HTMLElement>(".srr-player-dock").hidden).toBe(false)
      expect(document.body.classList.contains("srr-playing")).toBe(true)
   })

   it("opens as a whole VIEW from the dock, and ⌄ closes it back to the dock", () => {
      const [m] = putAudio()
      claim(m)
      q<HTMLElement>(".srr-reader").hidden = true
      m.dispatchEvent(new Event("pause"))
      const dock = q<HTMLButtonElement>(".srr-player-dock")
      // Folded: the view is invisible (a class — never the hidden attribute,
      // it may hold a relocated video) and the dock stands in for it.
      expect(bar().hidden).toBe(false)
      expect(bar().classList.contains("srr-player-folded")).toBe(true)
      expect(player.isViewOpen()).toBe(false)
      dock.click()
      expect(player.isViewOpen()).toBe(true)
      expect(bar().classList.contains("srr-player-folded")).toBe(false)
      expect(dock.hidden).toBe(true) // the view is up; nothing floats on it
      expect(document.activeElement).toBe(bar()) // Escape lands in the view
      q<HTMLButtonElement>(".srr-player-close").click() // ✕ hides
      expect(player.isViewOpen()).toBe(false)
      expect(player.isActive()).toBe(true) // …hiding stops nothing
      expect(bar().classList.contains("srr-player-folded")).toBe(true)
      expect(dock.hidden).toBe(false)
      expect(document.activeElement).toBe(dock) // focus followed the close
   })

   it("the platform's Back closes the view — opening pushes one history entry", () => {
      const [m] = putAudio()
      claim(m)
      const depth = history.length
      player.closeView() // a no-op while closed
      q<HTMLButtonElement>(".srr-player-dock").click() // open
      expect(history.length).toBe(depth + 1)
      expect((history.state as Record<string, unknown>).srrPlayer).toBe(true)
      // Back: the browser pops our entry and fires popstate.
      history.replaceState(null, "")
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }))
      expect(player.isViewOpen()).toBe(false)
   })

   it("the dock IS the folded player: shown with it, the view on tap, play/pause on hold", () => {
      const dock = q<HTMLButtonElement>(".srr-player-dock")
      expect(dock.hidden).toBe(true) // no player, no dock
      const [m] = putAudio()
      claim(m)
      expect(dock.hidden).toBe(false)
      expect(dock.getAttribute("aria-label")).toBe("Open the player — Episode 12")
      expect(dock.classList.contains("srr-player-playing")).toBe(true) // its bars move
      // The secondary gesture plays / pauses — the element's own transport.
      dock.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
      expect(player.isViewOpen()).toBe(false) // …without opening anything
      playing(m, false)
      m.dispatchEvent(new Event("pause"))
      expect(dock.classList.contains("srr-player-playing")).toBe(false)
      expect(dock.getAttribute("aria-label")).toBe("Open the player — Episode 12, paused")
      // Its progress ring follows the clock.
      withDuration(m, 100)
      m.currentTime = 25
      m.dispatchEvent(new Event("timeupdate"))
      expect(dock.style.getPropertyValue("--srr-progress")).toBe("25")
      // Emptying the playlist (here: just the episode playing) takes the
      // player — and the dock — away.
      removeNow()
      expect(dock.hidden).toBe(true)
   })

   it("only the floating dock claims the page's bottom clearance — the open view covers the page", () => {
      const [m] = putAudio()
      claim(m)
      expect(document.body.classList.contains("srr-playing")).toBe(true)
      q<HTMLButtonElement>(".srr-player-dock").click()
      expect(document.body.classList.contains("srr-playing")).toBe(false)
   })

   it("✕ only HIDES: the episode keeps playing and the dock stays until the playlist is empty", () => {
      const [a] = putAudio(2)
      claim(a)
      q<HTMLButtonElement>(".srr-player-dock").click()
      ;(content().querySelectorAll(".srr-queue-chip")[1] as HTMLButtonElement).click() // queue b
      q<HTMLButtonElement>(".srr-player-close").click()
      const dock = q<HTMLButtonElement>(".srr-player-dock")
      expect(player.isViewOpen()).toBe(false)
      expect(player.isActive()).toBe(true)
      // Nothing in THIS document was paused (earlier tests' module instances
      // keep their capture listeners and pause their own detached elements).
      const pausedHere = (HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mock.contexts.filter(
         (el) => (el as Node).isConnected,
      )
      expect(pausedHere).toHaveLength(0)
      expect(dock.hidden).toBe(false)
      // Remove the episode playing now: the queued one waits, READY — never
      // starting by itself — and the dock stays for it.
      removeNow()
      expect(player.isActive()).toBe(false)
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
      expect(dock.hidden).toBe(false)
      expect(q(".srr-player-name").textContent).toBe("Episode 12") // the READY head
      // Remove the last queued row: the playlist is empty — the dock goes.
      q<HTMLButtonElement>(".srr-player-list .srr-player-row-remove").click()
      expect(dock.hidden).toBe(true)
      expect(bar().hidden).toBe(true)
   })

   it("ignores the GIF idiom — muted+loop+autoplay video must not hijack the transport", () => {
      // #embed / srr-x emit these for what used to be a GIF; they fire `play` on
      // their own the moment they render.
      content().innerHTML = `<video src="a.webm" autoplay muted loop></video>`
      const v = content().querySelector("video") as HTMLMediaElement
      press(v)
      expect(player.isActive()).toBe(false)
   })

   it("ignores media outside the content host", () => {
      const stray = document.createElement("audio")
      document.body.appendChild(stray)
      press(stray)
      expect(player.isActive()).toBe(false)
   })

   it("does not claim when no article is mounted (an empty state)", () => {
      const [m] = putAudio()
      player.noteMounted(null)
      press(m)
      expect(player.isActive()).toBe(false)
   })

   it("leaves an UNQUEUED in-content element alone — the player controls its queue only", () => {
      const [m] = putAudio()
      press(m)
      expect(player.isActive()).toBe(false)
      q<HTMLElement>(".srr-reader").hidden = true
      m.dispatchEvent(new Event("pause"))
      expect(bar().hidden).toBe(true)
      // Navigating away does not adopt it: it is the article's, not the player's.
      player.adoptFromContent()
      expect(media().children).toHaveLength(0)
   })

   // The elements pause() was called on in THIS test's document: every earlier
   // test's module instance (vi.resetModules) still holds its capture listener
   // on `document`, and pauses its own long-detached elements.
   const pausedHere = () =>
      (HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mock.contexts.filter(
         (m) => (m as Node).isConnected,
      )

   it("outside media playing pauses the episode — one thing audible at a time", () => {
      const [ep, other] = putAudio(2)
      claim(ep)
      press(other)
      expect(pausedHere()).toEqual([ep])
      // Still the player's episode, paused and one tap from resuming.
      expect(player.isActive()).toBe(true)
   })

   it("the episode (re)starting pauses outside media still playing", () => {
      const [ep, other] = putAudio(2)
      claim(ep)
      playing(ep, false)
      press(other)
      ;(HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mockClear()
      press(ep)
      expect(pausedHere()).toEqual([other])
   })

   it("evicts an ADOPTED episode from the bar when a second one is claimed", () => {
      // Otherwise the first node stays in the host still playing, orphaned behind
      // the new episode's chrome — two things audible at once.
      const [first] = putAudio()
      claim(first)
      player.adoptFromContent()
      expect(first.parentElement).toBe(media())

      // A different article, a different episode.
      player.noteMounted({ ...MOUNTED, chron: 43, title: "Episode 13" })
      const [second] = putAudio()
      claim(second)

      expect(first.parentElement).toBeNull()
      expect(first.pause).toHaveBeenCalled()
      expect(media().children).toHaveLength(0)
      expect(q(".srr-player-name").textContent).toBe("Episode 13")
   })

   it("hands the previous episode's position to FEB2 when a second one is claimed", () => {
      const [a, b] = putAudio(2)
      claim(a)
      a.currentTime = 30
      claim(b)
      expect(deps.rememberPosition).toHaveBeenCalledWith("0", 42, 0, { time: 30, rate: 1 })
   })
})

describe("relocation", () => {
   it("adoptFromContent MOVES the live node into the bar and drops its controls", () => {
      const [m] = putAudio()
      claim(m)
      player.adoptFromContent()
      // Same node, new parent — this is what keeps playback alive.
      expect(m.parentElement).toBe(media())
      expect(m.hasAttribute("controls")).toBe(false)
      expect(bar().hidden).toBe(false)
   })

   it("rehomeInto swaps the live node back in at its own index", () => {
      const [, second] = putAudio(2)
      claim(second)
      second.currentTime = 12.5
      player.adoptFromContent()
      // The article re-renders: two FRESH elements, neither of them the live one.
      const fresh = putAudio(2)
      player.rehomeInto("0", 42)
      const now = [...content().querySelectorAll("audio")]
      expect(now[1]).toBe(second) // the live node, at its original index
      expect(now).toHaveLength(2)
      expect(fresh[1].parentElement).toBeNull() // the fresh stand-in was replaced
      expect(second.currentTime).toBe(12.5) // and it kept its position
      expect(second.hasAttribute("controls")).toBe(true) // fmt.ts forces these in content
   })

   it("rehomeInto ignores a different article", () => {
      const [m] = putAudio()
      claim(m)
      player.adoptFromContent()
      putAudio(1)
      player.rehomeInto("0", 43)
      expect(m.parentElement).toBe(media())
   })

   it("rehomeInto ignores the same chron in a DIFFERENT store (chron is per-mount)", () => {
      const [m] = putAudio()
      claim(m)
      player.adoptFromContent()
      putAudio(1)
      player.rehomeInto("s3f9a1c22", 42)
      expect(m.parentElement).toBe(media())
   })

   it("keeps playing in the bar when the article no longer renders media at that index", () => {
      const [, second] = putAudio(2)
      claim(second)
      player.adoptFromContent()
      putAudio(1) // a compacted payload, or a changed pipeline
      player.rehomeInto("0", 42)
      expect(second.parentElement).toBe(media())
      expect(bar().hidden).toBe(false)
   })

   it("adoptFromContent is a no-op with nothing claimed", () => {
      putAudio()
      expect(() => player.adoptFromContent()).not.toThrow()
      expect(media().children).toHaveLength(0)
   })
})

describe("transport", () => {
   it("removing the episode playing now pauses it, hands the position back to FEB2 and drops it", () => {
      const [m] = putAudio()
      claim(m)
      m.currentTime = 61
      m.dispatchEvent(new Event("pause")) // persists it as the blob's head
      expect(localStorage.getItem("srr-player")).not.toBeNull()
      player.adoptFromContent()
      removeNow()
      // …and a reload must not bring it back.
      expect(localStorage.getItem("srr-player")).toBeNull()
      expect(m.pause).toHaveBeenCalled()
      expect(deps.rememberPosition).toHaveBeenCalledWith("0", 42, 0, { time: 61, rate: 1 })
      expect(player.isActive()).toBe(false)
      expect(bar().hidden).toBe(true)
      expect(media().children).toHaveLength(0) // the adopted node is discarded
   })

   it("±10s seeks without running past the ends", () => {
      const [m] = putAudio()
      withDuration(m, 100)
      claim(m)
      m.currentTime = 20
      q<HTMLButtonElement>(".srr-player-fwd").click()
      expect(m.currentTime).toBe(30)
      q<HTMLButtonElement>(".srr-player-back").click()
      expect(m.currentTime).toBe(20)
      m.currentTime = 5
      q<HTMLButtonElement>(".srr-player-back").click()
      expect(m.currentTime).toBe(0) // clamped, not negative
      m.currentTime = 95
      q<HTMLButtonElement>(".srr-player-fwd").click()
      expect(m.currentTime).toBe(100) // clamped to duration
   })

   it("cycles the speed ladder and persists it as a device preference", () => {
      const [m] = putAudio()
      claim(m)
      const rate = q<HTMLButtonElement>(".srr-player-rate")
      rate.click()
      expect(m.playbackRate).toBe(1.25)
      expect(localStorage.getItem("srr-player-rate")).toBe("1.25")
      expect(rate.textContent).toBe("1.25×")
      rate.click()
      rate.click()
      expect(m.playbackRate).toBe(2)
      rate.click()
      expect(m.playbackRate).toBe(1) // wraps back to normal
   })

   it("applies a stored speed on claim, but leaves an untouched element alone at 1", () => {
      localStorage.setItem("srr-player-rate", "1.5")
      claim(putAudio()[0])
      expect(q<HTMLMediaElement>(".srr-content audio").playbackRate).toBe(1.5)
   })

   it("does not reset a FEB2-restored rate when no preference was ever set", () => {
      const [m] = putAudio()
      m.playbackRate = 1.25 // what restoreMediaState would have applied
      claim(m)
      expect(m.playbackRate).toBe(1.25)
   })

   it("a finished episode at the end of the list stops — and STAYS listed, no longer the blob's head", () => {
      const [m] = putAudio()
      claim(m)
      m.currentTime = 30
      m.dispatchEvent(new Event("pause")) // writes the entry as the blob's head
      expect(JSON.parse(localStorage.getItem("srr-player") as string).time).toBe(30)
      m.dispatchEvent(new Event("ended"))
      expect(player.isActive()).toBe(false)
      // Entries stay after they play: the player keeps showing it (READY).
      expect(bar().hidden).toBe(false)
      const saved = JSON.parse(localStorage.getItem("srr-player") as string)
      expect(saved.time).toBeUndefined() // nothing left to resume
      expect(saved.queue).toHaveLength(1)
   })

   it("an unplayable episode dismisses quietly after its one retry (old articles outlive their media hosts)", () => {
      const [m] = putAudio()
      claim(m)
      m.dispatchEvent(new Event("error"))
      expect(player.isActive()).toBe(true) // first error: retrying, not dead yet
      m.dispatchEvent(new Event("error"))
      expect(player.isActive()).toBe(false)
      // The dead entry stays listed — removing it is the listener's call.
      expect(bar().hidden).toBe(false)
   })

   it("the title button routes back to the episode's own article", () => {
      claim(putAudio()[0])
      q<HTMLButtonElement>(".srr-player-title").click()
      expect(deps.openArticle).toHaveBeenCalledWith("0", 42)
   })
})

describe("persistence", () => {
   it("the READY cursor survives a reload — the play button starts where you left off", () => {
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            queue: [
               { chron: 43, index: 0, src: "assets/aa/43.mp3", kind: "audio", title: "Played one", feedId: 7 },
               { chron: 44, index: 0, src: "assets/aa/44.mp3", kind: "audio", title: "Next one", feedId: 7 },
            ],
            c: 1,
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(false)
      expect(q(".srr-player-name").textContent).toBe("Next one")
      const rows = [...document.querySelectorAll(".srr-player-row")]
      expect(rows[1].classList.contains("srr-player-row-now")).toBe(true)
      expect(rows[0].classList.contains("srr-player-row-played")).toBe(true)
      // …and it is written back as it was read.
      expect(JSON.parse(localStorage.getItem("srr-player") as string).c).toBe(1)
   })

   it("a blob from before played entries stayed keeps its episode: the head goes back to the front", () => {
      // The old model held the interrupted episode OUTSIDE its queue.
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            chron: 43,
            index: 0,
            time: 75,
            rate: 1,
            src: "assets/aa/43.mp3",
            kind: "audio",
            title: "Interrupted",
            feedId: 7,
            queue: [{ chron: 44, index: 0, src: "assets/aa/44.mp3", kind: "audio", title: "Queued", feedId: 7 }],
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(true)
      const names = [...document.querySelectorAll(".srr-player-row-name")].map((n) => n.textContent)
      expect(names).toEqual(["Interrupted", "Queued"])
      expect(document.querySelectorAll(".srr-player-row")[0].classList.contains("srr-player-row-now")).toBe(true)
   })

   it("writes a mid-qualified entry carrying enough to render with no pack fetch", () => {
      const [m] = putAudio()
      claim(m)
      m.currentTime = 90
      m.dispatchEvent(new Event("pause"))
      const saved = JSON.parse(localStorage.getItem("srr-player") as string)
      expect(saved).toMatchObject({
         chron: 42,
         index: 0,
         time: 90,
         kind: "audio",
         title: "Episode 12",
         feedId: 7,
         src: "assets/aa/0.mp3",
      })
   })

   it("restores into a PAUSED bar, seeking once metadata lands — never autoplaying", () => {
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            chron: 42,
            index: 0,
            time: 75,
            rate: 1,
            src: "assets/aa/0.mp3",
            kind: "audio",
            title: "Episode 12",
            feedId: 7,
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(true)
      const m = media().querySelector("audio") as HTMLMediaElement
      expect(m).toBeTruthy()
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
      // currentTime is only settable once duration is known (the FEB2 pattern).
      m.dispatchEvent(new Event("loadedmetadata"))
      expect(m.currentTime).toBe(75)
      expect(m.src).toBe("https://cdn.example/store/assets/aa/0.mp3")
   })

   it("claims the article's OWN element when the persisted episode is the mounted article", () => {
      // The normal case, not an exotic one: `srr-hash` restores the last reading
      // position, so closing the tab mid-episode boots straight back into that
      // article — reader.ts renders its <audio> and THEN app.ts calls this.
      // Building a second element here gives one episode two transports and lets
      // a later rehomeInto substitute the synthetic node for the sanitized one.
      const [live] = putAudio()
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            chron: 42, // === MOUNTED.chron
            index: 0,
            time: 75,
            rate: 1,
            src: "assets/aa/0.mp3",
            kind: "audio",
            title: "Episode 12",
            feedId: 7,
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(true)
      // No second element anywhere, and the claim is the node already on screen.
      expect(media().children.length).toBe(0)
      expect(content().querySelectorAll("audio").length).toBe(1)
      expect(content().querySelector("audio")).toBe(live)
      // The bar shows regardless of what is on screen.
      expect(bar().hidden).toBe(false)
      // Still seeks, and still never autoplays.
      live.dispatchEvent(new Event("loadedmetadata"))
      expect(live.currentTime).toBe(75)
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
      // And it is genuinely the claimed episode: adopting relocates THIS node.
      player.adoptFromContent()
      expect(media().firstElementChild).toBe(live)
   })

   it("a re-claimed element keeps the sanitizer's attributes across adopt -> rehome", () => {
      // The second-order cost of a synthetic element: rehomeInto swaps
      // active.media in for the freshly parsed one, so a stripped stand-in would
      // permanently replace the real element — losing the playsinline/poster
      // fmt.ts force-sets (on iOS, losing playsinline means fullscreen takeover).
      content().innerHTML = `<video src="assets/aa/0.webm" controls playsinline poster="assets/aa/p.jpg"></video>`
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            chron: 42,
            index: 0,
            time: 5,
            rate: 1,
            src: "assets/aa/0.webm",
            kind: "video",
            title: "Episode 12",
            feedId: 7,
         }),
      )
      player.restorePersisted()
      player.adoptFromContent()
      // A fresh render of the same article, then the rehome.
      content().innerHTML = `<video src="assets/aa/0.webm" controls playsinline poster="assets/aa/p.jpg"></video>`
      player.rehomeInto("0", 42)
      const back = content().querySelector("video") as HTMLVideoElement
      expect(content().querySelectorAll("video").length).toBe(1)
      expect(back.hasAttribute("playsinline")).toBe(true)
      expect(back.getAttribute("poster")).toBe("assets/aa/p.jpg")
      expect(back.hasAttribute("controls")).toBe(true)
   })

   it("a SYNTHETIC restore also keeps the sanitizer's attributes on rehome", () => {
      // The twin of the case above, on the path that still builds an element:
      // the persisted episode's article is NOT the one on screen, so restore
      // constructs a stand-in with none of fmt.ts's forced attributes. Walking
      // to that article later runs rehomeInto, whose replaceWith installs the
      // stand-in permanently — so the attributes have to be carried across.
      const OTHER = 99 // != MOUNTED.chron, so the claimed-element path is not taken
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            chron: OTHER,
            index: 0,
            time: 5,
            rate: 1,
            src: "assets/aa/0.webm",
            kind: "video",
            title: "Episode 99",
            feedId: 7,
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(true)
      // It really is synthetic: held by the bar, not by any article.
      expect(media().querySelector("video")).toBeTruthy()

      // Now walk to the owning article, freshly rendered by the sanitizer.
      player.noteMounted({ ...MOUNTED, chron: OTHER, title: "Episode 99" })
      content().innerHTML = `<video src="assets/aa/0.webm" controls playsinline poster="assets/aa/p.jpg"></video>`
      player.rehomeInto("0", OTHER)

      const back = content().querySelector("video") as HTMLVideoElement
      expect(content().querySelectorAll("video").length).toBe(1)
      expect(back.hasAttribute("playsinline")).toBe(true)
      expect(back.getAttribute("poster")).toBe("assets/aa/p.jpg")
      expect(back.hasAttribute("controls")).toBe(true)
   })

   it("restores a video as a <video>", () => {
      localStorage.setItem(
         "srr-player",
         JSON.stringify({ chron: 1, index: 0, time: 5, rate: 1, src: "a.webm", kind: "video", title: "V", feedId: 1 }),
      )
      player.restorePersisted()
      expect(media().querySelector("video")).toBeTruthy()
   })

   it("the video thumbnail's button takes the video full screen, with native controls only while there", async () => {
      localStorage.setItem(
         "srr-player",
         JSON.stringify({ chron: 1, index: 0, time: 5, rate: 1, src: "a.webm", kind: "video", title: "V", feedId: 1 }),
      )
      player.restorePersisted()
      const v = media().querySelector("video") as HTMLVideoElement
      expect(v.hasAttribute("controls")).toBe(false) // the view's transport drives it
      const request = vi.fn(() => Promise.resolve())
      Object.defineProperty(v, "requestFullscreen", { value: request, configurable: true })
      q<HTMLButtonElement>(".srr-player-expand").click()
      expect(request).toHaveBeenCalledTimes(1)
      expect(v.hasAttribute("controls")).toBe(true)
      // Back from full screen: the native controls go again.
      document.dispatchEvent(new Event("fullscreenchange"))
      expect(v.hasAttribute("controls")).toBe(false)
      // A refused request (no user activation, a policy) leaves no controls behind.
      Object.defineProperty(v, "requestFullscreen", {
         value: () => Promise.reject(new Error("denied")),
         configurable: true,
      })
      q<HTMLButtonElement>(".srr-player-expand").click()
      await Promise.resolve()
      await Promise.resolve()
      expect(v.hasAttribute("controls")).toBe(false)
   })

   it("REJECTS a hostile persisted src — localStorage is untrusted input", () => {
      for (const src of ["javascript:alert(1)", "data:audio/mp3;base64,AAAA", "vbscript:x", "file:///etc/passwd"]) {
         localStorage.setItem(
            "srr-player",
            JSON.stringify({ chron: 1, index: 0, time: 5, rate: 1, src, kind: "audio", title: "x", feedId: 1 }),
         )
         player.restorePersisted()
         expect(player.isActive()).toBe(false)
         expect(localStorage.getItem("srr-player")).toBeNull() // and the entry is dropped
      }
   })

   it("REJECTS a relative src that escapes the store base", () => {
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            chron: 1,
            index: 0,
            time: 5,
            rate: 1,
            src: "../../elsewhere/x.mp3",
            kind: "audio",
            title: "x",
            feedId: 1,
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(false)
   })

   it("keeps an absolute http(s) src (whatever the feed carried)", () => {
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            chron: 1,
            index: 0,
            time: 5,
            rate: 1,
            src: "https://cdn.podcast.example/ep.mp3",
            kind: "audio",
            title: "x",
            feedId: 1,
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(true)
   })

   it("ignores a never-played entry and a malformed one", () => {
      localStorage.setItem("srr-player", "{not json")
      player.restorePersisted()
      expect(player.isActive()).toBe(false)
      localStorage.setItem(
         "srr-player",
         JSON.stringify({ chron: 1, index: 0, time: 0, rate: 1, src: "a.mp3", kind: "audio", title: "x", feedId: 1 }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(false)
   })
})

describe("playlist", () => {
   const chips = () => [...content().querySelectorAll<HTMLButtonElement>(".srr-queue-chip")]
   // How many are QUEUED (the playlist's rows minus the current one); "" for none.
   // The visible heading count also includes the episode playing now.
   const count = () => {
      const n = document.querySelectorAll(".srr-player-list .srr-player-row:not(.srr-player-row-now)").length
      return n ? String(n) : ""
   }
   // The Up next list lives in the full player, only reachable UNFOLDED.
   beforeEach(() => q<HTMLButtonElement>(".srr-player-dock").click())

   it("injects a toggle chip per eligible element, skipping the GIF idiom and srcless media", () => {
      content().innerHTML =
         `<audio src="assets/aa/0.mp3" controls></audio>` +
         `<video src="a.webm" autoplay muted loop></video>` + // GIF idiom — a decoration must not enter a playlist
         `<video controls><source src="s.webm"></video>` + // <source>-only — not rebuildable detached
         `<audio src="assets/aa/1.mp3" controls></audio>`
      player.injectQueueChips()
      expect(chips()).toHaveLength(2)
      expect(chips()[0].getAttribute("aria-pressed")).toBe("false")
      // Idempotent: the rehome path re-derives the existing chip, never doubles it.
      player.injectQueueChips()
      expect(chips()).toHaveLength(2)
   })

   it("chips read the live playlist position and renumber when an earlier entry leaves", () => {
      playElsewhere() // position 1: the episode playing elsewhere
      putAudio(2)
      player.injectQueueChips()
      expect(chips()[0].textContent).toBe("+")
      chips()[0].click()
      chips()[1].click()
      expect(chips()[0].textContent).toBe("2")
      expect(chips()[1].textContent).toBe("3")
      expect(chips()[1].getAttribute("aria-label")).toBe("Remove from playlist — position 3")
      // Unqueue the first — the second renumbers through the chips effect.
      chips()[0].click()
      expect(chips()[0].textContent).toBe("+")
      expect(chips()[1].textContent).toBe("2")
   })

   it("a full playlist turns spare chips into the ≡ door, whose tap opens the player instead of adding", () => {
      playElsewhere() // one entry already
      putAudio(50)
      player.injectQueueChips()
      for (const chip of chips().slice(0, 49)) chip.click() // 50 entries: the cap
      const spare = chips()[49]
      expect(spare.textContent).toBe("≡")
      expect(spare.getAttribute("aria-pressed")).toBe("false")
      expect(spare.getAttribute("aria-label")).toBe("Playlist full — open playlist")
      // Listed chips stay live toggles — removal must always work at the cap.
      expect(chips()[0].textContent).toBe("2")
      q<HTMLButtonElement>(".srr-player-close").click() // hide, so the door has something to open
      spare.click()
      expect(bar().classList.contains("srr-player-folded")).toBe(false)
      const saved = JSON.parse(localStorage.getItem("srr-player") as string)
      expect(saved.queue).toHaveLength(50)
   })

   it("long-press menu: Play next puts the enclosure right AFTER the current entry, moving a listed one", () => {
      playElsewhere() // current, position 1
      putAudio(3)
      player.injectQueueChips()
      chips()[0].click()
      chips()[1].click()
      // Right-click the third (unlisted) chip and take Play next.
      chips()[2].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
      expect(dropdown.showContextMenu).toHaveBeenCalledTimes(1)
      expect(dropdown.showContextMenu.mock.calls[0][0]).toBe(chips()[2])
      expect(menuItems().map((i) => i.label)).toEqual(["Play next", "Play now"])
      menuItems()[0].action()
      expect(chips()[2].textContent).toBe("2") // right after the current one
      expect(chips()[0].textContent).toBe("3")
      expect(chips()[1].textContent).toBe("4")
      // A LISTED entry moves there rather than duplicating.
      chips()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
      menuItems(1)[0].action()
      expect(chips()[1].textContent).toBe("2")
      expect(chips()[2].textContent).toBe("3")
      expect(chips()[0].textContent).toBe("4")
      const saved = JSON.parse(localStorage.getItem("srr-player") as string)
      expect(saved.queue).toHaveLength(4)
   })

   it("long-press menu: Play now plays the enclosure through the playlist — it joins it, after the current one", () => {
      playElsewhere()
      putAudio(2)
      player.injectQueueChips()
      chips()[0].click()
      chips()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
      menuItems()[1].action()
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
      expect(player.isActive()).toBe(true)
      expect(chips()[1].textContent).toBe("2") // inserted after the one that was playing
      expect(chips()[0].textContent).toBe("3")
      const saved = JSON.parse(localStorage.getItem("srr-player") as string)
      expect(saved.queue).toHaveLength(3)
   })

   it("at the cap the menu disables both verbs for a NEW enclosure — a listed one still plays now", () => {
      playElsewhere()
      putAudio(50)
      player.injectQueueChips()
      for (const chip of chips().slice(0, 49)) chip.click()
      chips()[49].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
      expect(menuItems()[0].disabled).toBe(true)
      expect(menuItems()[1].disabled).toBe(true)
      chips()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
      expect(menuItems(1)[1].disabled).toBe(false)
   })

   it("queueKey (the p key) toggles the article's first enclosure", () => {
      playElsewhere()
      putAudio(2)
      player.injectQueueChips()
      player.queueKey()
      expect(chips()[0].getAttribute("aria-pressed")).toBe("true")
      expect(chips()[1].getAttribute("aria-pressed")).toBe("false")
      player.queueKey()
      expect(chips()[0].getAttribute("aria-pressed")).toBe("false")
   })

   // "First" means first as the reader SEES it: media whose bytes are gone is
   // collapsed (.srr-broken) and takes its chip with it, so keying DOM order
   // would queue an invisible dead enclosure ahead of the playable one below.
   it("queueKey skips an enclosure whose media is broken", () => {
      playElsewhere()
      putAudio(2)
      player.injectQueueChips()
      content().querySelectorAll("audio")[0].classList.add("srr-broken")
      player.queueKey()
      expect(chips()[0].getAttribute("aria-pressed")).toBe("false")
      expect(chips()[1].getAttribute("aria-pressed")).toBe("true")
   })

   // CSS anchor positioning resolves a name to the LAST element carrying it in
   // tree order, NOT the nearest preceding one — a shared name put every corner
   // chip on the last video's corner (measured in Chrome: three chips, one
   // position). The names have to be minted per pair, and only JS can do that.
   it("gives each video/chip pair its own anchor name", () => {
      content().innerHTML = `<video src="a.webm"></video><video src="b.webm"></video>`
      player.injectQueueChips()
      const vids = [...content().querySelectorAll("video")]
      const cs = chips()
      expect(vids[0].style.getPropertyValue("anchor-name")).toBe("--srr-qmedia-0")
      expect(vids[1].style.getPropertyValue("anchor-name")).toBe("--srr-qmedia-1")
      expect(cs[0].style.getPropertyValue("position-anchor")).toBe("--srr-qmedia-0")
      expect(cs[1].style.getPropertyValue("position-anchor")).toBe("--srr-qmedia-1")
      // Audio chips are in normal flow — nothing to anchor.
      content().innerHTML = `<audio src="a.mp3"></audio>`
      player.injectQueueChips()
      expect(content().querySelector("audio")!.style.getPropertyValue("anchor-name")).toBe("")
   })

   it("a video's corner chip goes offstage while the video plays and returns on pause", () => {
      content().innerHTML = `<video src="v.webm" controls></video>`
      player.injectQueueChips()
      const chip = chips()[0]
      expect(chip.classList.contains("srr-chip-offstage")).toBe(false)
      const v = content().querySelector("video") as HTMLMediaElement
      playing(v)
      v.dispatchEvent(new Event("play"))
      expect(chip.classList.contains("srr-chip-offstage")).toBe(true)
      playing(v, false)
      v.dispatchEvent(new Event("pause"))
      expect(chip.classList.contains("srr-chip-offstage")).toBe(false)
   })

   it("the FIRST add into an idle player plays it at once", () => {
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
      expect(player.isActive()).toBe(true)
      // Claimed in place (its article is on screen) — and it STAYS listed, as
      // the current entry.
      expect(media().children).toHaveLength(0)
      expect(chips()[0].getAttribute("aria-pressed")).toBe("true")
      expect(chips()[0].textContent).toBe("1")
      expect(document.querySelectorAll(".srr-player-row-now")).toHaveLength(1)
   })

   it("an add behind a playing episode only queues", () => {
      playElsewhere()
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
      expect(chips()[0].getAttribute("aria-pressed")).toBe("true")
      expect(count()).toBe("1")
   })

   it("an add to a restored READY queue only queues — it is not the first", () => {
      seedQueue({ chron: 43, title: "Episode 13" })
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
      expect(player.isActive()).toBe(false)
      expect(count()).toBe("2")
      expect(q(".srr-player-name").textContent).toBe("Episode 13") // still the head
   })

   it("the ready bar's play button claims the head IN PLACE when its article is on screen", () => {
      putAudio(1)
      player.injectQueueChips()
      seedQueue({ chron: 42, title: "Episode 12" })
      expect(bar().hidden).toBe(false)
      expect(q(".srr-player-name").textContent).toBe("Episode 12")
      q<HTMLButtonElement>(".srr-player-toggle").click()
      expect(player.isActive()).toBe(true)
      expect(media().children).toHaveLength(0) // no second element
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
      // It stays listed — now the current entry.
      expect(chips()[0].getAttribute("aria-pressed")).toBe("true")
      expect(document.querySelectorAll(".srr-player-row-now")).toHaveLength(1)
   })

   it("ended advances to the next entry — another article's, built detached in the player", () => {
      // A playlist of article 42's episode, then article 43's…
      seedQueue({ chron: 42, title: "Episode 12" }, { chron: 43, title: "Episode 13" })
      // …with 42 on screen and played.
      const [m] = putAudio(1)
      player.injectQueueChips()
      claim(m)
      m.dispatchEvent(new Event("ended"))
      expect(player.isActive()).toBe(true)
      const built = media().querySelector("audio") as HTMLAudioElement
      expect(built).toBeTruthy()
      expect(built.src).toBe("https://cdn.example/store/assets/aa/43.mp3")
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
      expect(q(".srr-player-name").textContent).toBe("Episode 13")
      expect(bar().hidden).toBe(false)
      // Nothing was consumed: 42 stays, marked played, above the current 43.
      expect(document.querySelectorAll(".srr-player-row")).toHaveLength(2)
      expect(document.querySelectorAll(".srr-player-row-played")).toHaveLength(1)
   })

   it("ended advances to a same-article entry by claiming it in place", () => {
      const [a] = putAudio(2)
      claim(a)
      chips()[1].click()
      a.dispatchEvent(new Event("ended"))
      expect(player.isActive()).toBe(true)
      expect(media().children).toHaveLength(0)
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
      // The finished one stays, played; the second is current.
      expect(document.querySelectorAll(".srr-player-row-played")).toHaveLength(1)
      expect(chips()[0].getAttribute("aria-pressed")).toBe("true")
   })

   it("an erroring episode skips to the next queued entry once its retry is spent", () => {
      const [a] = putAudio(2)
      claim(a)
      chips()[1].click()
      a.dispatchEvent(new Event("error")) // first: retry in place, nothing skipped
      expect(count()).not.toBe("")
      a.dispatchEvent(new Event("error")) // second: give up, advance
      expect(player.isActive()).toBe(true)
      // The dead entry stays listed (played); the next one is current.
      expect(document.querySelectorAll(".srr-player-row")).toHaveLength(2)
      expect(document.querySelectorAll(".srr-player-row-played")).toHaveLength(1)
   })

   it("pressing play on a listed element makes it current — it stays listed", () => {
      playElsewhere()
      const [, b] = putAudio(2)
      player.injectQueueChips()
      chips()[1].click()
      expect(chips()[1].getAttribute("aria-pressed")).toBe("true")
      claim(b)
      expect(chips()[1].getAttribute("aria-pressed")).toBe("true")
      expect(chips()[1].textContent).toBe("2")
      const rows = [...document.querySelectorAll(".srr-player-row")]
      expect(rows[1].classList.contains("srr-player-row-now")).toBe(true)
      expect(rows[0].classList.contains("srr-player-row-played")).toBe(true)
   })

   it("the lock screen's Stop clears the queue with the episode — an explicit 'I am done'", () => {
      const setActionHandler = vi.fn()
      Object.defineProperty(navigator, "mediaSession", {
         value: { metadata: null, playbackState: "none", setActionHandler },
         configurable: true,
      })
      const [a] = putAudio(2)
      claim(a)
      chips()[1].click()
      const stop = setActionHandler.mock.calls.filter((c) => c[0] === "stop").at(-1)?.[1] as () => void
      stop()
      expect(player.isActive()).toBe(false)
      expect(localStorage.getItem("srr-player")).toBeNull()
      expect(chips()[1].getAttribute("aria-pressed")).toBe("false")
      expect(bar().hidden).toBe(true)
   })

   it("the Up next list always lists the queue; ✕ removes a row, a row press plays it now", () => {
      const list = q<HTMLElement>(".srr-player-list")
      const empty = q<HTMLElement>(".srr-player-empty")
      expect(empty.hidden).toBe(false) // nothing queued yet: says how to add
      playElsewhere()
      putAudio(2)
      player.injectQueueChips()
      chips()[0].click()
      chips()[1].click()
      // No button to open it: the rows are simply there.
      expect(list.querySelectorAll(".srr-player-row:not(.srr-player-row-now)")).toHaveLength(2)
      expect(empty.hidden).toBe(true)
      expect(count()).toBe("2")
      // Remove the first entry: the list re-renders and the chip un-presses.
      list.querySelector<HTMLButtonElement>(".srr-player-row:not(.srr-player-row-now) .srr-player-row-remove")?.click()
      expect(list.querySelectorAll(".srr-player-row:not(.srr-player-row-now)")).toHaveLength(1)
      expect(chips()[0].getAttribute("aria-pressed")).toBe("false")
      // Play the remaining row: it becomes current, and nothing leaves the list —
      // the episode that was playing stays above it, played.
      const rest = list.querySelectorAll<HTMLElement>(".srr-player-row:not(.srr-player-row-now)")
      rest[rest.length - 1].querySelector<HTMLButtonElement>(".srr-player-row-play")?.click()
      expect(player.isActive()).toBe(true)
      expect(list.querySelectorAll(".srr-player-row")).toHaveLength(2)
      expect(list.querySelectorAll(".srr-player-row-now")).toHaveLength(1)
      expect(list.querySelectorAll(".srr-player-row-played")).toHaveLength(1)
      expect(q(".srr-player-count").textContent).toBe("2")
      expect(empty.hidden).toBe(true)
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
   })

   it("Escape folds the full player and is claimed; other keys still reach the global keymap", () => {
      playElsewhere()
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      const list = q<HTMLElement>(".srr-player-list")
      const dock = q<HTMLButtonElement>(".srr-player-dock")
      list.querySelector<HTMLButtonElement>(".srr-player-row-remove")?.focus()
      const globalKeymap = vi.fn()
      document.addEventListener("keydown", globalKeymap)
      try {
         // A control, not a modal: an unclaimed key goes on to the app.
         list.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }))
         expect(globalKeymap).toHaveBeenCalledTimes(1)
         // Escape folds — and must not ALSO drop the reader to the list.
         list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
         expect(globalKeymap).toHaveBeenCalledTimes(1)
         expect(bar().classList.contains("srr-player-folded")).toBe(true)
         expect(dock.getAttribute("aria-expanded")).toBe("false")
         // Focus followed the close onto the one control still visible: the
         // dock, which IS the folded player.
         expect(document.activeElement).toBe(q(".srr-player-dock"))
      } finally {
         document.removeEventListener("keydown", globalKeymap)
      }
   })

   it("restores a persisted queue into the ready bar, dropping invalid entries", () => {
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            queue: [
               { chron: 43, index: 0, src: "assets/aa/9.mp3", kind: "audio", title: "Episode 13", feedId: 7 },
               { chron: 44, index: 0, src: "javascript:alert(1)", kind: "audio", title: "evil", feedId: 7 },
               { chron: 45, index: 0, src: "../../elsewhere/x.mp3", kind: "audio", title: "escape", feedId: 7 },
               { chron: -1, index: 0, src: "a.mp3", kind: "audio", title: "bad chron", feedId: 7 },
               { chron: 46, index: 0, src: "a.mp3", kind: "gif", title: "bad kind", feedId: 7 },
            ],
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(false)
      expect(bar().hidden).toBe(false)
      expect(count()).toBe("1")
      expect(q(".srr-player-name").textContent).toBe("Episode 13")
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
      // The ready toggle then plays the head — a detached element, since chron
      // 43 is not the mounted article.
      q<HTMLButtonElement>(".srr-player-toggle").click()
      expect(player.isActive()).toBe(true)
      expect(media().querySelector("audio")).toBeTruthy()
   })

   it("restores an active episode AND its queue from one blob", () => {
      putAudio(1)
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            chron: 42,
            index: 0,
            time: 75,
            rate: 1,
            src: "assets/aa/0.mp3",
            kind: "audio",
            title: "Episode 12",
            feedId: 7,
            queue: [{ chron: 43, index: 0, src: "x.mp3", kind: "audio", title: "Up next", feedId: 7 }],
         }),
      )
      player.restorePersisted()
      expect(player.isActive()).toBe(true)
      expect(count()).not.toBe("")
      expect(count()).toBe("1")
   })

   it("caps a restored queue at 50 entries", () => {
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            queue: Array.from({ length: 60 }, (_, i) => ({
               chron: 100 + i,
               index: 0,
               src: "a.mp3",
               kind: "audio",
               title: `E${i}`,
               feedId: 7,
            })),
         }),
      )
      player.restorePersisted()
      expect(count()).toBe("50")
   })

   it("registers lock-screen next/prev ONLY while the playlist is non-empty", () => {
      const setActionHandler = vi.fn()
      const ms = { metadata: null as unknown, playbackState: "none", setActionHandler }
      Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true })

      const [a] = putAudio(2)
      player.injectQueueChips()
      const lastFor = (action: string) => setActionHandler.mock.calls.filter((c) => c[0] === action).at(-1)?.[1] ?? null
      claim(a) // a playlist of one: they step ITS entries, never articles
      expect(typeof lastFor("nexttrack")).toBe("function")
      expect(typeof lastFor("previoustrack")).toBe("function")
      chips()[1].click() // two entries — still registered
      expect(typeof lastFor("nexttrack")).toBe("function")
      chips()[1].click() // remove b
      chips()[0].click() // remove a (the current one): the playlist is empty
      expect(lastFor("nexttrack")).toBeNull()
      expect(lastFor("previoustrack")).toBeNull()
   })

   it("previoustrack restarts past 3s, and steps back through the playlist early on", () => {
      const setActionHandler = vi.fn()
      const ms = { metadata: null as unknown, playbackState: "none", setActionHandler }
      Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true })

      const [a, b] = putAudio(3)
      claim(a)
      chips()[1].click() // b
      chips()[2].click() // c
      a.currentTime = 30
      const handler = (action: string) =>
         setActionHandler.mock.calls.filter((c) => c[0] === action).at(-1)?.[1] as (() => void) | null
      const nowAt = () =>
         [...document.querySelectorAll(".srr-player-row")].findIndex((r) => r.classList.contains("srr-player-row-now"))
      // Past the threshold: restart, same episode.
      handler("previoustrack")?.()
      expect(a.currentTime).toBe(0)
      expect(nowAt()).toBe(0)
      // Next: b becomes current — a stays listed, above it.
      handler("nexttrack")?.()
      expect(nowAt()).toBe(1)
      expect(document.querySelectorAll(".srr-player-row")).toHaveLength(3)
      // Early in b, previous steps back to a — ⏮ then ⏭ round-trips.
      b.currentTime = 1
      handler("previoustrack")?.()
      expect(nowAt()).toBe(0)
      expect(a.currentTime).toBe(0)
      // At the top of the list there is nothing before: previous restarts.
      handler("previoustrack")?.()
      expect(nowAt()).toBe(0)
   })
})

describe("Playlist — reorder and swipe", () => {
   // The Up next list lives in the full player, only reachable UNFOLDED.
   beforeEach(() => q<HTMLButtonElement>(".srr-player-dock").click())
   const rows = () => [...q<HTMLElement>(".srr-player-list").querySelectorAll<HTMLElement>(".srr-player-row")]
   const names = () => rows().map((r) => r.querySelector(".srr-player-row-name")?.textContent)
   const grip = (r: Element) => r.querySelector(".srr-player-row-grip") as HTMLButtonElement
   const key = (t: EventTarget, k: string) => {
      const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
      t.dispatchEvent(e)
      return e
   }

   // The panel's rows sit inside .srr-player, which gestures.ts declines
   // outright (the scrubber guard) — so the swipe here is the panel's own, and
   // like gestures' machine it only reads {clientX,clientY} off touches.
   const touch = (t: EventTarget, type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      const pt = [{ clientX: x, clientY: y }]
      Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : pt, configurable: true })
      Object.defineProperty(e, "changedTouches", { value: pt, configurable: true })
      t.dispatchEvent(e)
      return e
   }

   // Three distinct articles' episodes in a restored queue: titles B, C, D in order.
   const queueThree = () => seedQueue({ chron: 43, title: "B" }, { chron: 44, title: "C" }, { chron: 45, title: "D" })

   it("the handle's ↑/↓ reorder the playlist, persist the order, and re-label the ready head", () => {
      queueThree()
      expect(q(".srr-player-name").textContent).toBe("B") // READY head
      expect(names()).toEqual(["B", "C", "D"])
      // One handle per row — the old ▲/▼ pair is gone.
      expect(rows()[0].querySelectorAll("button")).toHaveLength(3) // play, ✕, handle
      key(grip(rows()[1]), "ArrowUp") // C to the head
      expect(names()).toEqual(["C", "B", "D"])
      expect(q(".srr-player-name").textContent).toBe("C") // the READY bar follows
      const saved = JSON.parse(localStorage.getItem("srr-player") as string)
      expect(saved.queue.map((e: { title: string }) => e.title)).toEqual(["C", "B", "D"])
      // The list re-rendered under the key; the keyboard stays on the moved row's handle.
      expect(document.activeElement).toBe(grip(rows()[0]))
      key(grip(rows()[0]), "ArrowUp") // dead end: nothing moves
      expect(names()).toEqual(["C", "B", "D"])
      key(grip(rows()[0]), "ArrowDown") // and back
      expect(names()).toEqual(["B", "C", "D"])
      expect(document.activeElement).toBe(grip(rows()[1]))
   })

   it("Delete on a handle removes its row and keeps the keyboard in the list", () => {
      queueThree()
      const e = key(grip(rows()[1]), "Delete")
      expect(e.defaultPrevented).toBe(true)
      expect(names()).toEqual(["B", "D"])
      expect(document.activeElement).toBe(grip(rows()[1])) // D took C's place
      key(grip(rows()[1]), "Delete")
      expect(document.activeElement).toBe(grip(rows()[0])) // the new last row
   })

   it("dragging a handle moves the row to where it is dropped", () => {
      queueThree()
      // jsdom has no layout: give the three rows 50px each.
      const place = () =>
         rows().forEach((r, i) => {
            Object.defineProperty(r, "offsetTop", { value: i * 50, configurable: true })
            Object.defineProperty(r, "offsetHeight", { value: 50, configurable: true })
         })
      place()
      const g = grip(rows()[0])
      g.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 25 }))
      g.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 60 }))
      // Its bottom edge (85) has passed C's middle (75) but not D's (125): only C makes room.
      expect(rows()[1].style.transform).toBe("translateY(-50px)")
      expect(rows()[2].style.transform).toBe("")
      g.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 140 }))
      // Past D's too: both rows it passed make room, and the dragged row
      // follows only as far as the last row — never past the list's end.
      expect(rows()[0].style.transform).toBe("translateY(100px)")
      expect(rows()[1].style.transform).toBe("translateY(-50px)")
      expect(rows()[2].style.transform).toBe("translateY(-50px)")
      g.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientY: 140 }))
      expect(names()).toEqual(["C", "D", "B"])
      expect(rows().every((r) => r.style.transform === "")).toBe(true)
      expect(document.activeElement).toBe(grip(rows()[2]))

      // A cancelled drag drops nothing.
      place()
      const g2 = grip(rows()[2])
      g2.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 125 }))
      g2.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 10 }))
      g2.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }))
      expect(names()).toEqual(["C", "D", "B"])
      expect(rows().every((r) => r.style.transform === "")).toBe(true)
   })

   it("a touch on the handle is a reorder, never a swipe-to-remove", () => {
      queueThree()
      const g = grip(rows()[0])
      touch(g, "touchstart", 200, 100)
      touch(g, "touchmove", 160, 102)
      touch(g, "touchmove", 100, 103) // well past the trigger
      touch(g, "touchend", 100, 103)
      expect(names()).toEqual(["B", "C", "D"])
   })

   it("« is hidden at the head of a ready playlist, and plays the entry before otherwise", () => {
      const prev = q<HTMLButtonElement>(".srr-player-prev")
      queueThree()
      expect(prev.hidden).toBe(true) // READY at B, the head: nothing before it
      localStorage.setItem(
         "srr-player",
         JSON.stringify({
            queue: ["B", "C"].map((title, i) => ({
               chron: 43 + i,
               index: 0,
               src: `assets/aa/${43 + i}.mp3`,
               kind: "audio",
               title,
               feedId: 7,
            })),
            c: 1,
         }),
      )
      player.restorePersisted()
      expect(q(".srr-player-name").textContent).toBe("C") // READY at C
      expect(prev.hidden).toBe(false)
      prev.click()
      expect(player.isActive()).toBe(true)
      expect(q(".srr-player-name").textContent).toBe("B")
      // Playing, « stays even at the head: there it restarts the episode.
      expect(prev.hidden).toBe(false)
      // The current row is marked by its tint and aria-current alone — its
      // eyebrow is the feed, with no "Now playing" label (user call).
      const now = q(".srr-player-row-now")
      expect(now.querySelector(".srr-player-row-source")?.textContent).toBe("The Daily")
      expect(now.querySelector(".srr-player-row-play")?.getAttribute("aria-current")).toBe("true")
   })

   it("the clock moving does not rebuild the rows — only a play/pause does", () => {
      queueThree()
      rows()[0].querySelector<HTMLButtonElement>(".srr-player-row-play")?.click() // play B
      const m = document.querySelector<HTMLMediaElement>(".srr-player-media audio")
      expect(m).not.toBeNull()
      playing(m!)
      m!.dispatchEvent(new Event("play"))
      const before = rows()
      withDuration(m!, 100)
      m!.currentTime = 30
      m!.dispatchEvent(new Event("timeupdate"))
      expect(q(".srr-player-time").textContent).toBe("0:30") // the clock did move…
      expect(rows()[0]).toBe(before[0]) // …and the rows (a drag, a focus) survived it
      playing(m!, false)
      m!.dispatchEvent(new Event("pause"))
      expect(rows()[0]).not.toBe(before[0]) // Play ↔ Pause relabels the current row
   })

   describe("the list follows the current episode", () => {
      // jsdom has no layout: every playlist row is 50px tall.
      const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!
      beforeEach(() =>
         Object.defineProperty(HTMLElement.prototype, "offsetTop", {
            configurable: true,
            get(this: HTMLElement) {
               return this.classList.contains("srr-player-row")
                  ? [...this.parentElement!.children].indexOf(this) * 50
                  : 0
            },
         }),
      )
      afterEach(() => Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop))
      const scrolls = () =>
         (q(".srr-player-list").scrollTo as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
      // Six episodes, READY at the fifth (index 4) — four already played above it.
      const seedAt = (c: number) => {
         localStorage.setItem(
            "srr-player",
            JSON.stringify({
               queue: ["A", "B", "C", "D", "E", "F"].map((title, i) => ({
                  chron: 43 + i,
                  index: 0,
                  src: `assets/aa/${43 + i}.mp3`,
                  kind: "audio",
                  title,
                  feedId: 7,
               })),
               c,
            }),
         )
         player.restorePersisted()
      }
      const reopen = () => {
         q<HTMLButtonElement>(".srr-player-close").click()
         q<HTMLButtonElement>(".srr-player-dock").click()
      }

      it("opening lands on the current row at once, the one before it peeking above", () => {
         seedAt(4)
         reopen()
         expect(scrolls().at(-1)).toEqual({ top: 150, behavior: "instant" }) // D's row, E under it
      })

      it("a new current episode glides into place; anything else leaves the scroll alone", () => {
         seedAt(4)
         reopen()
         const n = scrolls().length
         q<HTMLButtonElement>(".srr-player-toggle").click() // play E: same entry, no follow
         expect(scrolls()).toHaveLength(n)
         key(grip(rows()[0]), "ArrowDown") // a reorder elsewhere: no follow
         expect(scrolls()).toHaveLength(n)
         q<HTMLButtonElement>(".srr-player-next").click() // on to F
         expect(scrolls().at(-1)).toEqual({ top: 200, behavior: "smooth" })
      })

      it("your own scrolling wins: a wheel on the list pauses the follow", () => {
         seedAt(4)
         reopen()
         const n = scrolls().length
         q(".srr-player-list").dispatchEvent(new Event("wheel"))
         q<HTMLButtonElement>(".srr-player-next").click()
         expect(scrolls()).toHaveLength(n)
         // …but reopening the view always lands on the current row.
         reopen()
         expect(scrolls()).toHaveLength(n + 1)
      })
   })

   it("a horizontal swipe past the trigger removes the row", () => {
      queueThree()
      const row = rows()[0]
      touch(row, "touchstart", 200, 100)
      touch(row, "touchmove", 160, 102) // engaged: horizontal past the slop
      touch(row, "touchmove", 120, 103) // past the 64px trigger
      touch(row, "touchend", 120, 103)
      expect(names()).toEqual(["C", "D"])
      const saved = JSON.parse(localStorage.getItem("srr-player") as string)
      expect(saved.queue).toHaveLength(2)
   })

   it("a short drag snaps back, and its finger-lift click does not play the row", () => {
      queueThree()
      const row = rows()[0]
      touch(row, "touchstart", 200, 100)
      touch(row, "touchmove", 170, 101) // engaged but under the trigger
      touch(row, "touchend", 170, 101)
      expect(names()).toEqual(["B", "C", "D"]) // nothing removed
      const play = row.querySelector(".srr-player-row-play") as HTMLButtonElement
      play.click() // the lift's synthesized click — a drag is not a tap
      expect(player.isActive()).toBe(false)
      play.click() // a real tap right after still plays
      expect(player.isActive()).toBe(true)
   })

   it("a vertical drag stays a scroll — the queue is untouched, taps unharmed", () => {
      queueThree()
      const row = rows()[0]
      touch(row, "touchstart", 200, 100)
      touch(row, "touchmove", 202, 160) // vertical-dominant: vetoed for good
      touch(row, "touchmove", 120, 165) // late horizontal must not re-engage
      touch(row, "touchend", 120, 165)
      expect(names()).toEqual(["B", "C", "D"])
      const play = row.querySelector(".srr-player-row-play") as HTMLButtonElement
      play.click() // no guard armed — a scroll's tail is not a swipe
      expect(player.isActive()).toBe(true)
   })
})

// A 2-second network blip mid-commute must not end a 90-minute episode: the
// first error keeps the claim and retries the SAME element after a beat; only
// the second error takes the old dismissal / queue-skip path.
describe("error retry", () => {
   const toggle = () => q<HTMLButtonElement>(".srr-player-toggle")
   const busy = () => toggle().classList.contains("srr-player-buffering")

   it("a first error retries in place: reload after a beat, reseek, resume", () => {
      vi.useFakeTimers()
      try {
         const [m] = putAudio()
         claim(m)
         m.currentTime = 500
         m.classList.add("srr-broken") // what collapseBrokenMedia did on the same error
         m.dispatchEvent(new Event("error"))
         // Still claimed, spinner up — the blip gets a moment to pass first (an
         // immediate reload would land inside the same outage).
         expect(player.isActive()).toBe(true)
         expect(busy()).toBe(true)
         expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled()
         vi.advanceTimersByTime(2000)
         expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1)
         // load() resets the element; the position comes back at metadata and
         // playback resumes because it WAS playing when the error hit.
         m.currentTime = 0
         withDuration(m, 3600)
         m.dispatchEvent(new Event("loadedmetadata"))
         expect(m.currentTime).toBe(500)
         expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
         expect(m.classList.contains("srr-broken")).toBe(false) // un-hidden on success
      } finally {
         vi.useRealTimers()
      }
   })

   it("an episode PAUSED at the error retries silently and stays paused", () => {
      vi.useFakeTimers()
      try {
         const [m] = putAudio()
         claim(m)
         m.currentTime = 500
         playing(m, false)
         m.dispatchEvent(new Event("error"))
         expect(player.isActive()).toBe(true)
         expect(busy()).toBe(false) // nothing is waiting on data, so no spinner
         vi.advanceTimersByTime(2000)
         expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1)
         m.currentTime = 0
         withDuration(m, 3600)
         m.dispatchEvent(new Event("loadedmetadata"))
         expect(m.currentTime).toBe(500)
         expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
      } finally {
         vi.useRealTimers()
      }
   })

   it("a second error during the wait gives up and cancels the pending reload", () => {
      vi.useFakeTimers()
      try {
         const [m] = putAudio()
         claim(m)
         m.dispatchEvent(new Event("error"))
         m.dispatchEvent(new Event("error"))
         expect(player.isActive()).toBe(false)
         vi.advanceTimersByTime(5000)
         expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled()
      } finally {
         vi.useRealTimers()
      }
   })

   it("closing during the retry wait cancels the reload", () => {
      vi.useFakeTimers()
      try {
         const [m] = putAudio()
         claim(m)
         m.dispatchEvent(new Event("error"))
         removeNow()
         vi.advanceTimersByTime(5000)
         expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled()
         expect(player.isActive()).toBe(false)
      } finally {
         vi.useRealTimers()
      }
   })

   it("a refused resume drops the spinner instead of spinning over a paused bar", async () => {
      vi.useFakeTimers()
      const [m] = putAudio()
      try {
         HTMLMediaElement.prototype.play = vi.fn().mockRejectedValue(new Error("blocked"))
         claim(m)
         m.currentTime = 500
         m.dispatchEvent(new Event("error"))
         expect(busy()).toBe(true)
         vi.advanceTimersByTime(2000)
         playing(m, false) // load() reset the element — it is no longer playing
         m.dispatchEvent(new Event("loadedmetadata"))
      } finally {
         vi.useRealTimers()
      }
      await new Promise((r) => setTimeout(r)) // let the play() rejection settle
      expect(busy()).toBe(false)
   })
})

describe("buffering feedback", () => {
   const toggle = () => q<HTMLButtonElement>(".srr-player-toggle")
   const busy = () => toggle().classList.contains("srr-player-buffering")

   it("waiting marks the toggle busy; playing clears it", () => {
      const [m] = putAudio()
      claim(m) // playing
      m.dispatchEvent(new Event("waiting"))
      expect(busy()).toBe(true)
      expect(toggle().getAttribute("aria-busy")).toBe("true")
      m.dispatchEvent(new Event("playing"))
      expect(busy()).toBe(false)
      expect(toggle().getAttribute("aria-busy")).toBe("false")
   })

   it("canplay also clears it — engines differ on which fires first", () => {
      const [m] = putAudio()
      claim(m)
      m.dispatchEvent(new Event("stalled"))
      expect(busy()).toBe(true)
      m.dispatchEvent(new Event("canplay"))
      expect(busy()).toBe(false)
   })

   it("a stall while PAUSED shows no spinner — a preload hiccup is not a wait", () => {
      const [m] = putAudio()
      claim(m)
      playing(m, false)
      m.dispatchEvent(new Event("stalled"))
      expect(busy()).toBe(false)
   })

   it("pausing mid-stall drops the spinner — nothing is coming that anyone asked for", () => {
      const [m] = putAudio()
      claim(m)
      m.dispatchEvent(new Event("waiting"))
      expect(busy()).toBe(true)
      playing(m, false)
      m.dispatchEvent(new Event("pause"))
      expect(busy()).toBe(false)
   })

   it("the spinner never survives into the next episode", () => {
      const [a, b] = putAudio(2)
      claim(a)
      a.dispatchEvent(new Event("waiting"))
      expect(busy()).toBe(true)
      claim(b)
      expect(busy()).toBe(false)
   })
})

describe("queue resume — FEB2 positions", () => {
   // Queue an episode of article 43 while it is mounted, then finish an episode
   // on article 42 so the auto-advance builds 43's element DETACHED in the bar.
   const advanceIntoDetached = () => {
      seedQueue({ chron: 42, title: "Episode 12" }, { chron: 43, title: "Episode 13" })
      const [m] = putAudio(1)
      claim(m)
      m.dispatchEvent(new Event("ended"))
      return media().querySelector("audio") as HTMLMediaElement
   }

   it("a detached queue entry resumes from FEB2's remembered position", () => {
      deps.readPosition.mockImplementation((_mid: string, chron: number) =>
         chron === 43 ? { time: 300, rate: 1 } : undefined,
      )
      const built = advanceIntoDetached()
      expect(built).toBeTruthy()
      expect(deps.readPosition).toHaveBeenCalledWith("0", 43, 0)
      // currentTime is only settable once duration is known (the FEB2 pattern).
      withDuration(built, 3600)
      built.dispatchEvent(new Event("loadedmetadata"))
      expect(built.currentTime).toBe(300)
   })

   it("a remembered position at the very end starts the entry over instead", () => {
      // onEnded hands the FINISHED position to FEB2 (time == duration), so a
      // re-queued finished episode would otherwise re-end instantly and cascade
      // through the whole queue.
      deps.readPosition.mockReturnValue({ time: 3599, rate: 1 })
      const built = advanceIntoDetached()
      withDuration(built, 3600)
      built.dispatchEvent(new Event("loadedmetadata"))
      expect(built.currentTime).toBe(0)
   })

   it("a live in-place claim never re-seeks — the on-screen element already carries its truth", () => {
      // The entry's own article is mounted: playEntry claims the element that is
      // already there (restoreMediaState applied any position at render), so a
      // remembered value must not yank it.
      deps.readPosition.mockReturnValue({ time: 300, rate: 1 })
      const [a, b] = putAudio(2)
      player.injectQueueChips()
      claim(a)
      const chipsNow = [...content().querySelectorAll<HTMLButtonElement>(".srr-queue-chip")]
      chipsNow[1].click() // queue b (same article)
      a.dispatchEvent(new Event("ended"))
      expect(player.isActive()).toBe(true)
      withDuration(b, 3600)
      b.dispatchEvent(new Event("loadedmetadata"))
      expect(b.currentTime).toBe(0)
   })
})

describe("media session", () => {
   it("publishes episode metadata and keeps playbackState in step", () => {
      const setActionHandler = vi.fn()
      const ms = { metadata: null as unknown, playbackState: "none", setActionHandler }
      Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true })
      class FakeMetadata {
         constructor(public init: Record<string, string>) {}
      }
      ;(globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = FakeMetadata

      const [m] = putAudio()
      claim(m)
      expect((ms.metadata as FakeMetadata).init).toMatchObject({
         title: "Episode 12",
         artist: "The Daily",
         album: "SRR",
      })
      expect(ms.playbackState).toBe("playing")

      // previoustrack/nexttrack step the PLAYLIST (the episode is its only
      // entry) — never prev/next ARTICLE, which would turn the lock screen into
      // a way to skip out of the episode you are listening to.
      const actions = setActionHandler.mock.calls.map((c) => c[0])
      expect(actions).toContain("play")
      expect(actions).toContain("seekforward")
      const lastFor = (a: string) => setActionHandler.mock.calls.filter((c) => c[0] === a).at(-1)?.[1] ?? null
      expect(typeof lastFor("nexttrack")).toBe("function")

      playing(m, false)
      m.dispatchEvent(new Event("pause"))
      expect(ms.playbackState).toBe("paused")
   })
})

describe("the seek bar", () => {
   it("keyboard-seeks and reports its position to assistive tech", () => {
      const [m] = putAudio()
      withDuration(m, 200)
      claim(m)
      m.currentTime = 50
      m.dispatchEvent(new Event("timeupdate"))
      const seek = q<HTMLElement>(".srr-player-seek")
      expect(seek.getAttribute("aria-valuemax")).toBe("200")
      expect(seek.getAttribute("aria-valuenow")).toBe("50")
      expect(q<HTMLElement>(".srr-player-seek-fill").style.width).toBe("25%")

      seek.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
      expect(m.currentTime).toBe(55)
      seek.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
      expect(m.currentTime).toBe(0)
   })

   // The ARIA slider pattern puts ↑/↓ on the value axis. app.ts's global keymap
   // routes them through onCycle, so unhandled they stepped the FILTER
   // while the seek bar had focus; handled here they seek and (below) never
   // reach the document at all.
   it("steps the value on ArrowUp/ArrowDown, the ARIA slider axis", () => {
      const [m] = putAudio()
      withDuration(m, 200)
      claim(m)
      m.currentTime = 50
      const seek = q<HTMLElement>(".srr-player-seek")

      seek.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
      expect(m.currentTime).toBe(55)
      seek.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
      expect(m.currentTime).toBe(50)
   })

   // The seek bar is a tabindex=0 role=slider DIV, so app.ts's document-level
   // keydown — bubble-phase, typing-guarded on tag names only, with no
   // defaultPrevented check — sees every key it handles. A key that ALSO ran
   // the global action would seek AND step to the next article. Every key the
   // handler claims must therefore stop at the bar.
   it("never lets a handled key reach app.ts's document-level keymap", () => {
      const [m] = putAudio()
      withDuration(m, 200)
      claim(m)
      m.currentTime = 50
      const seek = q<HTMLElement>(".srr-player-seek")

      const globalKeymap = vi.fn()
      document.addEventListener("keydown", globalKeymap)
      try {
         for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home"]) {
            seek.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
            expect(
               globalKeymap,
               `${key} reached the document keymap — it would also run the global action`,
            ).not.toHaveBeenCalled()
         }
      } finally {
         document.removeEventListener("keydown", globalKeymap)
      }
   })

   // ...while a key it does NOT claim must still reach the global keymap: the
   // guard above is scoped to the slider's own axis, not a blanket swallow (a
   // modal owns every key — lightbox.ts — but a CONTROL owns only its own).
   it("lets an unhandled key through to the global keymap", () => {
      const [m] = putAudio()
      claim(m)
      const seek = q<HTMLElement>(".srr-player-seek")

      const globalKeymap = vi.fn()
      document.addEventListener("keydown", globalKeymap)
      try {
         seek.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
         expect(globalKeymap).toHaveBeenCalledTimes(1)
      } finally {
         document.removeEventListener("keydown", globalKeymap)
      }
   })

   it("shows a live clock, and only a duration once one is known", () => {
      const [m] = putAudio()
      claim(m)
      m.currentTime = 65
      m.dispatchEvent(new Event("timeupdate"))
      // duration is NaN on a cold element — the length clock stays empty.
      expect(q(".srr-player-time").textContent).toBe("1:05")
      expect(q(".srr-player-duration").textContent).toBe("")
      withDuration(m, 3725)
      m.dispatchEvent(new Event("timeupdate"))
      expect(q(".srr-player-time").textContent).toBe("1:05")
      expect(q(".srr-player-duration").textContent).toBe("1:02:05")
   })
})

// The state/projection split (player/state.ts + the effects) promises three
// things no behaviour test above pins directly: a clock tick repaints the clock
// and nothing else, the boot restore persists nothing, and the position is
// saved on the events that matter and throttled between them.
describe("state → projections", () => {
   it("a clock tick repaints the clock only — the chrome is keyed on what it shows", () => {
      const [m] = putAudio()
      claim(m)
      withDuration(m, 120)
      const name = q<HTMLElement>(".srr-player-name")
      expect(name.textContent).toBe("Episode 12")
      name.textContent = "sentinel" // any chrome repaint would overwrite this
      m.currentTime = 30
      m.dispatchEvent(new Event("timeupdate"))
      expect(q(".srr-player-time").textContent).toBe("0:30")
      expect(q(".srr-player-duration").textContent).toBe("2:00")
      expect(name.textContent).toBe("sentinel")
      // A change the chrome DOES show (play → pause) repaints it.
      playing(m, false)
      m.dispatchEvent(new Event("pause"))
      expect(name.textContent).toBe("Episode 12")
   })

   it("an unchanged sample wakes nothing — equal snapshots are no change", () => {
      const [m] = putAudio()
      claim(m)
      m.currentTime = 30
      m.dispatchEvent(new Event("timeupdate"))
      const time = q<HTMLElement>(".srr-player-time")
      time.textContent = "sentinel"
      m.dispatchEvent(new Event("timeupdate")) // same time, same everything
      expect(time.textContent).toBe("sentinel")
   })

   const HEAD = {
      chron: 43,
      index: 0,
      time: 75,
      rate: 1,
      src: "assets/aa/0.mp3",
      kind: "audio",
      title: "E13",
      feedId: 7,
   }
   const QUEUE = [{ chron: 44, index: 0, src: "assets/aa/1.mp3", kind: "audio", title: "E14", feedId: 7 }]

   it("booting persists nothing — the empty first state must not wipe the blob restore is about to read", async () => {
      const blob = JSON.stringify({ ...HEAD, queue: QUEUE })
      localStorage.setItem("srr-player", blob)
      vi.resetModules()
      const fresh = await import("./player")
      fresh.setup(deps)
      fresh.noteMounted(MOUNTED)
      expect(localStorage.getItem("srr-player")).toBe(blob)
   })

   it("a detached restore persists nothing, before metadata or after", () => {
      // Before metadata the claim reads as position 0, which save() treats as
      // never-played — persisting then would drop the head from the blob.
      const blob = JSON.stringify({ ...HEAD, queue: QUEUE })
      localStorage.setItem("srr-player", blob)
      player.restorePersisted()
      expect(player.isActive()).toBe(true)
      expect(localStorage.getItem("srr-player")).toBe(blob)
      const m = media().querySelector("audio") as HTMLMediaElement
      m.dispatchEvent(new Event("loadedmetadata"))
      expect(m.currentTime).toBe(75)
      expect(localStorage.getItem("srr-player")).toBe(blob)
   })

   it("an in-place restore persists nothing either — queue and speed included", () => {
      const [live] = putAudio()
      // Both halves that DO wake the persist effect: a restored queue, and a
      // stored speed that moves the preference at claim (1 → 1.5).
      localStorage.setItem("srr-player-rate", "1.5")
      const blob = JSON.stringify({ ...HEAD, chron: 42, queue: QUEUE })
      localStorage.setItem("srr-player", blob)
      player.restorePersisted()
      expect(media().children).toHaveLength(0) // claimed the article's own element
      expect(player.isActive()).toBe(true)
      expect(localStorage.getItem("srr-player")).toBe(blob)
      live.dispatchEvent(new Event("loadedmetadata"))
      expect(localStorage.getItem("srr-player")).toBe(blob)
   })

   it("the position saves on play/pause and on a 5 s throttle between", () => {
      vi.useFakeTimers()
      try {
         const [m] = putAudio()
         claim(m)
         const savedTime = () => JSON.parse(localStorage.getItem("srr-player") as string).time
         m.currentTime = 10
         m.dispatchEvent(new Event("pause")) // an event save, unthrottled
         expect(savedTime()).toBe(10)
         m.currentTime = 12
         m.dispatchEvent(new Event("timeupdate")) // inside the 5 s window: throttled
         expect(savedTime()).toBe(10)
         vi.advanceTimersByTime(5000)
         m.currentTime = 20
         m.dispatchEvent(new Event("timeupdate")) // window elapsed: saved
         expect(savedTime()).toBe(20)
      } finally {
         vi.useRealTimers()
      }
   })

   it("a queue write alone updates every surface — list, count, chips, lock screen, blob", () => {
      const setActionHandler = vi.fn()
      Object.defineProperty(navigator, "mediaSession", {
         value: { metadata: null, playbackState: "none", setActionHandler },
         configurable: true,
      })
      playElsewhere()
      putAudio(2)
      player.injectQueueChips()
      const chips = () => [...content().querySelectorAll<HTMLButtonElement>(".srr-queue-chip")]
      chips()[1].click() // the one mutation; everything below is a projection of it
      // The playlist: the episode playing now, then the one just queued; the
      // heading counts both.
      expect(q(".srr-player-list").querySelectorAll(".srr-player-row")).toHaveLength(2)
      expect(q(".srr-player-list").querySelectorAll(".srr-player-row-now")).toHaveLength(1)
      expect(q(".srr-player-count").textContent).toBe("2")
      expect(chips()[1].textContent).toBe("2") // after the episode playing elsewhere
      const next = setActionHandler.mock.calls.filter((c) => c[0] === "nexttrack").at(-1)
      expect(typeof next?.[1]).toBe("function")
      expect(JSON.parse(localStorage.getItem("srr-player") as string).queue).toHaveLength(2)
   })
})
