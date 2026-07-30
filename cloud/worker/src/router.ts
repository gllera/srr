// The pure path classifier — the product's security boundary. No I/O, no env:
// index.ts executes these verdicts, tests enumerate them. NOTE: URL pathname
// normalization (the browser and `new URL` both collapse ../) happens BEFORE
// this function; the ".." / "//" guards are hygiene on top of R2's flat
// keyspace, not the actual traversal defense.
export type Route =
   | { kind: "root" }
   | { kind: "redirect-slash"; uid: string }
   | { kind: "shell-index"; uid: string }
   | { kind: "shell-asset"; uid: string; name: string }
   | { kind: "sync"; uid: string }
   | { kind: "denied"; uid: string }
   | { kind: "store"; uid: string; key: string }
   | { kind: "none" }

// Tenant ids are minted by us (t1, t2, …): lowercase alphanumeric + dash/underscore.
const UID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

// The flat store-root shell bundle's name shapes (Parcel content hashes are
// hex; width left loose in case Parcel changes it). Store keys can never
// match: the pack grammar is digit stems under series dirs, assets are
// hash-pathed two levels deep, and none of SRR's root objects look like this.
const SHELL_ASSET_RE =
   /^(?:frontend\.[0-9a-f]{6,20}\.(?:js|css)|sw\.[0-9a-f]{6,20}\.js|icon\.[0-9a-f]{6,20}\.svg|icon-\d+\.[0-9a-f]{6,20}\.png|apple-touch-icon\.[0-9a-f]{6,20}\.png|manifest\.webmanifest)$/

export function classify(pathname: string): Route {
   if (pathname === "/") return { kind: "root" }
   const m = pathname.match(/^\/u\/([^/]+)(?:\/(.*))?$/)
   if (!m) return { kind: "none" }
   const uid = m[1]
   if (!UID_RE.test(uid)) return { kind: "none" }
   if (m[2] === undefined) return { kind: "redirect-slash", uid }
   const rest = m[2]
   if (rest === "" || rest === "index.html") return { kind: "shell-index", uid }
   if (!rest.includes("/") && SHELL_ASSET_RE.test(rest)) return { kind: "shell-asset", uid, name: rest }
   if (rest === "sync.json") return { kind: "sync", uid }
   if (rest === "config.gz" || rest.startsWith("seen/") || rest.startsWith("inbox/")) return { kind: "denied", uid }
   if (rest.includes("..") || rest.includes("//") || rest.endsWith("/")) return { kind: "none" }
   return { kind: "store", uid, key: rest }
}
