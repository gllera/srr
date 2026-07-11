declare const SRR_CDN_URL: string
declare const SRR_VERSION: string
declare const process: { env: { NODE_ENV: string } }

// Wire shapes come from the generated contract (format.gen.ts, emitted from
// the backend's Go declarations by `srr gen-ts`). The types below layer the
// client-side normalizations data.ts init() applies on top of the wire.
// import() type references keep this file ambient (a top-level import would
// turn it into a module and un-global every name).

type IArticle = import("./format.gen").IArticleWire
type IFeedWire = import("./format.gen").IFeedWire
type IDBWire = import("./format.gen").IDBWire

interface IFeed extends IFeedWire {
   id: number // populated from the feeds object key at init
}

interface IDB extends Omit<IDBWire, "seq" | "feeds"> {
   seq: number // backend omitempty (absent == 0 == empty store); init() normalizes with ??= 0
   feeds: Record<number, IFeed> // init() normalizes null with ??= {} and stamps each value's .id
}

interface IShowFeed {
   has_left: boolean
   has_right: boolean
   // The next pill's pending readout (pendingRight): matching articles still
   // AHEAD of this one — strictly after pos — under the active filter. Feed/tag/
   // [ALL] count positionally over the raised filter bounds; saved/search count
   // their explicit set after this article. The on-screen article is never
   // included, so the last article reads 0, not 1. -1 = unknown (a degraded
   // count probe): the pill hides its digits but next still works off has_right.
   right_count: number
   article: IArticle
   // True only for the synthetic "(no matching articles)" placeholder.
   placeholder?: boolean
   // Distinguishes the two unread-only placeholders so the reader can pick the
   // right empty-state message: true = a feed/tag you've never opened (it HAS
   // unread, but no already-read article to resume onto → "start from the list");
   // false/absent = the caught-up placeholder (nothing unread) or a plain no-match.
   notStarted?: boolean
   // Set only alongside notStarted: the feed of the oldest unread article — the
   // one the armed Next opens — so the placeholder can name WHICH feed is the
   // never-read one (a tag lane's label alone can't). Absent on a probe blip;
   // the message then falls back to the lane label.
   startFeed?: number
}
