// Mirror the backend bluemonday allowlist (mailto, http, https) for defense-in-depth.
// data:/vbscript:/javascript:/file: in href or src are XSS or info-leak vectors
// (data:text/html executes script; data:image/svg+xml runs <script> in SVG).
export const URL_DENY = /^\s*(?:javascript|data|vbscript|file)\s*:/i
// SVG/MATH carry their own script + foreign-content surface; bluemonday strips
// them server-side, so mirror that here. Stored uppercase; tagName is compared
// as toUpperCase() because SVG/MathML elements report case-preserved names.
const DANGEROUS_TAGS = new Set([
   "SCRIPT",
   "STYLE",
   "IFRAME",
   "EMBED",
   "OBJECT",
   "FORM",
   "LINK",
   "META",
   "BASE",
   "SVG",
   "MATH",
])

// <template> parses HTML without executing scripts, unlike a div
const tmpl = document.createElement("template")
export function sanitizeHtml(html: string): string {
   tmpl.innerHTML = html
   const walker = document.createTreeWalker(tmpl.content, NodeFilter.SHOW_ELEMENT)
   const toRemove: Element[] = []
   let node: Element | null
   while ((node = walker.nextNode() as Element | null)) {
      if (DANGEROUS_TAGS.has(node.tagName.toUpperCase())) {
         toRemove.push(node)
         continue
      }
      const attrs = node.attributes
      for (let i = attrs.length - 1; i >= 0; i--) {
         const attr = attrs[i]
         if (attr.name === "style" || attr.name.startsWith("on") || URL_DENY.test(attr.value))
            node.removeAttribute(attr.name)
      }
      if (node.tagName === "A") node.setAttribute("rel", "noopener noreferrer")
      if (node.tagName === "IMG") {
         node.removeAttribute("srcset")
         node.setAttribute("loading", "lazy")
         const src = node.getAttribute("src")
         if (src && /^https?:\/\//i.test(src)) {
            node.setAttribute(
               "src",
               "https://wsrv.nl/?&output=webp&w=600&h=600&fit=inside&we&url=" + encodeURIComponent(src),
            )
         }
         // URL_DENY-matching src already stripped by the attribute loop above
      }
   }
   for (const n of toRemove) n.remove()
   return tmpl.innerHTML
}

export function timeAgo(unix: number): string {
   const sec = Math.max(0, Math.floor(Date.now() / 1000) - unix)
   if (sec < 60) return `${sec}s`
   if (sec < 3600) return `${Math.floor(sec / 60)}m`
   if (sec < 86400) return `${Math.floor(sec / 3600)}h`
   if (sec < 2592000) return `${Math.floor(sec / 86400)}d`
   if (sec < 31536000) return `${Math.floor(sec / 2592000)}mo`
   return `${Math.floor(sec / 31536000)}y`
}

const pad2 = (n: number) => n.toString().padStart(2, "0")
export function formatDate(unix: number): string {
   const d = new Date(unix * 1000)
   return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
