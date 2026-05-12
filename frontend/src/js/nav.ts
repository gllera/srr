import * as data from "./data"

let pos = -1

export const filter = {
   subs: new Map<number, number>(),
   subTotal: 0,
   tokens: [] as string[],
   get active() {
      return this.tokens.length > 0
   },
   matches(subId: number, chronIdx: number) {
      const addIdx = this.subs.get(subId)
      return addIdx !== undefined && chronIdx >= addIdx
   },
   // subTotal is derived from the idx scan so it matches findRight/findLeft
   // reachability — sum-of-total_art can overstate when idx and db.gz disagree.
   clear() {
      this.subs = new Map<number, number>()
      for (const sub of Object.values(data.db.subscriptions)) if (sub.total_art) this.subs.set(sub.id, sub.add_idx ?? 0)
      this.subTotal = data.countLeft(data.db.total_art, this.subs)
      this.tokens = []
   },
   set(tokens: string[]) {
      this.tokens = tokens
      this.subs = new Map<number, number>()
      for (const token of tokens) {
         const num = Number(token)
         if (Number.isFinite(num)) {
            const sub = data.db.subscriptions[num]
            if (sub?.total_art && !this.subs.has(num)) this.subs.set(num, sub.add_idx ?? 0)
         } else
            for (const sub of Object.values(data.db.subscriptions))
               if (sub.tag === token && sub.total_art && !this.subs.has(sub.id)) this.subs.set(sub.id, sub.add_idx ?? 0)
      }
      if (this.subs.size === 0) this.clear()
      else this.subTotal = data.countLeft(data.db.total_art, this.subs)
   },
}

function showFeed(article: IArticle): IShowFeed {
   const filteredLeft = data.countLeft(pos, filter.subs)
   const matchesPos = filter.matches(article.s, pos) ? 1 : 0
   const countRight = filter.subTotal - filteredLeft - matchesPos
   return {
      article,
      has_left: filteredLeft > 0,
      has_right: countRight > 0,
      filtered: filter.active,
      sub: data.db.subscriptions[article.s],
      countRight,
   }
}

async function resolve(target: number, replace = false): Promise<IShowFeed> {
   // Load first; commit pos only on success so a Retry replays the same chron.
   const article = await data.loadArticle(target)
   pos = target
   updateHash(replace)
   recordSeen(article)
   return showFeed(article)
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
   return Number.isFinite(n) ? seen["sub:" + n] : seen["tag:" + token]
}

function recordSeen(article: IArticle) {
   const sub = data.db.subscriptions[article.s]
   if (!sub) return
   try {
      const seen = readSeen()
      const subKey = "sub:" + article.s
      const tagKey = sub.tag ? "tag:" + sub.tag : null
      if (seen[subKey] === pos && (!tagKey || seen[tagKey] === pos)) return
      seen[subKey] = pos
      if (tagKey) seen[tagKey] = pos
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
   } catch {}
}

export function pruneSeen() {
   try {
      const seen = readSeen()
      const tags = new Set<string>()
      for (const sub of Object.values(data.db.subscriptions)) if (sub.tag) tags.add(sub.tag)
      let changed = false
      for (const key of Object.keys(seen)) {
         const stale =
            (key.startsWith("sub:") && !data.db.subscriptions[Number(key.slice(4))]) ||
            (key.startsWith("tag:") && !tags.has(key.slice(4)))
         if (stale) {
            delete seen[key]
            changed = true
         }
      }
      if (changed) localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
   } catch {}
}

function resolveNoMatch(): IShowFeed {
   updateHash()
   return {
      article: { s: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" },
      has_left: false,
      has_right: false,
      filtered: filter.active,
      sub: undefined,
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
              .map(decodeURIComponent)
   if (tokens.length > 0) filter.set(tokens)
   else filter.clear()

   if (data.db.total_art === 0) throw new Error("no articles")

   // Empty posStr → Number("")=0 would land on the oldest article; treat it
   // as "no target" so a first-time visitor with no stored hash sees latest.
   let target = posStr === "" ? NaN : Number(posStr)
   if (!Number.isFinite(target) || target < 0 || target >= data.db.total_art) target = data.db.total_art - 1

   if (!filter.matches(data.getSubId(target), target)) return last()
   return resolve(target, true)
}

// chronIdx of the next match on each side (-1 if none), without changing pos.
// Used by the UI to preload adjacent articles' data packs and images.
export function peekAdjacent(): { left: number; right: number } {
   return {
      left: data.findLeft(pos - 1, filter.subs),
      right: data.findRight(pos + 1, filter.subs),
   }
}

export async function left(): Promise<IShowFeed> {
   const found = data.findLeft(pos - 1, filter.subs)
   if (found === -1) throw new Error("no left match")
   return resolve(found)
}

export async function right(): Promise<IShowFeed> {
   const found = data.findRight(pos + 1, filter.subs)
   if (found === -1) throw new Error("no right match")
   return resolve(found)
}

export async function first(): Promise<IShowFeed> {
   // No article from a sub with add_idx N exists below chronIdx N, so the
   // earliest matching article is at or after the smallest add_idx in filter.
   const start = filter.subs.size > 0 ? Math.min(...filter.subs.values()) : 0
   return goTo(start)
}

export async function last(token?: string): Promise<IShowFeed> {
   if (token !== undefined) {
      if (token === "") filter.clear()
      else filter.set([token])
   }
   const found = data.findLeft(data.db.total_art - 1, filter.subs)
   if (found === -1) return resolveNoMatch()
   return resolve(found)
}

function isValidSeen(idx: number): boolean {
   return idx >= 0 && idx < data.db.total_art && filter.matches(data.getSubId(idx), idx)
}

export async function switchFilter(token: string): Promise<IShowFeed> {
   if (token === "") {
      filter.clear()
      return last()
   }
   filter.set([token])
   if (!filter.active) return last()
   const seenIdx = getSeen(token)
   if (seenIdx !== undefined && isValidSeen(seenIdx)) return resolve(seenIdx)
   return first()
}

// Jump to chronIdx, snapping forward to next match if filter is active.
export async function goTo(idx: number): Promise<IShowFeed> {
   if (idx < 0 || idx >= data.db.total_art) return last()
   const found = data.findRight(idx, filter.subs)
   return found === -1 ? last() : resolve(found)
}

export function getFilterEntries(): string[] {
   const { sortedTags, untagged } = data.groupSubsByTag()
   const entries = [""]
   for (const tag of sortedTags) entries.push(tag)
   for (const sub of untagged) entries.push(String(sub.id))
   return entries
}

// Map current filter state to a key matching getFilterEntries() format (""|"tagName"|"id")
export function getCurrentFilterKey(): string {
   if (!filter.active) return ""
   if (filter.tokens.length === 1) return filter.tokens[0]
   return ""
}

// "" guard: callers pass currentSource.tag/id which can be empty when no sub is set;
// without it, an active filter on "" (impossible) or callers' "" would falsely match.
export function isSingleFilter(token: string): boolean {
   return token !== "" && filter.tokens.length === 1 && filter.tokens[0] === token
}

export async function cycleFilter(dir: number): Promise<IShowFeed> {
   const entries = getFilterEntries()
   const current = getCurrentFilterKey()
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
