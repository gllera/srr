// tts.ts — narration sync for srr-tts articles: highlight the block being
// read, click a block to seek the narration there.
//
// The writer side (srr-tts, in the toolbox repo) synthesizes per block
// segment and ships two attributes through #sanitize's allowlist: the
// narration <audio> carries data-tts-t="0,4.2,…" (segment start seconds),
// and each narrated block carries data-tts="<segment index>". Segment 0 is
// the article TITLE when the item has one — no content element carries 0
// then, and this module highlights the caller's title node instead.
//
// A LEAF module by the article-view.ts rule: nodes arrive as arguments, no
// controller imports. reader.ts calls wireTTS once per mount, AFTER
// player.injectQueueChips() — listeners bind to the ELEMENT, so they survive
// player.ts's adopt/rehome relocation; while the article is unmounted the
// handler just finds detached targets and paints nothing visible. Wiring
// the next article (or an empty render) unbinds the previous audio.
//
// Click-to-seek arms only once the narration has STARTED (playing, or
// paused off zero): a cold article must never hijack an ordinary text
// click. Seeking while paused stays paused — position moves, playback
// doesn't. Clicks on interactive descendants (links, media, buttons) and
// clicks that are really text selections pass through untouched.

export interface TTSRefs {
   title: HTMLElement
   content: HTMLElement
}

interface Binding {
   refs: TTSRefs
   audio: HTMLAudioElement
   starts: number[]
   targets: Map<number, HTMLElement>
   current: HTMLElement | null
}

let b: Binding | null = null

// Interactive descendants a seek-click must never shadow. summary keeps
// <details> toggling; label covers feed-supplied form-ish markup the
// sanitizer lets through as text containers.
const INTERACTIVE = "a, audio, video, img, button, summary, input, select, textarea, label"

function started(audio: HTMLAudioElement): boolean {
   return !audio.paused || audio.currentTime > 0
}

function segmentAt(starts: number[], t: number): number {
   let i = starts.length - 1
   while (i > 0 && starts[i] > t) i--
   return i
}

function paint(): void {
   if (!b) return
   const el = b.targets.get(segmentAt(b.starts, b.audio.currentTime)) ?? null
   if (el !== b.current) {
      b.current?.classList.remove("srr-tts-current")
      el?.classList.add("srr-tts-current")
      b.current = el
   }
   b.refs.content.classList.toggle("srr-tts-live", started(b.audio) && !b.audio.ended)
}

function clear(): void {
   if (!b) return
   b.current?.classList.remove("srr-tts-current")
   b.current = null
   b.refs.content.classList.remove("srr-tts-live")
}

function onTick(): void {
   paint()
}

function onEnded(): void {
   clear()
}

function onSeekClick(e: Event): void {
   if (!b || !started(b.audio)) return
   const t = e.target as Element | null
   if (!t || t.closest(INTERACTIVE)) return
   const sel = window.getSelection()
   if (sel && !sel.isCollapsed) return // a selection gesture, not a seek
   let idx: number | null = null
   const block = t.closest("[data-tts]")
   if (block && b.refs.content.contains(block)) idx = Number(block.getAttribute("data-tts"))
   // The title node seeks to 0 only when it OWNS segment 0 — i.e. wireTTS
   // installed it as the fallback because no content block carries the stamp.
   else if (b.refs.title.contains(t) && b.targets.get(0) === b.refs.title) idx = 0
   if (idx === null || !(idx in b.starts)) return
   b.audio.currentTime = b.starts[idx]
   paint()
}

function unbind(): void {
   if (!b) return
   clear()
   b.audio.removeEventListener("timeupdate", onTick)
   b.audio.removeEventListener("seeked", onTick)
   b.audio.removeEventListener("play", onTick)
   b.audio.removeEventListener("ended", onEnded)
   b.audio.removeEventListener("emptied", onEnded)
   b.refs.content.removeEventListener("click", onSeekClick)
   b.refs.title.removeEventListener("click", onSeekClick)
   b = null
}

// Scan the freshly-mounted article surface and bind if it carries a
// narration. Safe to call on every mount, narrated or not.
export function wireTTS(refs: TTSRefs): void {
   unbind()
   const audio = refs.content.querySelector<HTMLAudioElement>("audio[data-tts-t]")
   if (!audio) return
   const starts = (audio.getAttribute("data-tts-t") ?? "").split(",").map(Number)
   // A hostile or mangled table stays inert: every entry must be a finite,
   // non-negative, non-decreasing second count.
   if (!starts.length || starts.some((s, i) => !Number.isFinite(s) || s < 0 || (i > 0 && s < starts[i - 1]))) return
   const targets = new Map<number, HTMLElement>()
   for (const el of refs.content.querySelectorAll<HTMLElement>("[data-tts]")) {
      const i = Number(el.getAttribute("data-tts"))
      if (Number.isInteger(i) && i >= 0 && !targets.has(i)) targets.set(i, el)
   }
   if (!targets.has(0)) targets.set(0, refs.title) // the title segment
   b = { refs, audio, starts, targets, current: null }
   audio.addEventListener("timeupdate", onTick)
   audio.addEventListener("seeked", onTick)
   audio.addEventListener("play", onTick)
   audio.addEventListener("ended", onEnded)
   audio.addEventListener("emptied", onEnded)
   refs.content.addEventListener("click", onSeekClick)
   refs.title.addEventListener("click", onSeekClick)
}
