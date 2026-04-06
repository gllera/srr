import * as data from "./data"

export let floorChron = 0
let pos = -1
let filteredLeft = 0
let filteredTotal = 0
let floorCount = 0

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
   clear() {
      this.subs = new Map<number, number>()
      this.subTotal = 0
      for (const sub of Object.values(data.db.subscriptions))
         if (sub.total_art) {
            this.subs.set(sub.id, sub.add_idx ?? 0)
            this.subTotal += sub.total_art
         }
      this.tokens = []
   },
   set(tokens: string[]) {
      this.tokens = tokens
      this.subs = new Map<number, number>()
      this.subTotal = 0
      for (const token of tokens) {
         const num = Number(token)
         if (Number.isFinite(num)) {
            const sub = data.db.subscriptions[num]
            if (sub?.total_art && !this.subs.has(num)) {
               this.subs.set(num, sub.add_idx ?? 0)
               this.subTotal += sub.total_art
            }
         } else
            for (const sub of Object.values(data.db.subscriptions))
               if (sub.tag === token && sub.total_art && !this.subs.has(sub.id)) {
                  this.subs.set(sub.id, sub.add_idx ?? 0)
                  this.subTotal += sub.total_art
               }
      }
      if (this.subs.size === 0) this.clear()
   },
}

function findLeft(from: number, floor: number): number {
   for (let i = from; i >= floor; i--) if (filter.matches(data.getSubId(i), i)) return i
   return -1
}

function findRight(from: number): number {
   const end = data.db.total_art
   for (let i = from; i < end; i++) if (filter.matches(data.getSubId(i), i)) return i
   return -1
}

function recount() {
   floorCount = floorChron > 0 ? data.countLeft(floorChron, filter.subs) : 0
   filteredTotal = filter.subTotal - floorCount
   filteredLeft = data.countLeft(pos, filter.subs) - floorCount
}

function showFeed(article: IArticle): IShowFeed {
   return {
      article,
      has_left: filteredLeft > 0,
      has_right: filteredLeft + (filter.matches(data.getSubId(pos), pos) ? 1 : 0) < filteredTotal,
      filtered: filter.active,
      floor: floorChron > 0,
      sub: data.db.subscriptions[article.s],
      countLeft: filteredLeft,
   }
}

async function resolve(replace = false): Promise<IShowFeed> {
   recount()
   const article = await data.loadArticle(pos)
   updateHash(replace)
   return showFeed(article)
}

export async function fromHash(hash: string): Promise<IShowFeed> {
   const bangIdx = hash.indexOf("!")
   const main = bangIdx === -1 ? hash : hash.substring(0, bangIdx)
   const commaIdx = main.indexOf(",")
   const floorStr = commaIdx === -1 ? "" : main.substring(0, commaIdx)
   const posStr = commaIdx === -1 ? main : main.substring(commaIdx + 1)
   const chronIdx = Number(posStr)

   filter.clear()
   if (bangIdx !== -1 && bangIdx < hash.length - 1) {
      const tokens = hash
         .substring(bangIdx + 1)
         .split("+")
         .filter((t) => t.length > 0)
      if (tokens.length > 0) filter.set(tokens)
   }

   floorChron = commaIdx !== -1 ? Math.max(0, Number(floorStr)) || 0 : 0
   return load(chronIdx, true)
}

export async function load(chronIdx: number, replace = false): Promise<IShowFeed> {
   if (data.db.total_art === 0) throw new Error("no articles")

   if (!Number.isFinite(chronIdx) || chronIdx < 0 || chronIdx >= data.db.total_art) chronIdx = data.db.total_art - 1

   pos = chronIdx

   if (!filter.matches(data.getSubId(pos), pos)) {
      let found = findLeft(pos, floorChron)
      if (found !== -1) {
         pos = found
      } else {
         found = findRight(pos)
         if (found !== -1) pos = found
      }
   }

   return resolve(replace)
}

export async function left(): Promise<IShowFeed> {
   const found = findLeft(pos - 1, floorChron)
   if (found !== -1) {
      pos = found
      filteredLeft--
   }
   const article = await data.loadArticle(pos)
   updateHash()
   return showFeed(article)
}

export async function right(): Promise<IShowFeed> {
   const found = findRight(pos + 1)
   if (found !== -1) {
      pos = found
      filteredLeft++
   }
   const article = await data.loadArticle(pos)
   updateHash()
   return showFeed(article)
}

export async function first(): Promise<IShowFeed> {
   let start = Infinity
   for (const addIdx of filter.subs.values()) if (addIdx < start) start = addIdx
   if (start === Infinity) return noMatch()
   if (floorChron > start) start = floorChron
   const found = findRight(start)
   if (found === -1) return noMatch()
   pos = found
   return resolve()
}

export async function last(): Promise<IShowFeed> {
   const found = findLeft(data.db.total_art - 1, floorChron)
   if (found === -1) return noMatch()
   pos = found
   return resolve()
}

function noMatch(): IShowFeed {
   return {
      article: { s: 0, a: 0, p: 0, t: "(no matching articles)", l: "", c: "" },
      has_left: false,
      has_right: false,
      filtered: filter.active,
      floor: floorChron > 0,
      sub: undefined,
      countLeft: 0,
   }
}

export async function toggleFilter(): Promise<IShowFeed> {
   if (filter.active) {
      filter.clear()
   } else {
      filter.set([String(data.getSubId(pos))])
   }
   return resolve()
}

export async function applyFilter(tokens: string[] | undefined): Promise<IShowFeed> {
   if (!tokens) filter.clear()
   else filter.set(tokens)
   if (!filter.matches(data.getSubId(pos), pos)) {
      return load(pos)
   }
   return resolve()
}

export function setFloorChron(idx: number) {
   floorChron = idx
}

export async function setFloorAt(idx: number): Promise<IShowFeed> {
   floorChron = idx
   return resolve()
}

export function setFloorHere(): IShowFeed {
   floorChron = pos
   floorCount += filteredLeft
   filteredTotal -= filteredLeft
   filteredLeft = 0
   const article = data.getArticleSync(pos)!
   updateHash()
   return showFeed(article)
}

export function clearFloor(): IShowFeed {
   floorChron = 0
   filteredLeft += floorCount
   filteredTotal += floorCount
   floorCount = 0
   const article = data.getArticleSync(pos)!
   updateHash()
   return showFeed(article)
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
   if (filter.tokens.length === 1 && !Number.isFinite(Number(filter.tokens[0]))) return filter.tokens[0]
   if (filter.tokens.length === 1) return filter.tokens[0]
   // Multiple numeric tokens — check if they match a tag group
   const ids = new Set(filter.tokens.map(Number))
   for (const sub of Object.values(data.db.subscriptions)) {
      if (sub.tag && ids.has(sub.id)) return sub.tag
   }
   return ""
}

export async function cycleFilter(dir: number): Promise<IShowFeed> {
   const entries = getFilterEntries()
   const current = getCurrentFilterKey()
   let idx = entries.indexOf(current)
   if (idx === -1) idx = 0
   idx = (idx + dir + entries.length) % entries.length
   const value = entries[idx]
   return applyFilter(value === "" ? undefined : [value])
}

function updateHash(replace = false) {
   const tokens = filter.active ? "!" + filter.tokens.join("+") : ""
   const hash = `#${floorChron},${pos}${tokens}`
   history[replace ? "replaceState" : "pushState"](null, "", hash)
}
