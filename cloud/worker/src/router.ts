// The pure path classifier — the product's security boundary. No I/O, no env:
// index.ts executes these verdicts, tests enumerate them. NOTE: URL pathname
// normalization (the browser and `new URL` both collapse ../) happens BEFORE
// this function; the ".." / "//" guards are hygiene on top of R2's flat
// keyspace, not the actual traversal defense.
export type Route =
   | AuthRoute
   | { kind: "root" }
   | { kind: "redirect-slash"; uid: string }
   | { kind: "shell-index"; uid: string }
   | { kind: "shell-asset"; uid: string; name: string }
   | { kind: "sync"; uid: string }
   | { kind: "denied"; uid: string }
   | { kind: "store"; uid: string; key: string }
   | { kind: "none" }

// The sign-in routes, and BOTH workers answer at exactly these three paths.
//
// One table rather than a copy per classifier, for a sharper reason than tidiness:
// oidc.ts builds its redirect_uri out of `/auth/callback` and links `/auth/login`
// off its failure page, and the IdP compares that URI un-normalized. A classifier
// that drifted from those literals would not read as a routing bug — it would be
// a sign-in that cannot complete, on whichever worker held the second copy.
export type AuthRoute = { kind: "login" } | { kind: "callback" } | { kind: "logout" }

// Enumerated, never an `/auth/` PREFIX: a prefix is a hole waiting for a route
// to appear behind it. Written as an if-chain rather than a lookup table because
// a bare object's keys include everything on Object.prototype.
function classifyAuth(pathname: string): AuthRoute | null {
   if (pathname === "/auth/login") return { kind: "login" }
   if (pathname === "/auth/callback") return { kind: "callback" }
   if (pathname === "/auth/logout") return { kind: "logout" }
   return null
}

// Tenant ids are minted by us (t1, t2, …): lowercase alphanumeric + dash/underscore.
// Exported because roster.ts holds the OTHER side of the same equality test — a
// configured uid this rejects can never match a request, so it drops those rows
// rather than let one reach the `/` redirect's Location header.
export const UID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

// The flat store-root shell bundle's name shapes (Parcel content hashes are
// hex; width left loose in case Parcel changes it). Store keys can never
// match: the pack grammar is digit stems under series dirs, assets are
// hash-pathed two levels deep, and none of SRR's root objects look like this.
//
// Exported because the reader worker (classifyReader below) answers the same
// question about the same bundle. Two copies of this regexp would be two
// answers to "is this name public bytes, or a store object?".
export const SHELL_ASSET_RE =
   /^(?:frontend\.[0-9a-f]{6,20}\.(?:js|css)|sw\.[0-9a-f]{6,20}\.js|icon\.[0-9a-f]{6,20}\.svg|icon-\d+\.[0-9a-f]{6,20}\.png|apple-touch-icon\.[0-9a-f]{6,20}\.png|manifest\.webmanifest)$/

export function classify(pathname: string): Route {
   const auth = classifyAuth(pathname)
   if (auth) return auth
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

// -----------------------------------------------------------------------------
// The reader worker's classifier (src/reader.ts) — a much smaller surface than
// the one above: no tenants and no store, because that deployment's packs live
// on the CDN origin and it serves the shell and nothing else.
//
// So the whole gate is three facts: the shell INDEX needs a session, the
// shell's ASSETS do not, and the three sign-in routes must not — `callback`
// above all, since it is where a session comes from and requiring one there is
// a redirect loop.
export type ReaderRoute = AuthRoute | { kind: "shell-index" } | { kind: "shell-asset"; name: string } | { kind: "none" }

export function classifyReader(pathname: string): ReaderRoute {
   const auth = classifyAuth(pathname)
   if (auth) return auth
   if (pathname === "/" || pathname === "/index.html") return { kind: "shell-index" }
   const rest = pathname.slice(1)
   if (!rest.includes("/") && SHELL_ASSET_RE.test(rest)) return { kind: "shell-asset", name: rest }
   return { kind: "none" }
}
