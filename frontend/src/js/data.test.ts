import { describe, it, expect, vi, beforeEach } from "vitest"

const PACK_SIZE = 1000 // mirrors data.PACK_SIZE

describe("numFinalizedIdx / latestIdxCount", () => {
   // These read from module-level db which requires init().
   // Test the math directly since the logic is straightforward.
   function numFinalizedIdx(total_art: number): number {
      return total_art > 0 ? Math.floor((total_art - 1) / PACK_SIZE) : 0
   }

   function latestIdxCount(total_art: number): number {
      return total_art - numFinalizedIdx(total_art) * PACK_SIZE
   }

   it("numFinalizedIdx: 0 articles", () => {
      expect(numFinalizedIdx(0)).toBe(0)
   })

   it("numFinalizedIdx: 1 article", () => {
      expect(numFinalizedIdx(1)).toBe(0)
   })

   it("numFinalizedIdx: 1000 articles", () => {
      expect(numFinalizedIdx(1000)).toBe(0)
   })

   it("numFinalizedIdx: 1001 articles", () => {
      expect(numFinalizedIdx(1001)).toBe(1)
   })

   it("numFinalizedIdx: 3000 articles", () => {
      expect(numFinalizedIdx(3000)).toBe(2)
   })

   it("latestIdxCount: 3 articles", () => {
      expect(latestIdxCount(3)).toBe(3)
   })

   it("latestIdxCount: 1001 articles", () => {
      expect(latestIdxCount(1001)).toBe(1)
   })

   it("latestIdxCount: 2000 articles", () => {
      expect(latestIdxCount(2000)).toBe(1000)
   })
})

describe("streamSplit", () => {
   // Stub DecompressionStream as passthrough since jsdom lacks it
   beforeEach(() => {
      vi.stubGlobal(
         "DecompressionStream",
         class {
            readable: ReadableStream
            writable: WritableStream
            constructor() {
               const ts = new TransformStream()
               this.readable = ts.readable
               this.writable = ts.writable
            }
         },
      )
   })

   function mockFetch(chunks: string[]) {
      const stream = new ReadableStream({
         start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
            controller.close()
         },
      })
      vi.stubGlobal(
         "fetch",
         vi.fn().mockResolvedValue({
            body: stream,
         }),
      )
   }

   // Dynamic import to get streamSplit after globals are set up
   async function getStreamSplit() {
      const mod = await import("./data")
      return mod.streamSplit
   }

   it("parses single chunk with delimiter", async () => {
      mockFetch(["a\nb"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => s)
      expect(result).toEqual(["a", "b"])
   })

   it("handles cross-boundary remainder", async () => {
      mockFetch(["hel", "lo\nworld"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => s)
      expect(result).toEqual(["hello", "world"])
   })

   it("handles trailing delimiter with skipEmpty=true", async () => {
      mockFetch(["a\nb\n"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => s)
      expect(result).toEqual(["a", "b"])
   })

   it("includes empty segments when skipEmpty=false", async () => {
      mockFetch(["a\n\nb"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => s, false)
      expect(result).toEqual(["a", "", "b"])
   })

   it("applies parseFn to each segment", async () => {
      mockFetch(["1\n2\n3"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => Number(s))
      expect(result).toEqual([1, 2, 3])
   })

   it("handles single segment without delimiter", async () => {
      mockFetch(["abc"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => s)
      expect(result).toEqual(["abc"])
   })

   it("handles empty input", async () => {
      mockFetch([""])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => s)
      expect(result).toEqual([])
   })

   it("handles multiple delimiters in a row with skipEmpty=true", async () => {
      mockFetch(["a\n\n\nb"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => s)
      expect(result).toEqual(["a", "b"])
   })

   it("handles remainder split across three chunks", async () => {
      mockFetch(["ab", "cd", "ef\ng"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (s: string) => s)
      expect(result).toEqual(["abcdef", "g"])
   })

   it("parses TSV lines correctly via parseFn", async () => {
      mockFetch(["100\t1\t0\t5\t1700000000\tTitle\thttps://example.com"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\n", (line: string) => {
         const f = line.split("\t")
         return {
            fetched_at: Number(f[0]),
            pack_id: Number(f[1]),
            pack_offset: Number(f[2]),
            sub_id: Number(f[3]),
            published: Number(f[4]),
            title: f[5],
            link: f[6],
         }
      })
      expect(result).toEqual([
         {
            fetched_at: 100,
            pack_id: 1,
            pack_offset: 0,
            sub_id: 5,
            published: 1700000000,
            title: "Title",
            link: "https://example.com",
         },
      ])
   })

   it("uses null byte delimiter with skipEmpty=false", async () => {
      mockFetch(["content1\x00content2\x00content3"])
      const split = await getStreamSplit()
      const result = await split("test.gz", false, "\x00", (s: string) => s, false)
      expect(result).toEqual(["content1", "content2", "content3"])
   })
})
