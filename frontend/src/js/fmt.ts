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
// A reference carrying a URL scheme (http:, mailto:, the URL_DENY set, …) is
// absolute; everything else is a relative reference. ABS_SCHEME detects the
// scheme so isRelative can route relative refs to the pack base below.
const ABS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
// Content URLs are relative to the pack base (where the article was stored), not
// the reader page, so relative refs — the self-hosted "assets/" keys and any
// other relative URL the feed carried — resolve against PACK_BASE (the same
// value as data.ts's DB_URL) instead of the SPA origin or the image proxy.
// Computed once at module load.
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

// isValidProxy accepts the empty string (disables proxying) or an absolute
// http(s) prefix (http allowed for LAN proxies) — imgProxy() just concatenates
// prefix + encoded URL, so a schemeless prefix could never produce a fetchable
// image URL. setImgProxy stays a dumb setter; the UI validates before storing.
export function isValidProxy(v: string): boolean {
   return v === "" || /^https?:\/\//i.test(v)
}

export function imgProxy(url: string, prefix: string): string {
   return prefix ? prefix + encodeURIComponent(url) : url
}

// isRelative reports whether v is a relative reference — one with no URL scheme
// (e.g. "assets/ab/cd.jpg", "/img/x.jpg", "#frag"). A protocol-relative "//host"
// ref counts as relative too: it has no scheme, and resolvePackRelative's bounds
// check then drops it because it resolves to a foreign origin.
function isRelative(v: string): boolean {
   return !ABS_SCHEME.test(v)
}

// resolvePackRelative resolves a relative reference against the pack base, but
// only if the result stays inside that base. Without the bounds check, a crafted
// ref like "../../x" (or "assets/../../x") would traverse off the pack subtree
// onto an arbitrary path on the CDN origin — and "//host/x" onto a foreign one —
// a credentialed-GET info-leak vector. Returns null when the ref escapes, so the
// caller drops the attribute.
function resolvePackRelative(v: string): string | null {
   const resolved = new URL(v, PACK_BASE).href
   return resolved.startsWith(PACK_BASE.href) ? resolved : null
}

// setPackRelative resolves a relative reference and sets it on node[attr],
// dropping the attribute when the ref escapes the pack base (see
// resolvePackRelative).
function setPackRelative(node: Element, attr: string, v: string): void {
   const resolved = resolvePackRelative(v)
   if (resolved) node.setAttribute(attr, resolved)
   else node.removeAttribute(attr)
}

// resolveMediaAttr routes one URL-bearing attribute on a sanitized node: a
// relative reference resolves against the pack base (bounds-checked, dropped if
// it escapes), and — when proxy is set — an external http(s) reference goes
// through the image proxy. Other values (absolute non-http, or already stripped
// by the attribute loop) are left untouched. Centralizes the branch shared by
// <img src>, <video src>, <video poster> and <a href>.
function resolveMediaAttr(node: Element, attr: string, proxyPrefix: string, proxy: boolean): void {
   const v = node.getAttribute(attr)
   if (!v) return
   if (isRelative(v)) setPackRelative(node, attr, v)
   else if (proxy && HTTP_RE.test(v)) node.setAttribute(attr, imgProxy(v, proxyPrefix))
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
      if (tag === "A") {
         node.setAttribute("rel", "noopener noreferrer")
         // Relative hrefs (self-hosted "assets/…/doc.pdf", or any relative link
         // the feed carried) resolve against the pack base, bounds-checked so they
         // can't traverse off it. Absolute hrefs (http(s), mailto:, …) stay as-is:
         // user-initiated navigation, not an auto-loaded resource, so no
         // proxy/IP-leak concern (proxy:false). URL_DENY-matching href was already
         // stripped by the attribute loop above.
         resolveMediaAttr(node, "href", proxyPrefix, false)
      } else if (tag === "IMG") {
         node.removeAttribute("srcset")
         // Relative src resolves against the pack base; external http(s) keeps the
         // proxy path (proxy:true) so the user's IP isn't leaked to feed hosts.
         resolveMediaAttr(node, "src", proxyPrefix, true)
      } else if (tag === "VIDEO") {
         // src passes external URLs through (proxy:false — image proxies don't
         // handle video); poster IS an image, so external posters take the proxy
         // path like img.src (leaving them direct would leak the user's IP).
         resolveMediaAttr(node, "src", proxyPrefix, false)
         resolveMediaAttr(node, "poster", proxyPrefix, true)
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
