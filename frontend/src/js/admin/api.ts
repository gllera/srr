// Root-absolute /api fetch helpers. The console declares NO API base URL — it
// calls /api/... on its own origin exactly as webui/app.js did, which is the
// load-bearing same-origin invariant (see the S40 spec): the bundle is only
// deployable somewhere /api/* resolves to `srr serve` on the same origin.

// What the banner adds when the first snapshot read fails: the admin page is a
// static file next to the reader, so the usual cause is that no `srr serve`
// answers /api on this origin (a plain static host, or serve down behind the
// proxy) — say so rather than showing a bare "not found". Lives in this leaf
// (no imports, no DOM) so the Node-side browser e2e can import it too.
export const NO_API_HINT =
   "The admin page needs `srr serve` answering /api/* on this origin — or, behind a login proxy, your session expired: reload the page."

// one SSE frame handed to streamSSE's caller. `data` is the parsed JSON body of
// the frame (or null); callers narrow it to the event's payload type.
export interface SSEEvent {
   event: string
   data: unknown
}

// ApiError carries the HTTP status of a failed api() call, so callers can tell
// "the API answered and said no" (401/403/409/…) from "nothing that looks like
// the API answered at all" — see apiLooksMissing below.
export class ApiError extends Error {
   constructor(
      message: string,
      readonly status: number,
   ) {
      super(message)
      this.name = "ApiError"
   }
}

// apiLooksMissing(err) is true when err looks like there is no `srr serve`
// answering /api/* on this origin at all, rather than an API that answered
// and refused: a network failure (fetch itself threw, e.g. a TypeError — no
// ApiError, since nothing that far ever saw a status) or a status a
// reachable-but-absent API would produce (404 not found, or 502/503/504 from
// a reverse proxy with nothing behind it). A login proxy's redirect to another
// origin also surfaces as a network failure, which is why the hint itself names
// an expired session too. An ApiError with any other status —
// notably 401/403 (an expired forward-auth session) and 409 (the fetch loop
// holds the store lock) — means the API IS there and answered, so it is
// false: the boot banner must not append the "needs `srr serve`" hint to
// those, which would mislead.
export function apiLooksMissing(err: unknown): boolean {
   if (!(err instanceof ApiError)) return true
   return err.status === 404 || err.status === 502 || err.status === 503 || err.status === 504
}

// api(method, path, body?, contentType?) issues a JSON request — or, when
// contentType is set, sends body raw under that header (the OPML import's XML
// dry-run) — and returns the parsed body.
// Errors are NOT always our JSON {error}: hostGuard and intermediaries (the
// tunnel, Cloudflare Access) answer plain text or HTML — that body is surfaced
// verbatim, which is how a topology error (a 403, an Access login page) gets
// diagnosed instead of showing an opaque "invalid JSON".
export async function api(method: string, path: string, body?: unknown, contentType?: string): Promise<unknown> {
   const opts: RequestInit = { method, headers: {} }
   if (body !== undefined) {
      ;(opts.headers as Record<string, string>)["Content-Type"] = contentType ?? "application/json"
      opts.body = contentType ? (body as BodyInit) : JSON.stringify(body)
   }
   const res = await fetch(path, opts)
   const text = await res.text()
   let data: unknown = null
   try {
      data = text ? JSON.parse(text) : null
   } catch {
      if (res.ok) throw new Error("invalid JSON from " + path)
   }
   if (!res.ok) throw new ApiError(errorMessage(res, text), res.status)
   return data
}

// The human message behind a failed Response — the ONE place the server's
// {"error": …} envelope is unwrapped and the 409 lock affordance is added.
// Shared with streamSSE below, which used to re-derive only half of it: it
// raised the raw body, so a pre-stream error (backend/serve_fetch.go's
// "streaming unsupported" and `invalid feed id %q` both go through writeErr)
// surfaced in the banner as literal {"error":"…"} JSON — exactly the opaque
// body this unwrap exists to prevent — and never carried the 409 tag.
//
// statusText is empty over HTTP/2, hence the body-first order.
export function errorMessage(res: Response, text: string): string {
   let data: unknown = null
   try {
      data = text ? JSON.parse(text) : null
   } catch {
      // not JSON — fall through to the raw body
   }
   const errBody = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : ""
   const msg = errBody || text.trim().slice(0, 300) || res.statusText
   // Give 409 (store lock contention) an explicit affordance so it does not
   // read like a validation 400 in the banner (S40 spec §3). The server's own
   // message already names the lock; only a lock-less intermediary 409 is tagged.
   return res.status === 409 && !/lock/i.test(msg) ? "the fetch loop holds the store lock — retry (" + msg + ")" : msg
}

export const apiGet = (p: string): Promise<unknown> => api("GET", p)

// streamSSE POSTs to path and invokes onEvent({event, data}) for each SSE
// frame; an optional AbortSignal cancels the stream (and, server-side, the
// fetch cycle it drives — the handler runs under the request context). A
// pre-stream failure raises through the SAME envelope api() uses, 409 lock
// affordance included — see errorMessage above.
export async function streamSSE(path: string, onEvent: (ev: SSEEvent) => void, signal?: AbortSignal): Promise<void> {
   const res = await fetch(path, { method: "POST", signal })
   if (!res.ok) throw new Error(errorMessage(res, await res.text()))
   const reader = res.body!.getReader()
   const dec = new TextDecoder()
   let buf = ""
   try {
      for (;;) {
         const { value, done } = await reader.read()
         if (done) break
         buf += dec.decode(value, { stream: true })
         let i: number
         while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i)
            buf = buf.slice(i + 2)
            let ev = "message"
            let data = ""
            for (const line of frame.split("\n")) {
               if (line.startsWith("event:")) ev = line.slice(6).trim()
               else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim()
            }
            onEvent({ event: ev, data: data ? JSON.parse(data) : null })
         }
      }
   } finally {
      reader.cancel()
   }
}
