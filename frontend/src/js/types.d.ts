declare const SRR_CDN_URL: string
declare const process: { env: { NODE_ENV: string } }

interface IDB {
   // Latest-pack generation: current latest packs are idx/L<seq>.gz and
   // data/L<seq>.gz. Backend omits the key at 0 (empty store); data.ts
   // init() normalizes the absent case.
   seq: number
   fetched_at: number
   first_fetched?: number
   total_art: number
   next_pid: number
   pack_off: number
   gen?: number
   channels: Record<number, IChannel>
}

interface IFeed {
   url: string
   ferr?: string
   wm?: number
   bg?: number[]
   etag?: string
   last_modified?: string
}

interface IChannel {
   id: number
   title: string
   feeds: IFeed[]
   pipe?: string[]
   total_art: number
   add_idx: number
   tag?: string
}

interface IArticle {
   s: number
   a: number
   p?: number
   t: string
   l: string
   c: string
}

interface IShowFeed {
   has_left: boolean
   has_right: boolean
   filtered: boolean
   article: IArticle
   channel: IChannel | undefined
   countRight: number
}
