declare const SRR_CDN_URL: string
declare const process: { env: { NODE_ENV: string } }

interface IDB {
   data_tog: boolean
   fetched_at: number
   first_fetched?: number
   total_art: number
   next_pid: number
   pack_off: number
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
