// Mirror the backend bluemonday allowlist (mailto, http, https) for defense-in-depth.
// data:/vbscript:/javascript:/file: in href or src are XSS or info-leak vectors
// (data:text/html executes script; data:image/svg+xml runs <script> in SVG).
export const URL_DENY = /^\s*(?:javascript|data|vbscript|file)\s*:/i
// SVG/MATH carry their own script + foreign-content surface; bluemonday strips
// them server-side, so mirror that here. CSS selector — querySelectorAll matches
// case-insensitively for HTML and matches SVG/MathML by their normalized names,
// so we don't need a separate case-folding pass.
const DANGEROUS_SELECTOR = "script,style,iframe,embed,object,form,link,meta,base,svg,math"

const HTTP_RE = /^https?:\/\//i
// Reserved store prefix for self-hosted media (mirrors backend assetPrefix).
// Such content URLs are relative to the pack base, not the reader page, so we
// resolve them against PACK_BASE (the same value as data.ts's DB_URL) instead
// of routing them through the image proxy. Computed once at module load.
const ASSET_PREFIX = "assets/"
const PACK_BASE = new URL(SRR_CDN_URL, window.location.href)
// Prefix is the URL-encoded-source-appender shape (wsrv.nl, imgproxy, imagor).
// Configured per-user via localStorage `srr-img-proxy`; empty/absent = passthrough.
const IMG_PROXY_KEY = "srr-img-proxy"

export function getImgProxy(): string {
   try {
      return localStorage.getItem(IMG_PROXY_KEY) ?? ""
   } catch {
      return ""
   }
}

export function setImgProxy(value: string): void {
   try {
      localStorage.setItem(IMG_PROXY_KEY, value)
   } catch {}
}

export function imgProxy(url: string, prefix: string): string {
   return prefix ? prefix + encodeURIComponent(url) : url
}

// resolveAsset resolves a self-hosted asset key against the pack base, but only
// if the result stays inside that base. Without the bounds check, a crafted key
// like "assets/../../x" would traverse out of the assets subtree onto an
// arbitrary path on the CDN origin (a credentialed-GET info-leak vector).
// Returns null when the key escapes, so the caller drops the attribute.
function resolveAsset(v: string): string | null {
   const resolved = new URL(v, PACK_BASE).href
   return resolved.startsWith(PACK_BASE.href) ? resolved : null
}

// setAsset resolves a self-hosted asset key and sets it on node[attr], dropping
// the attribute when the key escapes the pack base (see resolveAsset).
function setAsset(node: Element, attr: string, v: string): void {
   const resolved = resolveAsset(v)
   if (resolved) node.setAttribute(attr, resolved)
   else node.removeAttribute(attr)
}

// <template> parses HTML without executing scripts, unlike a div
const tmpl = document.createElement("template")
export function sanitizeHtml(html: string): string {
   tmpl.innerHTML = html
   // Drop dangerous subtrees first so the attribute pass below never visits
   // their (now-detached) descendants — saves work on e.g. <svg><script>...
   for (const n of tmpl.content.querySelectorAll(DANGEROUS_SELECTOR)) n.remove()
   const walker = document.createTreeWalker(tmpl.content, NodeFilter.SHOW_ELEMENT)
   const proxyPrefix = getImgProxy()
   let node: Element | null
   while ((node = walker.nextNode() as Element | null)) {
      const attrs = node.attributes
      for (let i = attrs.length - 1; i >= 0; i--) {
         const attr = attrs[i]
         if (attr.name === "style" || attr.name === "class" || attr.name.startsWith("on") || URL_DENY.test(attr.value))
            node.removeAttribute(attr.name)
      }
      const tag = node.tagName
      if (tag === "A") node.setAttribute("rel", "noopener noreferrer")
      else if (tag === "IMG") {
         node.removeAttribute("srcset")
         const src = node.getAttribute("src")
         // Self-hosted assets resolve against the pack base (bounds-checked) and
         // bypass the proxy; external http(s) URLs keep the proxy path. URL_DENY-
         // matching src was already stripped by the attribute loop above.
         if (src && src.startsWith(ASSET_PREFIX)) setAsset(node, "src", src)
         else if (src && HTTP_RE.test(src)) node.setAttribute("src", imgProxy(src, proxyPrefix))
      } else if (tag === "VIDEO") {
         // src: self-hosted resolves against the pack base; external passes
         // through (image proxies don't handle video).
         const src = node.getAttribute("src")
         if (src && src.startsWith(ASSET_PREFIX)) setAsset(node, "src", src)
         // poster IS an image, so route external posters through the proxy like
         // img.src (the asymmetry of leaving them direct leaks the user's IP).
         const poster = node.getAttribute("poster")
         if (poster && poster.startsWith(ASSET_PREFIX)) setAsset(node, "poster", poster)
         else if (poster && HTTP_RE.test(poster)) node.setAttribute("poster", imgProxy(poster, proxyPrefix))
      }
   }
   return tmpl.innerHTML
}

// Regex (not DOM parse) keeps this cheap; sanitization runs on actual render.
// Handles both quoted (`src="..."`) and unquoted (`src=...`) forms because the
// backend's `#minify` pass (tdewolff/minify) drops attribute quotes when the
// value has no special chars — that fires for clean CDN URLs (no `?` or
// `&`), so a quote-only regex missed them entirely and the prefetch list
// came back empty for those channels.
const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*(?:(["'])([^"']+)\1|([^\s>]+))/gi
export function extractImageUrls(html: string): string[] {
   const out: string[] = []
   if (!html) return out
   for (const m of html.matchAll(IMG_SRC_RE)) {
      const url = m[2] ?? m[3]
      if (HTTP_RE.test(url)) out.push(url)
   }
   return out
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
