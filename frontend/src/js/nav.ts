import * as data from "./data"

let pos = -1
let filter: { subs: Set<number>; tokens: string[] } | undefined
export let floorChron = 0

function resolveTokens(tokens: string[]): Set<number> {
   const ids = new Set<number>()
   for (const token of tokens) {
      const num = Number(token)
      if (Number.isFinite(num)) {
         ids.add(num)
      } else {
         for (const sub of Object.values(data.db.subscriptions)) {
            if (sub.tag === token) ids.add(sub.id)
         }
      }
   }
   return ids
}

function filterForSub(id: number) {
   return { subs: new Set([id]), tokens: [id.toString()] }
}

function findLeft(from: number, subs: Set<number>, floor: number): number {
   for (let i = from; i >= floor; i--) if (subs.has(data.getSubId(i))) return i
   return -1
}

function findRight(from: number, subs: Set<number>): number {
   const end = data.db.total_art
   for (let i = from; i < end; i++) if (subs.has(data.getSubId(i))) return i
   return -1
}

function countFiltered(from: number, to: number, subs: Set<number>): number {
   let count = 0
   for (let i = from; i < to; i++) if (subs.has(data.getSubId(i))) count++
   return count
}

function showFeed(article: IArticle): IShowFeed {
   if (filter === undefined) {
      return {
         article,
         has_left: pos > floorChron,
         has_right: pos < data.db.total_art - 1,
         filtered: false,
         floor: floorChron > 0,
         sub: data.db.subscriptions[article.s],
         countLeft: pos - floorChron,
      }
   }
   const { subs } = filter
   const countLeft = countFiltered(floorChron, pos, subs)
   return {
      article,
      has_left: countLeft > 0,
      has_right: findRight(pos + 1, subs) !== -1,
      filtered: true,
      floor: floorChron > 0,
      sub: data.db.subscriptions[article.s],
      countLeft,
   }
}

export async function fromHash(hash: string): Promise<IShowFeed> {
   const bangIdx = hash.indexOf("!")
   const mainAndFloor = bangIdx === -1 ? hash : hash.substring(0, bangIdx)
   const tildeIdx = mainAndFloor.indexOf("~")
   const main = tildeIdx === -1 ? mainAndFloor : mainAndFloor.substring(0, tildeIdx)
   const chronIdx = Number(main)

   filter = undefined
   if (bangIdx !== -1 && bangIdx < hash.length - 1) {
      const tokens = hash
         .substring(bangIdx + 1)
         .split("+")
         .filter((t) => t.length > 0)
      if (tokens.length > 0) {
         const subs = resolveTokens(tokens)
         if (subs.size > 0) filter = { subs, tokens }
      }
   }

   floorChron = tildeIdx !== -1 ? Math.max(0, Number(mainAndFloor.substring(tildeIdx + 1))) || 0 : 0
   return load(chronIdx, true)
}

export async function load(chronIdx: number, replace = false): Promise<IShowFeed> {
   if (data.db.total_art === 0) throw new Error("no articles")

   if (!Number.isFinite(chronIdx) || chronIdx < 0 || chronIdx >= data.db.total_art) chronIdx = data.db.total_art - 1

   pos = chronIdx

   if (filter !== undefined && !filter.subs.has(data.getSubId(pos))) {
      let found = findLeft(pos, filter.subs, floorChron)
      if (found !== -1) {
         pos = found
      } else {
         found = findRight(pos, filter.subs)
         if (found !== -1) pos = found
      }
   }

   const article = await data.loadArticle(pos)
   updateHash(replace)
   return showFeed(article)
}

export async function left(): Promise<IShowFeed> {
   if (filter !== undefined) {
      const found = findLeft(pos - 1, filter.subs, floorChron)
      if (found !== -1) pos = found
   } else {
      if (pos > floorChron) pos--
   }

   const article = await data.loadArticle(pos)
   updateHash()
   return showFeed(article)
}

export async function right(): Promise<IShowFeed> {
   if (filter !== undefined) {
      const found = findRight(pos + 1, filter.subs)
      if (found !== -1) pos = found
   } else {
      if (pos < data.db.total_art - 1) pos++
   }

   const article = await data.loadArticle(pos)
   updateHash()
   return showFeed(article)
}

export async function first(): Promise<IShowFeed> {
   if (floorChron === 0) {
      const article = await data.loadArticle(pos)
      return showFeed(article)
   }
   return load(floorChron)
}

export async function jumpToEnd(): Promise<IShowFeed> {
   return load(data.db.total_art - 1)
}

export async function last(subId?: string): Promise<IShowFeed> {
   if (subId !== undefined || filter === undefined) {
      const id = Number(subId ?? "")
      const sub = data.db.subscriptions[id]
      if (!sub || sub.total_art === 0) {
         filter = undefined
         return load(Number.MAX_SAFE_INTEGER)
      }
      filter = filterForSub(id)
   }

   const found = findLeft(data.db.total_art - 1, filter.subs, 0)
   if (found === -1) {
      filter = undefined
      return load(Number.MAX_SAFE_INTEGER)
   }

   pos = found
   const article = await data.loadArticle(pos)
   updateHash()
   return showFeed(article)
}

export async function toggleFilter(): Promise<IShowFeed> {
   if (filter === undefined) {
      filter = filterForSub(data.getSubId(pos))
   } else {
      filter = undefined
   }
   const article = await data.loadArticle(pos)
   updateHash()
   return showFeed(article)
}

export function setFilterSubs(p: Set<number> | undefined) {
   if (p === undefined) {
      filter = undefined
   } else {
      filter = {
         subs: p,
         tokens: Array.from(p)
            .sort((a, b) => a - b)
            .map(String),
      }
   }
}

export function setFilterTokens(tokens: string[] | undefined) {
   if (tokens === undefined) {
      filter = undefined
   } else {
      filter = { subs: resolveTokens(tokens), tokens }
   }
}

export async function applyFilter(tokens: string[] | undefined): Promise<IShowFeed> {
   setFilterTokens(tokens)
   if (filter !== undefined && !filter.subs.has(data.getSubId(pos))) {
      return load(pos)
   }
   const article = await data.loadArticle(pos)
   updateHash()
   return showFeed(article)
}

export function setFloorChron(idx: number) {
   floorChron = idx
}

export async function setFloorAt(idx: number): Promise<IShowFeed> {
   floorChron = idx
   const article = await data.loadArticle(pos)
   updateHash()
   return showFeed(article)
}

export function setFloorHere(): IShowFeed {
   floorChron = pos
   const article = data.getArticleSync(pos)!
   updateHash()
   return showFeed(article)
}

export function clearFloor(): IShowFeed {
   floorChron = 0
   const article = data.getArticleSync(pos)!
   updateHash()
   return showFeed(article)
}

export function getFilterEntries(): string[] {
   const subs = data.activeSubs()
   const tags = new Set<string>()
   const untagged: number[] = []
   for (const sub of subs) {
      if (sub.tag) tags.add(sub.tag)
      else untagged.push(sub.id)
   }
   const entries = [""]
   for (const tag of Array.from(tags).sort()) entries.push("tag:" + tag)
   for (const id of untagged) entries.push(String(id))
   return entries
}

// Map current filter state to a key matching getFilterEntries() format (""|"tag:x"|"id")
export function getCurrentFilterKey(): string {
   if (!filter) return ""
   if (filter.tokens.length === 1 && !Number.isFinite(Number(filter.tokens[0]))) return "tag:" + filter.tokens[0]
   if (filter.tokens.length === 1) return filter.tokens[0]
   // Multiple numeric tokens — check if they match a tag group
   const ids = new Set(filter.tokens.map(Number))
   for (const sub of Object.values(data.db.subscriptions)) {
      if (sub.tag && ids.has(sub.id)) return "tag:" + sub.tag
   }
   return ""
}

function updateHash(replace = false) {
   const floor = floorChron > 0 ? `~${floorChron}` : ""
   const tokens = filter !== undefined ? "!" + filter.tokens.join("+") : ""
   const hash = `#${pos}${floor}${tokens}`
   history[replace ? "replaceState" : "pushState"](null, "", hash)
}
