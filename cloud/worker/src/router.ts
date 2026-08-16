// The pure path classifier — the product's security boundary. No I/O, no env:
// index.ts executes these verdicts, tests enumerate them. NOTE: URL pathname
// normalization (the browser and `new URL` both collapse ../) happens BEFORE
// this function; the ".." / "//" guards are hygiene on top of R2's flat
// keyspace, not the actual traversal defense.
export type Route =
   | AuthRoute
   | { kind: "root" }
   | { kind: "redirect-slash" }
   | { kind: "shell-index"; uid: string }
   | { kind: "shell-asset"; name: string }
   | { kind: "sync"; uid: string }
   | { kind: "denied" }
   | { kind: "store"; uid: string; key: string }
   | { kind: "none" }

// `uid` rides ONLY the variants that authorize on it. `redirect-slash` reflects
// the path it was given, `shell-asset` is public bytes and `denied` is a 404 —
// none of the three ever read a tenant, and carrying one on them made "is this
// route tenant-scoped?" a question you had to answer by reading index.ts. Now
// the type answers it, and `"uid" in route` is the enforcement point below.

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
// SPLIT BY CACHE LIFETIME, not for tidiness. "Which of these names may be
// stamped immutable" is a fact about the name, so it belongs beside the name —
// shell.ts used to re-decide it with a `name === "manifest.webmanifest"`
// equality one file away. The two mistakes are wildly asymmetric: a new hashed
// name missed here costs a cache miss, while a new STABLE name (robots.txt, an
// offline.html, an unhashed sw.js) missed there gets `max-age=31536000,
// immutable` stamped on a mutable file, in every browser and at the edge, with
// no purge story. One edit now adds a name and its cache policy together.
const HASHED = String.raw`(?:frontend\.[0-9a-f]{6,20}\.(?:js|css)|sw\.[0-9a-f]{6,20}\.js|icon\.[0-9a-f]{6,20}\.svg|icon-\d+\.[0-9a-f]{6,20}\.png|apple-touch-icon\.[0-9a-f]{6,20}\.png)`
const STABLE = String.raw`(?:manifest\.webmanifest)`

/** Content-hashed bundle names — safe to serve `immutable`. */
export const SHELL_HASHED_RE = new RegExp(`^${HASHED}$`)

// Both classifiers below test it — two copies of this regexp would be two
// answers to "is this name public bytes, or a store object?".
const SHELL_ASSET_RE = new RegExp(`^(?:${HASHED}|${STABLE})$`)

export function classify(pathname: string): Route {
   const auth = classifyAuth(pathname)
   if (auth) return auth
   if (pathname === "/") return { kind: "root" }
   const m = pathname.match(/^\/u\/([^/]+)(?:\/(.*))?$/)
   if (!m) return { kind: "none" }
   const uid = m[1]
   if (!UID_RE.test(uid)) return { kind: "none" }
   if (m[2] === undefined) return { kind: "redirect-slash" }
   const rest = m[2]
   if (rest === "" || rest === "index.html") return { kind: "shell-index", uid }
   if (!rest.includes("/") && SHELL_ASSET_RE.test(rest)) return { kind: "shell-asset", name: rest }
   if (rest === "sync.json") return { kind: "sync", uid }
   if (rest === "config.gz" || rest.startsWith("seen/") || rest.startsWith("inbox/")) return { kind: "denied" }
   if (rest.includes("..") || rest.includes("//") || rest.endsWith("/")) return { kind: "none" }
   return { kind: "store", uid, key: rest }
}

// -----------------------------------------------------------------------------
// The policy each verdict carries. Access, methods and egress guards were three
// facts decided in three different places: gating by whether a `case` in
// dispatch remembered to call the authorizer (fail-OPEN by omission — an
// ungated new route returns 200 with every test still green), methods by an
// inline boolean per entrypoint, and the guards by wrapping two call sites by
// hand. One EXHAUSTIVE switch instead: a new route kind is a compile error
// until all three are answered, and each is then enforced exactly once.

/**
 * `public` — anyone, including a cookie-less service-worker script fetch.
 * `session` — any authenticated identity.
 * `tenant` — an ACTIVE roster member; on a uid-bearing route, that member.
 */
export type Gate = "public" | "session" | "tenant"

export interface Policy {
   gate: Gate
   /** The methods this route answers; the 405's `Allow` header reads this array. */
   methods: readonly string[]
}

const GET = ["GET"] as const
const GET_POST = ["GET", "POST"] as const

export interface StorePolicy extends Policy {
   /**
    * Feed-sourced or client-written bytes, served from the app's OWN origin —
    * index.ts's userContent() guards ride these and only these.
    */
   userBytes: boolean
}

export function policy(route: Route): StorePolicy {
   switch (route.kind) {
      case "login":
      case "callback":
         return { gate: "public", methods: GET, userBytes: false }
      case "logout":
         return { gate: "public", methods: GET_POST, userBytes: false }
      // Reflects the path it was handed and nothing else, so it needs no
      // session — and answering it before the gate keeps an anonymous
      // navigation's redirect chain one hop rather than two.
      case "redirect-slash":
         return { gate: "public", methods: GET, userBytes: false }
      // Deliberately UNAUTHENTICATED: public bytes, and the SW script fetch
      // carries no cookie (a real hosted-reader outage, 2026-07-29) — gating
      // it silently breaks SW registration.
      case "shell-asset":
         return { gate: "public", methods: GET, userBytes: false }
      // Backend-only object classes 404 even for the owner (store-visibility
      // split), so there is nothing here to authorize access TO.
      case "denied":
      case "none":
         return { gate: "public", methods: GET, userBytes: false }
      case "root":
      case "shell-index":
         return { gate: "tenant", methods: GET, userBytes: false }
      case "sync":
         return { gate: "tenant", methods: ["GET", "PUT"], userBytes: true }
      case "store":
         return { gate: "tenant", methods: GET, userBytes: true }
   }
}

// -----------------------------------------------------------------------------
// The reader worker's classifier (src/reader.ts) — a much smaller surface than
// the one above: no tenants and no store, because that deployment's packs live
// on the CDN origin and it serves the shell and nothing else.
//
// So the whole gate is three facts: the shell INDEX needs a session, the
// shell's ASSETS do not, and the three sign-in routes must not — `callback`
// above all, since it is where a session comes from and requiring one there is
// a redirect loop. Those three facts are policyReader() below, not prose.
export type ReaderRoute = AuthRoute | { kind: "shell-index" } | { kind: "shell-asset"; name: string } | { kind: "none" }

export function classifyReader(pathname: string): ReaderRoute {
   const auth = classifyAuth(pathname)
   if (auth) return auth
   if (pathname === "/" || pathname === "/index.html") return { kind: "shell-index" }
   const rest = pathname.slice(1)
   if (!rest.includes("/") && SHELL_ASSET_RE.test(rest)) return { kind: "shell-asset", name: rest }
   return { kind: "none" }
}

export function policyReader(route: ReaderRoute): Policy {
   switch (route.kind) {
      case "login":
      case "callback":
         return { gate: "public", methods: GET }
      case "logout":
         return { gate: "public", methods: GET_POST }
      // Same SW trap as the cloud worker's, and the same answer.
      case "shell-asset":
      case "none":
         return { gate: "public", methods: GET }
      // Authentication only — there is no roster here, and the packs this shell
      // fetches live on another origin that is public by the operator's choice.
      case "shell-index":
         return { gate: "session", methods: GET }
   }
}
