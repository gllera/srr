declare const SRR_CDN_URL: string
declare const process: { env: { NODE_ENV: string } }

interface IDB {
   data_tog: boolean
   fetched_at: number
   first_fetched: number
   sub_seq: number
   total_art: number
   next_pid: number
   pack_off: number
   subscriptions: ISub[]
   subs_mapped: Map<number, ISub>
}

interface ISub {
   id: number
   title: string
   url: string
   pipe?: string[]
   ferr?: string
   stop_guid?: number
   etag?: string
   last_modified?: string
   total_art?: number
   last_added?: number
   tag?: string
}

interface IArticle {
   s: number
   a: number
   p: number
   t: string
   l: string
   c: string
}

interface IShowFeed {
   has_left: boolean
   has_right: boolean
   filtered: boolean
   floor: boolean
   article: IArticle
   sub: ISub | undefined
   countLeft: number
}
