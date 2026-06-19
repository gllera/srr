declare const SRR_CDN_URL: string
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
   article: IArticle
   // True only for the synthetic "(no matching articles)" placeholder.
   placeholder?: boolean
}
