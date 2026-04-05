import * as data from "./data"
import * as ts from "./ts"

const { PACK_SIZE } = data

let packPos = -1
let filter: { subs: Set<number>; tokens: string[] } | undefined
export let floorChron = 0
let filterCountLeft: number | null = null
let filterAbsAtFloor = 0
let filterAbsEnd = 0

function resolveTokens(tokens: string[]): Set<number> {
   const ids = new Set<number>()
   for (const token of tokens) {
      const num = Number(token)
      if (Number.isFinite(num)) {
         ids.add(num)
      } else {
         for (const sub of data.db.subscriptions) {
            if (sub.tag === token) ids.add(sub.id)
         }
      }
   }
   return ids
}

function chronToIdxPack(chronIdx: number): { pack: number; pos: number } {
   const nf = data.numFinalizedIdx()
   const finalized = nf * PACK_SIZE
   if (chronIdx < finalized) {
      return { pack: Math.floor(chronIdx / PACK_SIZE), pos: chronIdx % PACK_SIZE }
   }
   return { pack: nf, pos: chronIdx - finalized }
}

function idxPackToChron(pack: number, posInPack: number): number {
   const nf = data.numFinalizedIdx()
   return (pack < nf ? pack : nf) * PACK_SIZE + posInPack
}

function currentChronIdx(): number {
   return idxPackToChron(data.idxPack, packPos)
}

// Navigation order: latest (nf) → highest finalized (nf-1) → ... → 0
function prevIdxPack(pack: number): number {
   const nf = data.numFinalizedIdx()
   if (pack >= nf) return nf > 0 ? nf - 1 : -1
   if (pack > 0) return pack - 1
   return -1
}

// Reverse: 0 → 1 → ... → nf-1 → latest (nf)
function nextIdxPack(pack: number): number {
   const nf = data.numFinalizedIdx()
   if (pack >= nf) return -1
   if (pack < nf - 1) return pack + 1
   return data.latestIdxCount() > 0 ? nf : -1
}

function filterForSub(id: number) {
   return { subs: new Set([id]), tokens: [id.toString()] }
}

function findEntryRight(from: number, subs: Set<number>): number {
   const arts = data.articles
   for (let i = from; i < arts.length; i++) if (subs.has(arts[i].sub_id)) return i
   return -1
}

function findEntryLeft(from: number, subs: Set<number>): number {
   const arts = data.articles
   for (let i = from; i >= 0; i--) if (subs.has(arts[i].sub_id)) return i
   return -1
}

// Scan across idx packs in the given direction for a matching filtered entry.
// Uses ts optimization when available, falls back to sequential scan.
// Restores the original pack if no match is found.
async function scanFilteredPacks(dir: -1 | 1, subs: Set<number>): Promise<boolean> {
   const savedPack = data.idxPack
   const find = dir < 0 ? () => findEntryLeft(data.articles.length - 1, subs) : () => findEntryRight(0, subs)

   function belowFloor(pack: number): boolean {
      return dir < 0 && idxPackToChron(pack, PACK_SIZE - 1) < floorChron && pack < data.numFinalizedIdx()
   }

   function matchAboveFloor(f: number): boolean {
      return dir > 0 || idxPackToChron(data.idxPack, f) >= floorChron
   }

   const candidates = await ts.findCandidateIdxPacks(data.articles[packPos].fetched_at, data.idxPack, subs, dir)

   if (candidates !== null) {
      for (const cp of candidates) {
         if (belowFloor(cp)) continue
         await data.loadIdxPack(cp)
         const f = find()
         if (f !== -1 && matchAboveFloor(f)) {
            packPos = f
            return true
         }
      }
   } else {
      const advance = dir < 0 ? prevIdxPack : nextIdxPack
      let np = advance(savedPack)
      while (np !== -1) {
         if (belowFloor(np)) break
         await data.loadIdxPack(np)
         const f = find()
         if (f !== -1 && matchAboveFloor(f)) {
            packPos = f
            return true
         }
         np = advance(np)
      }
   }

   await data.loadIdxPack(savedPack)
   return false
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

   const target = chronToIdxPack(chronIdx)
   await data.loadIdxPack(target.pack)

   if (!Number.isFinite(target.pos) || target.pos < 0 || target.pos >= data.articles.length)
      packPos = data.articles.length - 1
   else packPos = target.pos

   if (filter !== undefined && !filter.subs.has(data.articles[packPos].sub_id)) {
      // Snap to nearest matching article: prefer left (earlier), then right
      let found = findEntryLeft(packPos, filter.subs)
      if (found !== -1 && idxPackToChron(data.idxPack, found) >= floorChron) {
         packPos = found
      } else {
         found = findEntryRight(packPos, filter.subs)
         if (found !== -1) {
            packPos = found
         } else {
            // Search left across packs, then right
            if (!(await scanFilteredPacks(-1, filter.subs))) {
               await scanFilteredPacks(1, filter.subs)
            }
         }
      }
   }

   await computeFilterCount()
   updateHash(replace)
   return showFeed()
}

async function filteredAbsCount(chron: number, subs: Set<number>): Promise<number | null> {
   const entry = data.peekIdxEntry(chron)
   if (!entry) return null
   const result = await ts.filteredCountBefore(chron, entry.fetched_at, subs)
   if (!result) return null
   let count = result.count
   const target = chronToIdxPack(chron)
   const entries = data.peekIdxPack(target.pack)
   if (entries) {
      const packStart = chron - target.pos
      for (let i = Math.max(0, result.total - packStart); i < target.pos; i++) {
         if (subs.has(entries[i].sub_id)) count++
      }
   }
   return count
}

async function computeFilterCount(): Promise<void> {
   filterCountLeft = null
   filterAbsAtFloor = 0
   filterAbsEnd = 0
   if (filter === undefined) return
   const { subs } = filter
   const absCountP = filteredAbsCount(currentChronIdx(), subs)
   const floorAbsP = floorChron > 0 ? filteredAbsCount(floorChron, subs) : null
   const absCount = await absCountP
   if (absCount === null) return
   filterAbsAtFloor = (await floorAbsP) ?? 0
   filterCountLeft = absCount - filterAbsAtFloor
   for (const sub of data.db.subscriptions) {
      if (subs.has(sub.id)) filterAbsEnd += sub.total_art ?? 0
   }
}

function showFeed(): IShowFeed {
   const entry = data.articles[packPos]
   const chron = currentChronIdx()

   let has_left: boolean
   let has_right: boolean
   let countLeft: number | null
   if (filter === undefined) {
      has_left = chron > floorChron
      has_right = chron < data.db.total_art - 1
      countLeft = chron - floorChron
   } else {
      if (filterCountLeft !== null) {
         has_left = filterCountLeft > 0
         has_right = filterCountLeft < filterAbsEnd - filterAbsAtFloor - 1
      } else {
         const nearestLeft = findEntryLeft(packPos - 1, filter.subs)
         const foundLeft = nearestLeft !== -1 && idxPackToChron(data.idxPack, nearestLeft) >= floorChron
         const pp = prevIdxPack(data.idxPack)
         has_left = foundLeft || (pp !== -1 && idxPackToChron(pp, PACK_SIZE - 1) >= floorChron)

         const np = nextIdxPack(data.idxPack)
         has_right = np !== -1 || findEntryRight(packPos + 1, filter.subs) !== -1
      }

      countLeft = filterCountLeft
   }

   return {
      article: entry,
      has_left,
      has_right,
      filtered: filter !== undefined,
      floor: floorChron > 0,
      sub: data.db.subs_mapped.get(entry.sub_id),
      countLeft,
   }
}

export async function left(): Promise<IShowFeed> {
   if (filter !== undefined) {
      const prevChron = currentChronIdx()
      const found = findEntryLeft(packPos - 1, filter.subs)
      if (found !== -1 && idxPackToChron(data.idxPack, found) >= floorChron) {
         packPos = found
      } else {
         await scanFilteredPacks(-1, filter.subs)
      }
      if (filterCountLeft !== null && currentChronIdx() !== prevChron) filterCountLeft--
   } else {
      const chron = currentChronIdx()
      if (chron > floorChron) {
         if (packPos > 0) {
            packPos--
         } else {
            const pp = prevIdxPack(data.idxPack)
            if (pp !== -1) {
               await data.loadIdxPack(pp)
               packPos = data.articles.length - 1
            }
         }
      }
   }

   updateHash()
   return showFeed()
}

export async function right(): Promise<IShowFeed> {
   if (filter !== undefined) {
      const prevChron = currentChronIdx()
      const found = findEntryRight(packPos + 1, filter.subs)
      if (found !== -1) {
         packPos = found
      } else {
         await scanFilteredPacks(1, filter.subs)
      }
      if (filterCountLeft !== null && currentChronIdx() !== prevChron) filterCountLeft++
   } else {
      const chron = currentChronIdx()
      if (chron < data.db.total_art - 1) {
         if (packPos < data.articles.length - 1) {
            packPos++
         } else {
            const np = nextIdxPack(data.idxPack)
            if (np !== -1) {
               await data.loadIdxPack(np)
               packPos = 0
            }
         }
      }
   }

   updateHash()
   return showFeed()
}

export async function first(): Promise<IShowFeed> {
   if (floorChron === 0) return showFeed()
   return load(floorChron)
}

export async function jumpToEnd(): Promise<IShowFeed> {
   return load(data.db.total_art - 1)
}

export async function last(subId?: string): Promise<IShowFeed> {
   if (subId !== undefined || filter === undefined) {
      const id = Number(subId ?? "")
      const sub = data.db.subs_mapped.get(id)
      if (!sub || sub.total_art === 0) {
         filter = undefined
         return load(Number.MAX_SAFE_INTEGER)
      }
      filter = filterForSub(id)
   }

   const filterSet = filter.subs
   const nf = data.numFinalizedIdx()
   const latestCount = data.latestIdxCount()

   function tryPack(): boolean {
      const f = findEntryLeft(data.articles.length - 1, filterSet)
      if (f === -1) return false
      packPos = f
      return true
   }

   let found = false

   // Try latest pack first if it has articles
   if (latestCount > 0) {
      await data.loadIdxPack(nf)
      found = tryPack()
   }

   // Scan finalized packs from highest to lowest
   if (!found) {
      const candidates = await ts.findCandidateIdxPacks(data.db.fetched_at, nf, filterSet, -1)
      if (candidates !== null) {
         for (const cp of candidates) {
            await data.loadIdxPack(cp)
            if (tryPack()) {
               found = true
               break
            }
         }
      } else {
         for (let p = nf - 1; p >= 0; p--) {
            await data.loadIdxPack(p)
            if (tryPack()) {
               found = true
               break
            }
         }
      }
   }

   if (!found) {
      // Sub not found in any pack, go to latest unfiltered
      filter = undefined
      return load(Number.MAX_SAFE_INTEGER)
   }

   await computeFilterCount()
   updateHash()
   return showFeed()
}

export async function toggleFilter(): Promise<IShowFeed> {
   if (filter === undefined) {
      filter = filterForSub(data.articles[packPos].sub_id)
   } else {
      filter = undefined
   }
   await computeFilterCount()
   updateHash()
   return showFeed()
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
   if (filter !== undefined && !filter.subs.has(data.articles[packPos].sub_id)) {
      return load(currentChronIdx())
   }
   await computeFilterCount()
   updateHash()
   return showFeed()
}

export function setFloorChron(idx: number) {
   floorChron = idx
   filterAbsAtFloor = 0
}

export async function setFloorAt(idx: number): Promise<IShowFeed> {
   floorChron = idx
   filterAbsAtFloor = 0
   await computeFilterCount()
   updateHash()
   return showFeed()
}

export function setFloorHere(): IShowFeed {
   floorChron = currentChronIdx()
   if (filterCountLeft !== null) {
      filterAbsAtFloor += filterCountLeft
      filterCountLeft = 0
   }
   updateHash()
   return showFeed()
}

export function clearFloor(): IShowFeed {
   floorChron = 0
   if (filterCountLeft !== null) {
      filterCountLeft += filterAbsAtFloor
   }
   filterAbsAtFloor = 0
   updateHash()
   return showFeed()
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
   for (const sub of data.db.subscriptions) {
      if (sub.tag && ids.has(sub.id)) return "tag:" + sub.tag
   }
   return ""
}

function updateHash(replace = false) {
   const floor = floorChron > 0 ? `~${floorChron}` : ""
   const tokens = filter !== undefined ? "!" + filter.tokens.join("+") : ""
   const hash = `#${currentChronIdx()}${floor}${tokens}`
   history[replace ? "replaceState" : "pushState"](null, "", hash)
}
