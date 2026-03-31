import { makeLRU } from "./cache"
import { PACK_SIZE, db, numFinalizedIdx, streamSplit } from "./data"

const SECS_PER_WEEK = 604800

interface TsLine {
   offset: number
   total: number
   subs: Map<number, number>
   lastAdded?: Map<number, number>
}

const tsCache = makeLRU<TsLine[]>(10)

// Empty array in cache = confirmed missing (negative cache)
async function loadTsPack(week: number): Promise<TsLine[] | null> {
   const cached = tsCache.get(week)
   if (cached) return cached.length > 0 ? cached : null

   // Skip weeks before any data exists or after the current fetch
   const firstWeek = Math.floor(db.first_fetched / SECS_PER_WEEK)
   const currentWeek = Math.floor(db.fetched_at / SECS_PER_WEEK)
   if (week < firstWeek || week > currentWeek) {
      tsCache.put(week, [])
      return null
   }

   const isFinalized = week < currentWeek
   const name = isFinalized ? week.toString() : String(db.ts_tog)

   try {
      const lines = await streamSplit(`ts/${name}.gz`, isFinalized, "\n", parseTsLine)
      tsCache.put(week, lines)
      return lines
   } catch {
      tsCache.put(week, [])
      return null
   }
}

// TSV format: offset, total, then (sub_id, count[, last_added]) pairs.
// First line (offset=0) is absolute: includes last_added per sub (step=3).
// Subsequent lines are deltas: sub_id + count only (step=2).
function parseTsLine(line: string): TsLine {
   const f = line.split("\t")
   const offset = Number(f[0])
   const total = Number(f[1])
   const subs = new Map<number, number>()
   const isAbs = offset === 0
   const lastAdded = isAbs ? new Map<number, number>() : undefined
   const step = isAbs ? 3 : 2
   for (let i = 2; i + 1 < f.length; i += step) {
      const id = Number(f[i])
      subs.set(id, Number(f[i + 1]))
      if (isAbs) lastAdded!.set(id, Number(f[i + 2]))
   }
   return { offset, total, subs, lastAdded }
}

// Follow the lastAdded chain backwards to find which weeks contain articles for these subs,
// then return them in chronological order for forward scanning
async function findRelevantWeeksForward(startWeek: number, subs: Set<number>): Promise<number[]> {
   let maxLA = 0
   for (const s of subs) {
      const sub = db.subs_mapped.get(s)
      if (sub?.last_added && sub.last_added > maxLA) maxLA = sub.last_added
   }
   if (maxLA === 0) return []

   let targetWeek = Math.floor(maxLA / SECS_PER_WEEK)
   const weeks: number[] = []

   while (targetWeek > startWeek) {
      weeks.push(targetWeek)
      const pack = await loadTsPack(targetWeek)
      if (!pack || pack.length === 0 || !pack[0].lastAdded) break

      let maxPrev = 0
      for (const s of subs) {
         const la = pack[0].lastAdded.get(s)
         if (la !== undefined && la > maxPrev) maxPrev = la
      }
      if (maxPrev === 0) break
      const prevWeek = Math.floor(maxPrev / SECS_PER_WEEK)
      if (prevWeek >= targetWeek) break
      targetWeek = prevWeek
   }

   weeks.reverse()
   return weeks
}

export async function findChronForTimestamp(ts: number): Promise<number | null> {
   const week = Math.floor(ts / SECS_PER_WEEK)
   const offset = ts % SECS_PER_WEEK
   const lines = await loadTsPack(week)
   if (!lines || lines.length === 0) return null
   let best = lines[0]
   for (let i = 1; i < lines.length; i++) {
      if (lines[i].offset <= offset) best = lines[i]
      else break
   }
   return best.total
}

export async function findCandidateIdxPacks(
   fetchedAt: number,
   currentPack: number,
   subs: Set<number>,
   dir: -1 | 1,
): Promise<number[] | null> {
   const startWeek = Math.floor(fetchedAt / SECS_PER_WEEK)
   const startOffset = fetchedAt % SECS_PER_WEEK

   let lines = await loadTsPack(startWeek)
   if (!lines || lines.length === 0) return null

   let startLine = 0
   for (let i = 0; i < lines.length; i++) {
      if (lines[i].offset <= startOffset) startLine = i
      else break
   }

   const candidates: number[] = []
   const seen = new Set([currentPack])
   const nf = numFinalizedIdx()

   function addPacks(lo: number, hi: number) {
      if (hi < 0 || lo > hi) return
      const pLo = Math.floor(lo / PACK_SIZE)
      const pHi = Math.floor(hi / PACK_SIZE)
      const start = dir < 0 ? Math.min(pHi, currentPack) : Math.max(pLo, currentPack)
      const end = dir < 0 ? pLo : pHi
      for (let p = start; dir < 0 ? p >= end : p <= end; p += dir) {
         const a = Math.min(p, nf)
         if (!seen.has(a)) {
            seen.add(a)
            candidates.push(a)
         }
      }
   }

   function hasSub(line: TsLine): boolean {
      for (const s of subs) if (line.subs.has(s)) return true
      return false
   }

   if (dir < 0) {
      // Scan backward through weeks using lastAdded jumps
      let i = startLine
      let week = startWeek
      while (true) {
         while (i >= 1) {
            if (hasSub(lines[i])) addPacks(lines[i - 1].total, lines[i].total - 1)
            i--
         }
         let jumpTarget = -1
         if (lines[0].lastAdded) {
            for (const s of subs) {
               const la = lines[0].lastAdded.get(s)
               if (la !== undefined && la > 0) {
                  const w = Math.floor(la / SECS_PER_WEEK)
                  if (w > jumpTarget) jumpTarget = w
               }
            }
         }
         week = jumpTarget >= 0 && jumpTarget < week ? jumpTarget : week - 1
         const prev = await loadTsPack(week)
         if (!prev || prev.length === 0) {
            if (lines[0].total > 0 && hasSub(lines[0])) addPacks(0, lines[0].total - 1)
            break
         }
         lines = prev
         i = lines.length - 1
      }
   } else {
      // Scan forward through weeks using relevant-weeks chain
      let prevTotal = lines[startLine].total
      let i = startLine + 1
      let week = startWeek
      let fwdWeeks: number[] | undefined
      let fwdIdx = 0
      while (true) {
         while (i < lines.length) {
            if (hasSub(lines[i])) addPacks(prevTotal, lines[i].total - 1)
            prevTotal = lines[i].total
            i++
         }
         if (!fwdWeeks) {
            fwdWeeks = await findRelevantWeeksForward(week, subs)
            fwdIdx = 0
         }
         if (fwdIdx >= fwdWeeks.length) break
         week = fwdWeeks[fwdIdx++]
         const next = await loadTsPack(week)
         if (!next || next.length === 0) break
         lines = next
         if (lines[0].offset === 0) {
            prevTotal = lines[0].total
            i = 1
         } else {
            i = 0
         }
      }
   }

   return candidates
}
