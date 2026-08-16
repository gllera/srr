// Root-absolute /api fetch helpers. The console declares NO API base URL — it
// calls /api/... on its own origin exactly as webui/app.js did, which is the
// load-bearing same-origin invariant (see the S40 spec): the bundle is only
// deployable somewhere /api/* resolves to `srr serve` on the same origin.

// one SSE frame handed to streamSSE's caller. `data` is the parsed JSON body of
// the frame (or null); callers narrow it to the event's payload type.
export interface SSEEvent {
   event: string
   data: unknown
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
   if (!res.ok) throw new Error(errorMessage(res, text))
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
