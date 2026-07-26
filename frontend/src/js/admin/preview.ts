// Article preview, shared by the Feeds-row dialog (§17) and the Recipes-tab
// panel (§25). previewState keeps the panel's hand-typed url/recipe across tab
// switches. renderPreviewInto renders /api/preview articles into a container:
// each article body rides a sandboxed inert iframe (srcdoc), so a recipe that
// omits #sanitize cannot run feed-supplied JS on the admin origin.

import { apiGet } from "./api"
import { el } from "./dom"
import type { PreviewArticle } from "./types"

export const previewState = { url: "", recipe: "default" }

// renderPreviewInto renders /api/preview articles for url+recipe into `out`
// (loading line → article list). The Feeds-row dialog also passes the feed's
// {pipe, ingest, secrets} overrides so the preview matches what a fetch would
// run — all three, because SEC5 made the secret grant fail-closed: omit it and
// the probe resolves the RECIPE's grant alone, so an external-ingest feed whose
// credentials come from its own grant previews as an auth failure or 0 items
// while its real fetch cycle is fine.
export async function renderPreviewInto(
   out: HTMLElement,
   url: string,
   recipe: string,
   pipe?: string[],
   ingest?: string,
   secrets?: string[],
): Promise<void> {
   out.replaceChildren(el("div", { class: "muted" }, "loading…"))
   try {
      let qs = `url=${encodeURIComponent(url)}&recipe=${encodeURIComponent(recipe)}`
      for (const p of pipe || []) qs += `&pipe=${encodeURIComponent(p)}`
      if (ingest) qs += `&ingest=${encodeURIComponent(ingest)}`
      // REPEATED param, one per scope — the server reads q["secrets"], a slice.
      for (const s of secrets || []) qs += `&secrets=${encodeURIComponent(s)}`
      const arts = (await apiGet(`/api/preview?${qs}`)) as PreviewArticle[]
      out.replaceChildren(el("div", { class: "muted" }, `${arts.length} articles`))
      for (const a of arts) {
         out.append(
            el(
               "article",
               { class: "preview" },
               el(
                  "h4",
                  {},
                  a.link ? el("a", { href: a.link, target: "_blank", rel: "noopener" }, a.title || "") : a.title || "",
               ),
               // Empty sandbox = scripts, inline event handlers and javascript: URLs all
               // disabled; the srcdoc document renders the HTML inert. Its images/media
               // load because the console's CSP widens img-src/media-src (a srcdoc
               // inherits the embedder's CSP — see the S40 spec §4).
               el("iframe", { class: "preview-frame", sandbox: "", srcdoc: a.content }),
            ),
         )
      }
   } catch (e) {
      out.replaceChildren(el("div", { class: "muted" }, (e as Error).message))
   }
}
