import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { extractImageUrls, sanitizeHtml, timeAgo, formatDate, imgProxy, getImgProxy, setImgProxy } from "./fmt"

beforeEach(() => {
   localStorage.clear()
})

describe("sanitizeHtml", () => {
   it("removes script elements", () => {
      expect(sanitizeHtml("<p>ok</p><script>alert(1)</script>")).toBe("<p>ok</p>")
   })

   it("removes script elements with src", () => {
      expect(sanitizeHtml('<script src="evil.js"></script><p>ok</p>')).toBe("<p>ok</p>")
   })

   it("removes style, iframe, embed, object, form, link, meta, base", () => {
      const tags = ["style", "iframe", "embed", "object", "form", "link", "meta", "base"]
      for (const tag of tags) {
         const result = sanitizeHtml(`<${tag}></${tag}><p>ok</p>`)
         expect(result).toBe("<p>ok</p>")
      }
   })

   it("strips on* event handler attributes", () => {
      expect(sanitizeHtml('<img onerror="alert(1)" src="x">')).not.toContain("onerror")
      expect(sanitizeHtml('<div onclick="alert(1)">ok</div>')).not.toContain("onclick")
      expect(sanitizeHtml('<body onload="alert(1)">ok</body>')).not.toContain("onload")
   })

   it("strips javascript: URLs from href", () => {
      const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>')
      expect(result).not.toContain("javascript:")
   })

   it("strips whitespace-padded javascript: URLs", () => {
      const result = sanitizeHtml('<a href=" javascript:alert(1)">click</a>')
      expect(result).not.toContain("javascript:")
   })

   it("preserves safe HTML elements and text", () => {
      const html = "<div><p>Hello</p><span>world</span></div>"
      expect(sanitizeHtml(html)).toBe(html)
   })

   it("adds rel=noopener noreferrer to anchors", () => {
      const result = sanitizeHtml('<a href="https://example.com">link</a>')
      expect(result).toContain('rel="noopener noreferrer"')
   })

   it("handles nested dangerous elements inside safe containers", () => {
      const result = sanitizeHtml("<div><script>alert(1)</script><p>safe</p></div>")
      expect(result).toBe("<div><p>safe</p></div>")
   })

   it("returns empty string for empty input", () => {
      expect(sanitizeHtml("")).toBe("")
   })

   it("strips case-insensitive JAVASCRIPT: URLs", () => {
      const result = sanitizeHtml('<a href="JAVASCRIPT:alert(1)">click</a>')
      expect(result).not.toContain("JAVASCRIPT:")
   })

   it("strips javascript: from non-href attributes", () => {
      const result = sanitizeHtml('<img src="javascript:alert(1)">')
      expect(result).not.toContain("javascript:")
   })

   it("strips multiple on* attributes from same element", () => {
      const result = sanitizeHtml('<div onclick="a()" onmouseover="b()">ok</div>')
      expect(result).not.toContain("onclick")
      expect(result).not.toContain("onmouseover")
      expect(result).toContain("ok")
   })

   it("strips class attribute (mirrors backend bluemonday allowlist)", () => {
      const result = sanitizeHtml('<p class="highlight">text</p><div class="a b">x</div>')
      expect(result).not.toContain("class")
      expect(result).toContain("text")
      expect(result).toContain("x")
   })

   it("preserves safe attributes", () => {
      const result = sanitizeHtml('<img src="img.png" alt="photo" width="100">')
      expect(result).toContain('src="img.png"')
      expect(result).toContain('alt="photo"')
      expect(result).toContain('width="100"')
   })

   it("handles deeply nested content", () => {
      const result = sanitizeHtml("<div><p><span><script>x</script>safe</span></p></div>")
      expect(result).toBe("<div><p><span>safe</span></p></div>")
   })

   it("handles plain text without tags", () => {
      expect(sanitizeHtml("hello world")).toBe("hello world")
   })

   it("preserves self-closing tags like br", () => {
      const result = sanitizeHtml("<p>line1<br>line2</p>")
      expect(result).toContain("<br>")
      expect(result).toContain("line1")
      expect(result).toContain("line2")
   })

   it("adds rel to anchor without href", () => {
      const result = sanitizeHtml("<a>link</a>")
      expect(result).toContain('rel="noopener noreferrer"')
   })

   it("strips javascript: with whitespace between keyword and colon", () => {
      const result = sanitizeHtml('<a href="javascript :alert(1)">click</a>')
      expect(result).not.toContain("javascript")
   })

   it("strips data:, vbscript:, file: from href and src", () => {
      expect(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain("data:")
      expect(sanitizeHtml('<img src="data:image/svg+xml,<svg onload=alert(1)></svg>">')).not.toContain("data:")
      expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).not.toContain("vbscript")
      expect(sanitizeHtml('<a href="file:///etc/passwd">x</a>')).not.toContain("file:")
   })
})

// SRR_CDN_URL is defined as "http://localhost:3000" in vitest.config.ts, so the
// pack base resolves there — the same value data.ts uses for DB_URL.
describe("sanitizeHtml self-hosted assets", () => {
   const attr = (html: string, sel: string, name: string): string | null => {
      const t = document.createElement("template")
      t.innerHTML = sanitizeHtml(html)
      return t.content.querySelector(sel)!.getAttribute(name)
   }

   it("resolves an assets/ img src against the pack base (no proxy)", () => {
      expect(attr('<img src="assets/ab/cd1234.jpg">', "img", "src")).toBe("http://localhost:3000/assets/ab/cd1234.jpg")
   })

   it("resolves assets/ video src and poster against the pack base", () => {
      const html = '<video src="assets/bb/2222.mp4" poster="assets/cc/3333.jpg" controls></video>'
      expect(attr(html, "video", "src")).toBe("http://localhost:3000/assets/bb/2222.mp4")
      expect(attr(html, "video", "poster")).toBe("http://localhost:3000/assets/cc/3333.jpg")
   })

   it("leaves external http(s) img URLs on the proxy path (no asset resolution)", () => {
      // Proxy is passthrough by default, so the external URL is unchanged and
      // is NOT rewritten to the pack base.
      const out = attr('<img src="https://cdn.example.com/x.jpg">', "img", "src")
      expect(out).toBe("https://cdn.example.com/x.jpg")
   })

   it("leaves external video URLs untouched", () => {
      const out = attr('<video src="https://cdn.example.com/v.mp4"></video>', "video", "src")
      expect(out).toBe("https://cdn.example.com/v.mp4")
   })

   it("routes an external video poster through the image proxy (mirrors img.src)", () => {
      setImgProxy("https://my-proxy.example/?u=")
      const html = '<video src="https://cdn.example.com/v.mp4" poster="https://cdn.example.com/p.jpg"></video>'
      expect(attr(html, "video", "poster")).toBe(
         "https://my-proxy.example/?u=" + encodeURIComponent("https://cdn.example.com/p.jpg"),
      )
      // src stays direct — image proxies don't handle video.
      expect(attr(html, "video", "src")).toBe("https://cdn.example.com/v.mp4")
   })
})

describe("timeAgo", () => {
   beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2025-01-15T12:00:00Z"))
   })

   afterEach(() => {
      vi.useRealTimers()
   })

   const now = Math.floor(new Date("2025-01-15T12:00:00Z").getTime() / 1000)

   it("formats seconds ago", () => {
      const result = timeAgo(now - 30)
      expect(result).toMatch(/30/)
   })

   it("formats minutes ago", () => {
      const result = timeAgo(now - 120)
      expect(result).toMatch(/2/)
   })

   it("formats hours ago", () => {
      const result = timeAgo(now - 7200)
      expect(result).toMatch(/2/)
   })

   it("formats days ago", () => {
      const result = timeAgo(now - 172800)
      expect(result).toMatch(/2/)
   })

   it("formats months ago", () => {
      const result = timeAgo(now - 5184000)
      expect(result).toMatch(/2/)
   })

   it("formats years ago", () => {
      const result = timeAgo(now - 63072000)
      expect(result).toMatch(/2/)
   })

   it("boundary: exactly 60 seconds shows minutes", () => {
      const result = timeAgo(now - 60)
      expect(result).toMatch(/1/)
      expect(result).not.toMatch(/60/)
   })

   it("boundary: exactly 3600 seconds shows hours", () => {
      const result = timeAgo(now - 3600)
      expect(result).toMatch(/1/)
   })

   it("boundary: exactly 86400 seconds shows days", () => {
      const result = timeAgo(now - 86400)
      expect(result).toMatch(/1/)
   })

   it("handles 0 seconds ago", () => {
      const result = timeAgo(now)
      expect(result).toMatch(/0/)
   })

   it("boundary: exactly 2592000 seconds (30 days) shows months", () => {
      const result = timeAgo(now - 2592000)
      expect(result).toMatch(/1/)
   })

   it("boundary: exactly 31536000 seconds (365 days) shows years", () => {
      const result = timeAgo(now - 31536000)
      expect(result).toMatch(/1/)
   })

   it("handles future timestamp (negative elapsed)", () => {
      const result = timeAgo(now + 60)
      expect(result).toBeDefined()
   })
})

describe("extractImageUrls", () => {
   it("returns all http(s) image URLs", () => {
      const html = '<p>x</p><img src="http://a.com/1.jpg"><img src="https://b.com/2.png"><img src="http://c.com/3.gif">'
      expect(extractImageUrls(html)).toEqual(["http://a.com/1.jpg", "https://b.com/2.png", "http://c.com/3.gif"])
   })

   it("ignores non-http schemes", () => {
      const html = '<img src="data:image/png;base64,xx"><img src="//cdn/x.jpg"><img src="https://ok.com/x.jpg">'
      expect(extractImageUrls(html)).toEqual(["https://ok.com/x.jpg"])
   })

   it("returns empty for no images or empty input", () => {
      expect(extractImageUrls("<p>no images</p>")).toEqual([])
      expect(extractImageUrls("")).toEqual([])
   })

   it("extracts unquoted src (backend #minify strips quotes for clean URLs)", () => {
      // The #minify pass on the backend drops attribute quotes when the value
      // has no special chars — common for YouTube thumb URLs and Telegram CDN
      // URLs. Both forms must be recognised or those channels never prefetch.
      const html =
         "<p><a href=https://yt.example/watch?v=ABC><img src=https://i.ytimg.com/vi/ABC/hqdefault.jpg alt=t></a></p>"
      expect(extractImageUrls(html)).toEqual(["https://i.ytimg.com/vi/ABC/hqdefault.jpg"])
   })

   it("mixes quoted and unquoted img tags in one pass", () => {
      const html = "<img src=\"http://a.com/1.jpg\"><img src=https://b.com/2.png><img src='http://c.com/3.gif'>"
      expect(extractImageUrls(html)).toEqual(["http://a.com/1.jpg", "https://b.com/2.png", "http://c.com/3.gif"])
   })

   it("matches the exact URL sanitizeHtml writes (so preload hrefs share cache)", () => {
      // Serialized HTML escapes & as &amp;; the browser decodes it on parse, so
      // compare the parsed attribute value (not the serialized string).
      const raw = "http://example.com/pic.jpg"
      const t = document.createElement("template")
      t.innerHTML = sanitizeHtml(`<img src="${raw}">`)
      const img = t.content.querySelector("img")!
      expect(img.getAttribute("src")).toBe(imgProxy(raw, getImgProxy()))
   })
})

describe("image proxy", () => {
   it("defaults to passthrough when no localStorage override is set", () => {
      expect(getImgProxy()).toBe("")
      const raw = "https://example.com/x.jpg"
      expect(imgProxy(raw, getImgProxy())).toBe(raw)
   })

   it("returns the raw URL when prefix is empty (proxy disabled)", () => {
      const raw = "https://example.com/x.jpg"
      expect(imgProxy(raw, "")).toBe(raw)
   })

   it("supports a custom proxy prefix", () => {
      const raw = "https://example.com/x.jpg"
      const prefix = "https://imagor.example.com/unsafe/600x600/filters:format(webp)/"
      expect(imgProxy(raw, prefix)).toBe(prefix + encodeURIComponent(raw))
   })

   it("URL-encodes the source so query strings and spaces survive", () => {
      const raw = "https://example.com/a b.jpg?x=1&y=2"
      const prefix = "https://p.example/?u="
      expect(imgProxy(raw, prefix)).toBe(prefix + encodeURIComponent(raw))
   })

   it("uses localStorage override when set", () => {
      setImgProxy("https://my-proxy.example/?u=")
      const out = imgProxy("https://example.com/x.jpg", getImgProxy())
      expect(out.startsWith("https://my-proxy.example/?u=")).toBe(true)
   })

   it("passes through even when localStorage explicitly stores empty string", () => {
      setImgProxy("")
      const raw = "https://example.com/x.jpg"
      expect(imgProxy(raw, getImgProxy())).toBe(raw)
   })
})

describe("formatDate", () => {
   it("formats a known timestamp correctly", () => {
      // Construct expected dynamically to avoid timezone issues
      const unix = 1705312800 // 2024-01-15 in UTC
      const d = new Date(unix * 1000)
      const pad = (n: number) => n.toString().padStart(2, "0")
      const expected = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      expect(formatDate(unix)).toBe(expected)
   })

   it("zero-pads single-digit values", () => {
      // Use a timestamp and verify the format pattern
      const result = formatDate(1705312800)
      expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
   })

   it("formats unix epoch (0)", () => {
      const d = new Date(0)
      const pad = (n: number) => n.toString().padStart(2, "0")
      const expected = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      expect(formatDate(0)).toBe(expected)
   })
})
