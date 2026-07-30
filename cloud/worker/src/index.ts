// Placeholder — the real handler lands with the routing task.
export interface Env {
   ASSETS: Fetcher
   STORE: R2Bucket
   SESSION_SECRET: string
   LOGIN_URL: string
}

export default {
   async fetch(): Promise<Response> {
      return new Response("not implemented", { status: 501 })
   },
} satisfies ExportedHandler<Env>
