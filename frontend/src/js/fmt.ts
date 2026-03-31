const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "narrow" })
const JS_PROTO = /^\s*javascript\s*:/i
const DANGEROUS_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "EMBED", "OBJECT", "FORM", "LINK", "META", "BASE"])

// <template> parses HTML without executing scripts, unlike a div
const tmpl = document.createElement("template")
export function sanitizeHtml(html: string): string {
   tmpl.innerHTML = html
   const walker = document.createTreeWalker(tmpl.content, NodeFilter.SHOW_ELEMENT)
   const toRemove: Element[] = []
   let node: Element | null
   while ((node = walker.nextNode() as Element | null)) {
      if (DANGEROUS_TAGS.has(node.tagName)) {
         toRemove.push(node)
         continue
      }
      const attrs = node.attributes
      for (let i = attrs.length - 1; i >= 0; i--) {
         const attr = attrs[i]
         if (attr.name.startsWith("on") || JS_PROTO.test(attr.value)) node.removeAttribute(attr.name)
      }
      if (node.tagName === "A") node.setAttribute("rel", "noopener noreferrer")
      if (node.tagName === "IMG") node.setAttribute("loading", "lazy")
   }
   for (const n of toRemove) n.remove()
   return tmpl.innerHTML
}

export function timeAgo(unix: number): string {
   const sec = Math.floor(Date.now() / 1000) - unix
   if (sec < 60) return rtf.format(-sec, "second")
   if (sec < 3600) return rtf.format(-Math.floor(sec / 60), "minute")
   if (sec < 86400) return rtf.format(-Math.floor(sec / 3600), "hour")
   if (sec < 2592000) return rtf.format(-Math.floor(sec / 86400), "day")
   if (sec < 31536000) return rtf.format(-Math.floor(sec / 2592000), "month")
   return rtf.format(-Math.floor(sec / 31536000), "year")
}

const pad2 = (n: number) => n.toString().padStart(2, "0")
export function formatDate(unix: number): string {
   const d = new Date(unix * 1000)
   return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
