import * as data from "./data"
import { extractImageUrls, getImgProxy, imgProxy } from "./fmt"

let pos = -1
const next: { left?: Promise<number>; right?: Promise<number> } = {}

export const filter = {
   channels: new Map<number, number>(),
   chanTotal: 0,
   tokens: [] as string[],
   get active() {
      return this.tokens.length > 0
   },
   matches(chanId: number, chronIdx: number) {
      const addIdx = this.channels.get(chanId)
      return addIdx !== undefined && chronIdx >= addIdx
   },
   // chanTotal is derived from the idx scan so it matches findRight/findLeft
   // reachability — sum-of-total_art can overstate when idx and db.gz disagree.
   // countAll is synchronous (latest pack + its cumulative header), so the
   // filter object never waits on a pack fetch.
   clear() {
      this.channels = new Map<number, number>()
      for (const ch of Object.values(data.db.channels)) if (ch.total_art) this.channels.set(ch.id, ch.add_idx ?? 0)
      this.chanTotal = data.countAll(this.channels)
      this.tokens = []
   },
   set(tokens: string[]) {
      this.tokens = tokens
      this.channels = new Map<number, number>()
      for (const token of tokens) {
         const num = Number(token)
         if (Number.isFinite(num)) {
            const ch = data.db.channels[num]
            if (ch?.total_art && !this.channels.has(num)) this.channels.set(num, ch.add_idx ?? 0)
         } else
            for (const ch of Object.values(data.db.channels))
               if (ch.tag === token && ch.total_art && !this.channels.has(ch.id))
                  this.channels.set(ch.id, ch.add_idx ?? 0)
      }
      if (this.channels.size === 0) this.clear()
      else this.chanTotal = data.countAll(this.channels)
   },
}

async function showFeed(article: IArticle): Promise<IShowFeed> {
   // resolve() awaited loadArticle(pos) first, so the pos idx pack is
   // resident and this countLeft never fetches.
   const filteredLeft = await data.countLeft(pos, filter.channels)
   const matchesPos = filter.matches(article.s, pos) ? 1 : 0
   const countRight = filter.chanTotal - filteredLeft - matchesPos
   return {
      article,
      has_left: filteredLeft > 0,
      has_right: countRight > 0,
      filtered: filter.active,
      channel: data.db.channels[article.s],
      countRight,
   }
}

async function resolve(target: number, replace = false): Promise<IShowFeed> {
   // Load first; commit pos only on success so a Retry replays the same chron.
   const article = await data.loadArticle(target)
   pos = target
   next.left = next.right = undefined
   abortPrefetch()
   updateHash(replace)
   recordSeen(article)
   return showFeed(article)
}

// Holds refs to the last neighbor's prefetched Image objects so we can both
// abort their in-flight loads (img.src = "" per WHATWG image-update steps)
// and drop the references, bounding memory to one neighbor at a time. Array
// identity also acts as the freshness token: a pending idle callback that
// finds `my !== currentPrefetch` bails instead of pushing into a stale array.
let currentPrefetch: HTMLImageElement[] | null = null

function abortPrefetch() {
   if (currentPrefetch) for (const img of currentPrefetch) img.src = ""
   currentPrefetch = null
}

function schedulePrefetch(target: number) {
   if (target === -1) return
   const my: HTMLImageElement[] = []
   currentPrefetch = my
   const run = async () => {
      if (my !== currentPrefetch) return
      try {
         const art = await data.loadArticle(target)
         if (my !== currentPrefetch) return
         const proxyPrefix = getImgProxy()
         for (const raw of extractImageUrls(art.c)) {
            const img = new Image()
            img.fetchPriority = "low"
            img.decoding = "async"
            img.src = imgProxy(raw, proxyPrefix)
            my.push(img)
         }
      } catch {
         // Best-effort; errors surface on user nav.
      }
   }
   // WebKit has no requestIdleCallback — without the timeout fallback every
   // iOS reader would stall at each data-pack boundary instead of prefetching.
   if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 500 })
   else setTimeout(run, 200)
}

const SEEN_KEY = "srr-seen"

function readSeen(): Record<string, number> {
   try {
      const raw = localStorage.getItem(SEEN_KEY)
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}

// A channel stores its own seen position (chronIdx of the last article viewed
// from it). A tag has no position of its own: it continues from the furthest
// read (max seen chronIdx) of its member channels, so reading any channel in
// the tag advances the tag, and the tag badge agrees with the toolbar
// "articles to your right" you land on when you open it (switchFilter resumes
// at this same position). undefined === never seen on this device (channel) /
// no member channel seen yet (tag).
function getSeen(token: string): number | undefined {
   const seen = readSeen()
   const n = Number(token)
   if (Number.isFinite(n)) return seen["chan:" + n]
   let max: number | undefined
   for (const ch of Object.values(data.db.channels))
      if (ch.tag === token) {
         const s = seen["chan:" + ch.id]
         if (s !== undefined && (max === undefined || s > max)) max = s
      }
   return max
}

function recordSeen(article: IArticle) {
   const ch = data.db.channels[article.s]
   if (!ch) return
   try {
      // Only the channel position is stored; a tag's position is derived from
      // its channels in getSeen, so bumping the channel advances the tag too.
      const seen = readSeen()
      const chanKey = "chan:" + article.s
      if (seen[chanKey] === pos) return
      seen[chanKey] = pos
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
   } catch {}
}

// Articles belonging to `channels` strictly after `seenIdx` (the resume
// position). Both sides of the subtraction come from the same idx counting
// (countAll/countLeft) so db.gz total_art drift can't skew the result, and
// countLeft's boundary pack is the resident latest pack whenever the seen
// position is recent — zero fetches in the common case. Returns -1 when
// seenIdx is undefined: "unknown", not "zero" — a fresh localStorage would
// otherwise badge a channel/tag with its full history.
async function unreadAfter(channels: Map<number, number>, seenIdx: number | undefined): Promise<number> {
   if (seenIdx === undefined) return -1
   const upTo = Math.min(seenIdx + 1, data.db.total_art)
   return Math.max(0, data.countAll(channels) - (await data.countLeft(upTo, channels)))
}

// chan_id → add_idx map (the shape countAll/countLeft count over), for one
// channel or a whole group.
const chanMap = (chs: IChannel[]) => new Map(chs.map((c): [number, number] => [c.id, c.add_idx ?? 0]))

// Unread count for one channel: its articles strictly after the channel's seen
// position (recordSeen bumps that on every view, filtered or not, so reading
// via [ALL] clears badges too).
export function unreadCount(ch: IChannel): Promise<number> {
   return unreadAfter(chanMap([ch]), getSeen(String(ch.id)))
}

// Unread for a whole tag: its member channels' articles strictly after the
// tag's resume position — the furthest read (max seen chronIdx) of those
// channels (getSeen(tag)). So the tag-header badge equals the toolbar
// "articles to your right" the user lands on when they open the tag
// (switchFilter resumes at the same position). Because the anchor is the
// furthest-read channel, the tag badge is not the arithmetic sum of the
// channel rows beneath it — a channel left further behind contributes only the
// part of its backlog newer than that anchor.
export function tagUnreadCount(tag: string, group: IChannel[]): Promise<number> {
   return unreadAfter(chanMap(group), getSeen(tag))
}

// The headlines around the current position under the current filter: up to
// `span` matches each side plus the shown article, in chron order. The walk
// reuses the nav lookups (findLeft/findRight skip non-matching packs via the
// resident headers) and the data-pack LRU already holds the pos pack, so the
// common case costs zero fetches.
export async function peek(span = 10): Promise<IPeekItem[]> {
   if (pos === -1) return []
   // The two directional walks are independent — run them concurrently so
   // cold idx-pack fetches on both sides overlap.
   const walk = async (step: (i: number) => Promise<number>) => {
      const out: number[] = []
      let i = pos
      for (let n = 0; n < span; n++) {
         i = await step(i)
         if (i === -1) break
         out.push(i)
      }
      return out
   }
   const [lefts, rights] = await Promise.all([
      walk((i) => data.findLeft(i - 1, filter.channels)),
      walk((i) => data.findRight(i + 1, filter.channels)),
   ])
   const idxs = [...lefts.reverse(), pos, ...rights]
   return Promise.all(
      idxs.map(async (chron) => {
         const art = await data.loadArticle(chron)
         return {
            chron,
            // Raw wire fields — the display fallbacks ("(untitled)", the
            // "[DELETED]" tombstone) are the renderer's (dropdown
            // headlineRow), not navigation state.
            title: art.t ?? "",
            when: art.p || art.a,
            s: art.s,
            current: chron === pos,
         }
      }),
   )
}

export function pruneSeen() {
   try {
      const seen = readSeen()
      let changed = false
      for (const key of Object.keys(seen)) {
         // tag: entries are legacy — a tag's position now derives from its
         // member channels, so any stored tag: key is dead weight. A chan: key
         // for a deleted channel goes too.
         const stale = key.startsWith("tag:") || (key.startsWith("chan:") && !data.db.channels[Number(key.slice(5))])
         if (stale) {
            delete seen[key]
            changed = true
         }
      }
      if (changed) localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
   } catch {}
}

function resolveNoMatch(replace = false): IShowFeed {
   updateHash(replace)
   return {
      article: { s: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" },
      has_left: false,
      has_right: false,
      filtered: filter.active,
      channel: undefined,
      countRight: 0,
   }
}

export async function fromHash(hash: string): Promise<IShowFeed> {
   const bangIdx = hash.indexOf("!")
   const posStr = bangIdx === -1 ? hash : hash.substring(0, bangIdx)

   const tokens =
      bangIdx === -1
         ? []
         : hash
              .substring(bangIdx + 1)
              .split("+")
              .filter((t) => t.length > 0)
              .map((t) => {
                 // A malformed %-escape (e.g. a lone "%") makes decodeURIComponent
                 // throw; pass the raw token through instead of crashing navigation
                 // (an unrecoverable error popup + a hash that persists across reloads).
                 try {
                    return decodeURIComponent(t)
                 } catch {
                    return t
                 }
              })
   if (tokens.length > 0) filter.set(tokens)
   else filter.clear()

   if (data.db.total_art === 0) throw new Error("no articles")

   // Empty posStr → Number("")=0 would land on the oldest article; treat it
   // as "no target" so a first-time visitor with no stored hash sees latest.
   let target = posStr === "" ? NaN : Number(posStr)
   if (!Number.isFinite(target) || target < 0 || target >= data.db.total_art) target = data.db.total_art - 1

   if (!filter.matches(await data.getChannelId(target), target)) return last(undefined, true)
   return resolve(target, true)
}

// One directional navigation step. The post-navigation neighbor lookup is
// speculative, so it is stored as an un-awaited promise: findLeft/findRight
// may lazily fetch an idx pack, and that must neither delay the article
// already on screen nor reject a navigation that succeeded (a failed lookup
// just clears its slot; the next keypress retries on the critical path).
// The slot-identity checks keep a lookup superseded by a newer navigation
// from prefetching or clearing on its behalf.
async function step(dir: "left" | "right"): Promise<IShowFeed> {
   const lookup = () =>
      dir === "left" ? data.findLeft(pos - 1, filter.channels) : data.findRight(pos + 1, filter.channels)
   const target = await (next[dir] ?? lookup())
   if (target === -1) throw new Error(`no ${dir} match`)
   const result = await resolve(target)
   const mine = (next[dir] = lookup())
   mine
      .then((t) => {
         if (next[dir] === mine) schedulePrefetch(t)
      })
      .catch(() => {
         if (next[dir] === mine) next[dir] = undefined
      })
   return result
}

export function left(): Promise<IShowFeed> {
   return step("left")
}

export function right(): Promise<IShowFeed> {
   return step("right")
}

export async function first(): Promise<IShowFeed> {
   // No article from a channel with add_idx N exists below chronIdx N, so the
   // earliest matching article is at or after the smallest add_idx in filter.
   const start = filter.channels.size > 0 ? Math.min(...filter.channels.values()) : 0
   return goTo(start)
}

export async function last(token?: string, replace = false): Promise<IShowFeed> {
   if (token !== undefined) {
      if (token === "") filter.clear()
      else filter.set([token])
   }
   const found = await data.findLeft(data.db.total_art - 1, filter.channels)
   if (found === -1) return resolveNoMatch(replace)
   return resolve(found, replace)
}

async function isValidSeen(idx: number): Promise<boolean> {
   return idx >= 0 && idx < data.db.total_art && filter.matches(await data.getChannelId(idx), idx)
}

export async function switchFilter(token: string): Promise<IShowFeed> {
   if (token === "") {
      filter.clear()
      return last()
   }
   filter.set([token])
   if (!filter.active) return last()
   const seenIdx = getSeen(token)
   if (seenIdx !== undefined && (await isValidSeen(seenIdx))) return resolve(seenIdx)
   return first()
}

// Jump to chronIdx, snapping forward to next match if filter is active.
export async function goTo(idx: number): Promise<IShowFeed> {
   if (idx < 0 || idx >= data.db.total_art) return last()
   const found = await data.findRight(idx, filter.channels)
   return found === -1 ? last() : resolve(found)
}

export function getFilterEntries(): string[] {
   const { sortedTags, untagged } = data.groupChannelsByTag()
   const entries = [""]
   for (const tag of sortedTags) entries.push(tag)
   for (const ch of untagged) entries.push(String(ch.id))
   return entries
}

// Map current filter state to a key matching getFilterEntries() format (""|"tagName"|"id")
export function getCurrentFilterKey(): string {
   if (!filter.active) return ""
   if (filter.tokens.length === 1) return filter.tokens[0]
   return ""
}

// "" guard: callers pass currentChannel.tag/id which can be empty when no channel is set;
// without it, an active filter on "" (impossible) or callers' "" would falsely match.
export function isSingleFilter(token: string): boolean {
   return token !== "" && filter.tokens.length === 1 && filter.tokens[0] === token
}

export async function cycleFilter(dir: number): Promise<IShowFeed> {
   const entries = getFilterEntries()
   let current = getCurrentFilterKey()
   // A single-channel filter on a TAGGED channel has no entry of its own
   // (getFilterEntries lists tagged channels only by tag), so indexOf would
   // miss and cycling would snap to [ALL]. Resolve it to the channel's tag so
   // cycling continues relative to the current selection.
   if (current !== "" && filter.tokens.length === 1) {
      const num = Number(current)
      if (Number.isFinite(num)) {
         const ch = data.db.channels[num]
         if (ch?.tag) current = ch.tag
      }
   }
   let idx = entries.indexOf(current)
   if (idx === -1) idx = 0
   idx = (idx + dir + entries.length) % entries.length
   return switchFilter(entries[idx])
}

function updateHash(replace = false) {
   const tokens = filter.active ? "!" + filter.tokens.map(encodeURIComponent).join("+") : ""
   const hash = `#${pos}${tokens}`
   history[replace ? "replaceState" : "pushState"](null, "", hash)
}
