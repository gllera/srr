// Serve-side view types the admin console renders from. These mirror the Go
// structs in backend/serve_overview.go + backend/serve_feeds.go (overviewView /
// feedListView / tagCount) and backend/db.go (Recipe / OutFeed). They are the
// server's admin-API projection — NOT the writer↔reader pack contract — so they
// are deliberately hand-written here (not emitted by `srr gen-ts`, which only
// covers the reader-facing wire types). Keep the whole mirror in this one file
// so any drift against the Go shapes is one diff to review.

// One feed row in GET /api/overview (backend feedListView). The omitempty Go
// fields are optional here; the console mutates the health fields optimistically
// while an SSE fetch streams, so nothing is readonly.
export interface FeedListView {
   id: number
   title: string
   url: string
   tag?: string
   recipe?: string
   ingest?: string
   pipe?: string[]
   no_title?: boolean
   error?: string
   fail_streak: number
   last_ok: number
   last_new: number
   total_art: number
   expire_days?: number
   dedup_days?: number
   dedup_title?: boolean
   expired?: number
   content_bytes?: number
   asset_bytes?: number
}

// One tag bucket for the feeds-tab tag filter (backend tagCount). Tag "" is the
// untagged bucket.
export interface TagCount {
   tag: string
   feeds: number
   articles: number
}

// A named {ingest, pipe} processing recipe (backend Recipe).
export interface Recipe {
   ingest?: string
   pipe?: string[]
}

// One syndication output slot (backend OutFeed).
export interface OutFeed {
   name: string
   title?: string
   format: string
   tags?: string[]
   feeds?: number[]
   limit?: number
   ext?: boolean
}

// The whole-store snapshot (GET /api/overview, backend overviewView). Every tab
// renders from one of these; it is re-pulled on boot and after each mutation.
export interface OverviewView {
   feeds: FeedListView[]
   tags: TagCount[]
   recipes: Record<string, Recipe>
   out: OutFeed[]
   m: number
   fetched_at: number
   total_art: number
   dedup_days: number
   cdn_url?: string
   version: string
}

// One SSE `feed` frame from POST /api/fetch (backend feedProgress).
export interface FeedProgress {
   id: number
   title: string
   error?: string
   new: number
}

// GET /api/resolve — the add-feed URL probe (backend resolve handler).
export interface ResolveResult {
   url?: string
   title?: string
   items: number
}

// One previewed article (GET /api/preview) — content is raw article HTML.
export interface PreviewArticle {
   title?: string
   link?: string
   content: string
}

// GET /api/inspect report.
export interface InspectResult {
   ok: boolean
   error?: string
   report: string
}

// One OPML dry-run row (POST /api/import?dry_run=1) — a resolvable feed, or a
// skipped one carrying its resolution error.
export interface ImportFeed {
   url: string
   title?: string
   tag?: string
   recipe?: string
   error?: string
}

// The OPML dry-run result: resolvable feeds + unresolvable (skipped) ones.
export interface ImportDryRun {
   feeds?: ImportFeed[]
   skipped?: ImportFeed[]
}
