import { beforeEach, describe, expect, it, vi } from "vitest"

// data.ts fires a db.gz fetch at module load, so it is mocked wholesale (the
// house pattern — see app.test.ts / list.test.ts). fmt is mocked only for
// srcColorIndex; urlish and keys are side-effect-free and used for real, which
// is the point of the persisted-src validation tests below.
const data = vi.hoisted(() => ({
   feedTitle: (id: number) => (id === 7 ? "The Daily" : `Feed ${id}`),
   activeStore: () => ({ mid: "0", base: new URL("https://cdn.example/store/") }),
}))
vi.mock("./data", () => data)
vi.mock("./fmt", () => ({ srcColorIndex: () => 3 }))

const SKELETON = `
   <article class="srr-reader" hidden><div class="srr-content"></div></article>
   <div class="srr-player" hidden>
      <div class="srr-player-media"></div>
      <div class="srr-player-body">
         <button class="srr-player-title"><span class="srr-player-source"></span><span class="srr-player-name"></span></button>
         <div class="srr-player-seek" role="slider" tabindex="0"><div class="srr-player-seek-fill"></div></div>
      </div>
      <div class="srr-player-controls">
         <button class="srr-player-back15"></button>
         <button class="srr-player-toggle"></button>
         <button class="srr-player-fwd15"></button>
         <button class="srr-player-next" hidden></button>
         <button class="srr-player-rate"></button>
         <span class="srr-player-time"></span>
         <button class="srr-player-queue" hidden></button>
         <button class="srr-player-close"></button>
      </div>
   </div>`

type Player = typeof import("./player")
let player: Player
const deps = { openArticle: vi.fn(), rememberPosition: vi.fn() }

const q = <T extends Element>(sel: string) => document.querySelector(sel) as T
const bar = () => q<HTMLElement>(".srr-player")
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

// Claim an element the way a real tap does: a `play` event, which player.ts
// catches with a capture-phase document listener (`play` does not bubble).
const claim = (m: HTMLMediaElement) => {
   playing(m)
   m.dispatchEvent(new Event("play"))
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
   vi.resetModules()
   player = await import("./player")
   deps.openArticle.mockClear()
   deps.rememberPosition.mockClear()
   player.setup(deps)
   player.noteMounted(MOUNTED)
})

describe("claiming an episode", () => {
   it("claims a played in-content element and labels the bar from the mounted article", () => {
      const [m] = putAudio()
      claim(m)
      expect(player.isActive()).toBe(true)
      expect(q(".srr-player-source").textContent).toBe("The Daily")
      expect(q(".srr-player-name").textContent).toBe("Episode 12")
      expect(bar().dataset.src).toBe("3")
   })

   it("stays HIDDEN while the article is on screen and the element is in view", () => {
      // The bar is about control, not survival: nothing to control while you can
      // see the player in the article itself.
      claim(putAudio()[0])
      expect(bar().hidden).toBe(true)
      expect(document.body.classList.contains("srr-playing")).toBe(false)
   })

   it("shows once the article surface is hidden behind the list", () => {
      const [m] = putAudio()
      claim(m)
      q<HTMLElement>(".srr-reader").hidden = true
      // Re-sync happens on any media event; a pause is the cheapest.
      m.dispatchEvent(new Event("pause"))
      expect(bar().hidden).toBe(false)
      expect(document.body.classList.contains("srr-playing")).toBe(true)
   })

   it("ignores the GIF idiom — muted+loop+autoplay video must not hijack the transport", () => {
      // #embed / srr-x emit these for what used to be a GIF; they fire `play` on
      // their own the moment they render.
      content().innerHTML = `<video src="a.webm" autoplay muted loop></video>`
      const v = content().querySelector("video") as HTMLMediaElement
      claim(v)
      expect(player.isActive()).toBe(false)
   })

   it("ignores media outside the content host", () => {
      const stray = document.createElement("audio")
      document.body.appendChild(stray)
      claim(stray)
      expect(player.isActive()).toBe(false)
   })

   it("does not claim when no article is mounted (an empty state)", () => {
      const [m] = putAudio()
      player.noteMounted(null)
      claim(m)
      expect(player.isActive()).toBe(false)
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
   it("the ✕ pauses, hands the position back to FEB2 and drops the episode", () => {
      const [m] = putAudio()
      claim(m)
      m.currentTime = 61
      player.adoptFromContent()
      q<HTMLButtonElement>(".srr-player-close").click()
      expect(m.pause).toHaveBeenCalled()
      expect(deps.rememberPosition).toHaveBeenCalledWith("0", 42, 0, { time: 61, rate: 1 })
      expect(player.isActive()).toBe(false)
      expect(bar().hidden).toBe(true)
      expect(media().children).toHaveLength(0) // the adopted node is discarded
   })

   it("±15s seeks without running past the ends", () => {
      const [m] = putAudio()
      withDuration(m, 100)
      claim(m)
      m.currentTime = 20
      q<HTMLButtonElement>(".srr-player-fwd15").click()
      expect(m.currentTime).toBe(35)
      q<HTMLButtonElement>(".srr-player-back15").click()
      expect(m.currentTime).toBe(20)
      m.currentTime = 5
      q<HTMLButtonElement>(".srr-player-back15").click()
      expect(m.currentTime).toBe(0) // clamped, not negative
      m.currentTime = 95
      q<HTMLButtonElement>(".srr-player-fwd15").click()
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

   it("a finished episode dismisses itself and forgets its saved position", () => {
      const [m] = putAudio()
      claim(m)
      m.currentTime = 30
      m.dispatchEvent(new Event("pause")) // writes the entry
      expect(localStorage.getItem("srr-player")).not.toBeNull()
      m.dispatchEvent(new Event("ended"))
      expect(player.isActive()).toBe(false)
      expect(localStorage.getItem("srr-player")).toBeNull()
   })

   it("an unplayable episode dismisses quietly (old articles outlive their media hosts)", () => {
      const [m] = putAudio()
      claim(m)
      m.dispatchEvent(new Event("error"))
      expect(player.isActive()).toBe(false)
      expect(bar().hidden).toBe(true)
   })

   it("the title button routes back to the episode's own article", () => {
      claim(putAudio()[0])
      q<HTMLButtonElement>(".srr-player-title").click()
      expect(deps.openArticle).toHaveBeenCalledWith("0", 42)
   })
})

describe("persistence", () => {
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
      // You can see it, so the bar stays down.
      expect(bar().hidden).toBe(true)
      expect(document.body.classList.contains("srr-playing")).toBe(false)
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
   const queueBtn = () => q<HTMLButtonElement>(".srr-player-queue")
   const nextBtn = () => q<HTMLButtonElement>(".srr-player-next")

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

   it("queueing while idle raises the READY bar — visible, head-labeled, never autoplaying", () => {
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      expect(chips()[0].getAttribute("aria-pressed")).toBe("true")
      expect(player.isActive()).toBe(false)
      expect(bar().hidden).toBe(false)
      expect(q(".srr-player-name").textContent).toBe("Episode 12")
      expect(queueBtn().hidden).toBe(false)
      expect(queueBtn().textContent).toBe("≡ 1")
      expect(nextBtn().hidden).toBe(false)
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
      // …and it survives a reload: the blob persists queue-only, no active half.
      const saved = JSON.parse(localStorage.getItem("srr-player") as string)
      expect(saved.queue).toHaveLength(1)
      expect(saved.src).toBeUndefined()
      // The chip is a toggle: a second tap unqueues and the bar goes away.
      chips()[0].click()
      expect(bar().hidden).toBe(true)
      expect(localStorage.getItem("srr-player")).toBeNull()
   })

   it("the ready bar's play button claims the head IN PLACE when its article is on screen", () => {
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      q<HTMLButtonElement>(".srr-player-toggle").click()
      expect(player.isActive()).toBe(true)
      expect(media().children).toHaveLength(0) // no second element
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
      // Consumed: playing an entry takes it out of the queue.
      expect(chips()[0].getAttribute("aria-pressed")).toBe("false")
      expect(queueBtn().hidden).toBe(true)
   })

   it("ended advances to a queued entry of ANOTHER article as a detached element in the bar", () => {
      // Build the queue on article 43…
      player.noteMounted({ ...MOUNTED, chron: 43, title: "Episode 13" })
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      // …then play an episode on article 42.
      player.noteMounted(MOUNTED)
      const [m] = putAudio(1)
      player.injectQueueChips()
      claim(m)
      expect(queueBtn().textContent).toBe("≡ 1")
      m.dispatchEvent(new Event("ended"))
      expect(player.isActive()).toBe(true)
      const built = media().querySelector("audio") as HTMLAudioElement
      expect(built).toBeTruthy()
      expect(built.src).toBe("https://cdn.example/store/assets/aa/0.mp3")
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
      expect(q(".srr-player-name").textContent).toBe("Episode 13")
      expect(bar().hidden).toBe(false)
      expect(queueBtn().hidden).toBe(true) // drained
   })

   it("ended advances to a same-article entry by claiming it in place", () => {
      const [a] = putAudio(2)
      player.injectQueueChips()
      chips()[1].click()
      claim(a)
      a.dispatchEvent(new Event("ended"))
      expect(player.isActive()).toBe(true)
      expect(media().children).toHaveLength(0)
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
      expect(queueBtn().hidden).toBe(true)
   })

   it("an erroring episode skips to the next queued entry instead of dismissing", () => {
      const [a] = putAudio(2)
      player.injectQueueChips()
      chips()[1].click()
      claim(a)
      a.dispatchEvent(new Event("error"))
      expect(player.isActive()).toBe(true)
      expect(queueBtn().hidden).toBe(true)
   })

   it("manually playing a queued element consumes its entry — no replay later", () => {
      const [, b] = putAudio(2)
      player.injectQueueChips()
      chips()[1].click()
      expect(chips()[1].getAttribute("aria-pressed")).toBe("true")
      claim(b)
      expect(chips()[1].getAttribute("aria-pressed")).toBe("false")
      expect(queueBtn().hidden).toBe(true)
   })

   it("the ✕ clears the queue with the episode — an explicit 'I am done'", () => {
      const [a] = putAudio(2)
      player.injectQueueChips()
      chips()[1].click()
      claim(a)
      q<HTMLButtonElement>(".srr-player-close").click()
      expect(player.isActive()).toBe(false)
      expect(localStorage.getItem("srr-player")).toBeNull()
      expect(chips()[1].getAttribute("aria-pressed")).toBe("false")
      expect(bar().hidden).toBe(true)
   })

   it("the panel lists the queue; ✕ removes a row, a row press plays it now", () => {
      putAudio(2)
      player.injectQueueChips()
      chips()[0].click()
      chips()[1].click()
      queueBtn().click()
      const panel = q<HTMLElement>(".srr-player-panel")
      expect(panel.hidden).toBe(false)
      expect(queueBtn().getAttribute("aria-expanded")).toBe("true")
      expect(panel.querySelectorAll(".srr-player-panel-row")).toHaveLength(2)
      // Remove the first entry: the panel re-renders and the chip un-presses.
      panel.querySelector<HTMLButtonElement>(".srr-player-row-remove")?.click()
      expect(panel.querySelectorAll(".srr-player-panel-row")).toHaveLength(1)
      expect(chips()[0].getAttribute("aria-pressed")).toBe("false")
      // Play the remaining row: consumed, panel closed, playback started.
      panel.querySelector<HTMLButtonElement>(".srr-player-row-play")?.click()
      expect(player.isActive()).toBe(true)
      expect(panel.hidden).toBe(true)
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
   })

   it("the panel owns its keys: Escape closes it, nothing leaks to the global keymap", () => {
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      queueBtn().click()
      const panel = q<HTMLElement>(".srr-player-panel")
      const globalKeymap = vi.fn()
      document.addEventListener("keydown", globalKeymap)
      try {
         // 'd' is the reader's next-article key; under the open panel it must die here.
         panel.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }))
         expect(globalKeymap).not.toHaveBeenCalled()
         panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
         expect(globalKeymap).not.toHaveBeenCalled()
         expect(panel.hidden).toBe(true)
         expect(queueBtn().getAttribute("aria-expanded")).toBe("false")
      } finally {
         document.removeEventListener("keydown", globalKeymap)
      }
   })

   it("an outside press closes the panel", () => {
      putAudio(1)
      player.injectQueueChips()
      chips()[0].click()
      queueBtn().click()
      expect(q<HTMLElement>(".srr-player-panel").hidden).toBe(false)
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
      expect(q<HTMLElement>(".srr-player-panel").hidden).toBe(true)
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
      expect(queueBtn().textContent).toBe("≡ 1")
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
      expect(queueBtn().hidden).toBe(false)
      expect(queueBtn().textContent).toBe("≡ 1")
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
      expect(queueBtn().textContent).toBe("≡ 50")
   })

   it("registers lock-screen next/prev ONLY while the queue is non-empty", () => {
      const setActionHandler = vi.fn()
      const ms = { metadata: null as unknown, playbackState: "none", setActionHandler }
      Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true })

      const [a] = putAudio(2)
      player.injectQueueChips()
      claim(a)
      const trackCalls = () =>
         setActionHandler.mock.calls.filter((c) => c[0] === "nexttrack" || c[0] === "previoustrack")
      // A plain claim never registers them (RDR16's rule stands without a queue).
      expect(trackCalls()).toHaveLength(0)
      chips()[1].click()
      expect(trackCalls().every((c) => typeof c[1] === "function")).toBe(true)
      chips()[1].click() // unqueue — back to unset, the platform greys them out
      const last = setActionHandler.mock.calls.filter((c) => c[0] === "nexttrack").at(-1)
      expect(last?.[1]).toBeNull()
   })

   it("previoustrack restarts past 3s, and re-enters the previous episode early on", () => {
      const setActionHandler = vi.fn()
      const ms = { metadata: null as unknown, playbackState: "none", setActionHandler }
      Object.defineProperty(navigator, "mediaSession", { value: ms, configurable: true })

      const [a, b] = putAudio(3)
      player.injectQueueChips()
      chips()[1].click() // queue b
      chips()[2].click() // queue c — keeps the queue non-empty after one advance
      claim(a)
      a.currentTime = 30

      const handler = (action: string) =>
         setActionHandler.mock.calls.filter((c) => c[0] === action).at(-1)?.[1] as (() => void) | null
      // Past the threshold: restart, same episode.
      handler("previoustrack")?.()
      expect(a.currentTime).toBe(0)
      expect(player.isActive()).toBe(true)
      // Advance to b, then step back within the threshold.
      handler("nexttrack")?.()
      expect(queueBtn().textContent).toBe("≡ 1")
      b.currentTime = 1
      handler("previoustrack")?.()
      // Back on a, with b re-queued at the FRONT — ⏮ then ⏭ round-trips.
      expect(queueBtn().textContent).toBe("≡ 2")
      expect(chips()[1].getAttribute("aria-pressed")).toBe("true")
      expect(a.currentTime).toBe(0)
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

      // No previoustrack/nexttrack: the lock screen must not become a way to
      // skip out of the episode you are listening to.
      const actions = setActionHandler.mock.calls.map((c) => c[0])
      expect(actions).toContain("play")
      expect(actions).toContain("seekforward")
      expect(actions).not.toContain("nexttrack")
      expect(actions).not.toContain("previoustrack")

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
   // maps them to cyclePrev/cycleNext, so unhandled they stepped the FILTER
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
      // duration is NaN on a cold element — no "/ --:--" noise.
      expect(q(".srr-player-time").textContent).toBe("1:05")
      withDuration(m, 3725)
      m.dispatchEvent(new Event("timeupdate"))
      expect(q(".srr-player-time").textContent).toBe("1:05 / 1:02:05")
   })
})
