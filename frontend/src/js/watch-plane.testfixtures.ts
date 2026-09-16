// Shared by watch-plane.test.ts and nav/lane-watch.test.ts — NOT itself a
// `.test.ts` file, so it never registers as a test file of its own (vitest's
// default glob is `*.test.ts`) and importing it can't double-run a suite.
//
// Encodes a set of chron offsets into the writer's LSB-first bitmap layout
// (backend/watch.go: plane[i>>3] |= 1 << (i&7)) and base64-wraps it, so both
// suites check the decoder against the FORMAT, not against itself.
export function bytesOf(n: number, set: number[]): Uint8Array {
   const b = new Uint8Array(Math.ceil(n / 8))
   for (const i of set) b[i >> 3] |= 1 << (i & 7)
   return b
}
export const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
