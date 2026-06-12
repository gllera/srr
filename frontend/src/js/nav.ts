import * as data from "./data"
import { extractImageUrls, getImgProxy, imgProxy } from "./fmt"

let pos = -1
let nextLeft: number | undefined
let nextRight: number | undefined

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
   nextLeft = nextRight = undefined
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
   if (target === -1 || typeof window.requestIdleCallback !== "function") return
   const my: HTMLImageElement[] = []
   currentPrefetch = my
   window.requestIdleCallback(
      async () => {
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
      },
      { timeout: 500 },
   )
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

function getSeen(token: string): number | undefined {
   const seen = readSeen()
   const n = Number(token)
   return Number.isFinite(n) ? seen["chan:" + n] : seen["tag:" + token]
}

function recordSeen(article: IArticle) {
   const ch = data.db.channels[article.s]
   if (!ch) return
   try {
      const seen = readSeen()
      const chanKey = "chan:" + article.s
      const tagKey = ch.tag ? "tag:" + ch.tag : null
      if (seen[chanKey] === pos && (!tagKey || seen[tagKey] === pos)) return
      seen[chanKey] = pos
      if (tagKey) seen[tagKey] = pos
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
   } catch {}
}

export function pruneSeen() {
   try {
      const seen = readSeen()
      const tags = new Set<string>()
      for (const ch of Object.values(data.db.channels)) if (ch.tag) tags.add(ch.tag)
      let changed = false
      for (const key of Object.keys(seen)) {
         const stale =
            (key.startsWith("chan:") && !data.db.channels[Number(key.slice(5))]) ||
            (key.startsWith("tag:") && !tags.has(key.slice(4)))
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

export async function left(): Promise<IShowFeed> {
   const target = nextLeft ?? (await data.findLeft(pos - 1, filter.channels))
   if (target === -1) throw new Error("no left match")
   const result = await resolve(target)
   nextLeft = await data.findLeft(pos - 1, filter.channels)
   schedulePrefetch(nextLeft)
   return result
}

export async function right(): Promise<IShowFeed> {
   const target = nextRight ?? (await data.findRight(pos + 1, filter.channels))
   if (target === -1) throw new Error("no right match")
   const result = await resolve(target)
   nextRight = await data.findRight(pos + 1, filter.channels)
   schedulePrefetch(nextRight)
   return result
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
