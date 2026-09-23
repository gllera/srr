// player/relocation.ts — the reader.ts seam: moving the live media element out
// of the article before a render destroys it, and back when you return.
//
// Relocation is about SURVIVAL and is deliberately NOT reactive: reader.ts calls
// these at fixed points of its render (harvest → adopt → replace → restore →
// rehome), and FEB2 pairs saved state to elements BY INDEX, so the moves must
// happen exactly there and nowhere else. Nothing the player SHOWS depends on
// where the element sits (the full player's video frame is CSS `:not(:empty)`
// on the host), so a move writes no state either.
import { mediaList } from "../article-view"
import { el } from "../els"
import { active } from "./state"

// Called by reader.ts BEFORE replaceChildren and AFTER harvestMediaState.
//
// The ordering is load-bearing and not recoverable from either function alone:
// FEB2 pairs its saved state to elements BY INDEX over querySelectorAll, so
// moving the live element out first would shift every index after it and
// misalign the whole article's saved positions.
export function adoptFromContent(): void {
   const a = active()
   if (!a || !el.content.contains(a.media)) return
   const m = a.media
   // One appendChild = remove + insert in a single synchronous operation, so the
   // spec's "not in a document at stable state" pause check never fires. This is
   // the line the whole feature rests on.
   el.playerMedia.appendChild(m)
   // Custom chrome drives it in the player; fmt.ts's forced `controls` would
   // render a second native transport inside the player's frame.
   m.removeAttribute("controls")
}

// Called by reader.ts AFTER replaceChildren and restoreMediaState. Swaps the live
// element back in for the freshly parsed one at the same index — the fresh
// element's just-restored position is discarded, because the live element is the
// one carrying the truth.
export function rehomeInto(mid: string, chron: number): void {
   const a = active()
   if (!a || a.mid !== mid || a.chron !== chron) return
   if (el.content.contains(a.media)) return
   const fresh = mediaList(el.content)[a.index]
   // The article no longer renders media at that index (a compacted payload, a
   // changed pipeline). Keep playing in the player rather than dropping it.
   if (!fresh) return
   // replaceWith moves the live element in and takes the fresh one out; the live
   // element is in the document throughout, so playback continues. It stays this
   // way round even though `fresh` is the authoritative sanitized node: by now
   // the live element may be PLAYING (the player has a play button, and restore
   // hands the episode back paused), and handing playback to `fresh` would
   // reintroduce the re-buffer gap this module exists to avoid.
   fresh.replaceWith(a.media)
   // So carry the sanitizer's presentation attributes across instead. On the
   // claimed-element path this is a no-op — same node, same attributes — but the
   // restore path's element was built by us and has none of them: fmt.ts forces
   // `controls` on in-content audio (a control-less feed <audio> renders no
   // player at all) and `playsinline` on non-autoplay video, without which iOS
   // takes a returning episode fullscreen, plus whatever `poster` the feed
   // carried. Only attributes the live element LACKS are copied, which is what
   // keeps `src` — already set, and re-setting it would restart the load.
   for (const attr of fresh.attributes) {
      if (!a.media.hasAttribute(attr.name)) a.media.setAttribute(attr.name, attr.value)
   }
   a.media.setAttribute("controls", "")
}

// Drop an adopted node from the player. Only ever called for a released episode
// — the element is not going home, so nothing else can reach it.
export function discardAdopted(): void {
   const held = el.playerMedia.firstElementChild
   if (held instanceof HTMLMediaElement) {
      held.pause()
      held.remove()
   }
}
