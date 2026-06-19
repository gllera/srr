import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
   collapseBrokenMedia,
   extractImageUrls,
   sanitizeHtml,
   timeAgo,
   timeAgoProse,
   isStale,
   formatDate,
   imgProxy,
   getImgProxy,
   setImgProxy,
   isValidProxy,
   srcColorIndex,
   SRC_COLORS,
   dayLabel,
} from "./fmt"

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
      // A relative src is resolved against the pack base (see the self-hosted
      // assets suite); this case pins that alt/width ride through untouched.
      const result = sanitizeHtml('<img src="https://cdn.example.com/img.png" alt="photo" width="100">')
      expect(result).toContain('src="https://cdn.example.com/img.png"')
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

   it("adds loading=lazy, decoding=async and referrerpolicy=no-referrer to images", () => {
      const result = sanitizeHtml('<img src="https://feed.example/img.png" loading="eager">')
      expect(result).toContain('loading="lazy"') // overrides feed-supplied eager
      expect(result).toContain('decoding="async"')
      expect(result).toContain('referrerpolicy="no-referrer"')
      // <video> takes no referrerpolicy attribute — must not grow one
      expect(sanitizeHtml('<video src="https://feed.example/v.mp4"></video>')).not.toContain("referrerpolicy")
   })
})

// Defense-in-depth edge/XSS cases the basic suite above doesn't pin. These run
// against the root pack base (localhost:3000/); the off-base bounds drop needs a
// SUBPATH base and lives in fmt.bounds.test.ts.
describe("sanitizeHtml security edge cases", () => {
   const attr = (html: string, sel: string, name: string): string | null => {
      const t = document.createElement("template")
      t.innerHTML = sanitizeHtml(html)
      return t.content.querySelector(sel)!.getAttribute(name)
   }

   it("removes <svg> (and its <script> child) — foreign-content surface", () => {
      // bluemonday strips svg server-side; mirror it. The <script> inside must go
      // with the subtree, not survive as a detached executable.
      expect(sanitizeHtml("<svg><script>alert(1)</script></svg><p>ok</p>")).toBe("<p>ok</p>")
   })

   it("removes <math> (MathML foreign-content surface)", () => {
      expect(sanitizeHtml("<math><mtext>x</mtext></math><p>ok</p>")).toBe("<p>ok</p>")
   })

   it("strips srcset from <img> (an unbounded off-origin URL feed the single-src bounds check can't see)", () => {
      const out = sanitizeHtml(
         '<img src="https://cdn.example/x.jpg" srcset="//evil.example/a 1x, //evil.example/b 2x">',
      )
      expect(out).not.toContain("srcset")
      expect(out).not.toContain("evil.example")
   })

   it("neutralizes a tab-obfuscated javascript: href (URL parse strips the tab → off-base → dropped)", () => {
      // URL_DENY doesn't match a keyword with an interior tab; the safety comes
      // from the relative-resolution fallback: new URL() strips the tab, reveals
      // the javascript: scheme, which fails the pack-base bounds check → dropped.
      expect(attr('<a href="jaVa\tscript:alert(1)">x</a>', "a", "href")).toBeNull()
   })

   it("strips a mixed-case JaVaScRiPt: href (URL_DENY is case-insensitive)", () => {
      expect(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).not.toContain("alert")
   })

   it("leaves a javascript: anchor inert: no href, no onclick, but still decorated with rel", () => {
      // strip-then-decorate order must not produce a half-sanitized executable anchor.
      const out = sanitizeHtml('<a href="javascript:alert(1)" onclick="x()">link</a>')
      expect(out).not.toContain("javascript")
      expect(out).not.toContain("onclick")
      expect(out).toContain('rel="noopener noreferrer"')
      expect(out).toContain("link")
   })

   it("does NOT route a relative src through the image proxy even when a proxy is set", () => {
      // A relative ref is a self-hosted asset key — it resolves against the pack
      // base and bypasses the proxy (proxying it would both break it and is
      // pointless); only EXTERNAL http(s) refs take the proxy path.
      setImgProxy("https://p.example/?u=")
      expect(attr('<img src="assets/ab/cd.jpg">', "img", "src")).toBe("http://localhost:3000/assets/ab/cd.jpg")
   })

   // #2 — <source srcset> is never stripped today; this must fail before the fix.
   it("strips srcset from <source> inside <picture> (protocol-relative srcset bypasses URL_DENY)", () => {
      // A multi-value srcset bypasses the ^-anchored URL_DENY and the single-src
      // bounds check; strip it unconditionally just like <img srcset>.
      const out = sanitizeHtml('<picture><source srcset="//evil.example/a 1x, //evil.example/b 2x"></picture>')
      expect(out).not.toContain("srcset")
      expect(out).not.toContain("evil.example")
   })

   // #8 — <source src> is never bounds-checked today; this must fail before the fix.
   it("drops a protocol-relative <source src> that escapes the pack base (bounds-check parity with <video src>)", () => {
      // "//evil/v.mp4" has no URL scheme → isRelative() is true → resolvePackRelative
      // resolves it to http://evil/v.mp4, which doesn't startWith(PACK_BASE) →
      // the attribute is removed, same as <img src="//evil/..."> and <video src="//evil/...">.
      expect(attr('<video><source src="//evil.example/v.mp4"></video>', "source", "src")).toBeNull()
   })

   it("strips srcset from <source> even when the embedded URL has no // prefix", () => {
      // Any srcset on <source> is stripped — image proxies can't process multi-URL
      // descriptors, and the single-src bounds check doesn't cover them.
      const out = sanitizeHtml(
         '<picture><source srcset="https://cdn.example/a.jpg 1x, https://cdn.example/b.jpg 2x"></picture>',
      )
      expect(out).not.toContain("srcset")
   })
})

describe("collapseBrokenMedia", () => {
   // The error event doesn't bubble; production registers the handler on the
   // content container with capture: true, which still sees descendant errors.
   const container = (html: string): HTMLElement => {
      const div = document.createElement("div")
      div.innerHTML = html
      div.addEventListener("error", collapseBrokenMedia, true)
      document.body.appendChild(div)
      return div
   }

   afterEach(() => {
      document.body.innerHTML = ""
   })

   it("collapses an img whose load failed", () => {
      const div = container('<p>text</p><img src="https://dead.example/x.png">')
      div.querySelector("img")!.dispatchEvent(new Event("error"))
      expect(div.querySelector("img")!.classList.contains("srr-broken")).toBe(true)
      expect(div.querySelector("p")!.classList.contains("srr-broken")).toBe(false)
   })

   it("collapses the video hosting a failed source child", () => {
      const div = container('<video><source src="https://dead.example/x.mp4"></video>')
      div.querySelector("source")!.dispatchEvent(new Event("error"))
      expect(div.querySelector("video")!.classList.contains("srr-broken")).toBe(true)
   })

   it("ignores errors from non-media elements", () => {
      const div = container("<p>text</p>")
      div.querySelector("p")!.dispatchEvent(new Event("error"))
      expect(div.querySelector(".srr-broken")).toBeNull()
   })
})

// SRR_CDN_URL is defined as "http://localhost:3000" in vitest.config.ts, so the
// pack base resolves there — the same PACK_BASE data.ts addresses packs with.
describe("sanitizeHtml relative URL resolution", () => {
   const attr = (html: string, sel: string, name: string): string | null => {
      const t = document.createElement("template")
      t.innerHTML = sanitizeHtml(html)
      return t.content.querySelector(sel)!.getAttribute(name)
   }

   it("resolves an assets/ img src against the pack base (no proxy)", () => {
      expect(attr('<img src="assets/ab/cd1234.jpg">', "img", "src")).toBe("http://localhost:3000/assets/ab/cd1234.jpg")
   })

   it("resolves a non-assets relative img src against the pack base (not just assets/)", () => {
      expect(attr('<img src="img/photo.jpg">', "img", "src")).toBe("http://localhost:3000/img/photo.jpg")
      expect(attr('<img src="/rooted.jpg">', "img", "src")).toBe("http://localhost:3000/rooted.jpg")
   })

   it("resolves a non-assets relative anchor href against the pack base", () => {
      expect(attr('<a href="docs/report.pdf">x</a>', "a", "href")).toBe("http://localhost:3000/docs/report.pdf")
   })

   it("drops a protocol-relative ref pointing at a foreign origin", () => {
      // "//evil.example" has no scheme so it's relative, but resolves to a foreign
      // origin — the bounds check drops it instead of letting the browser load it
      // direct (an IP-leak vector that the prior assets/-only check let through).
      expect(attr('<img src="//evil.example/x.jpg">', "img", "src")).toBeNull()
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

   it("resolves an assets/ anchor href against the pack base (self-hosted file)", () => {
      expect(attr('<a href="assets/de/9f01.pdf">doc</a>', "a", "href")).toBe("http://localhost:3000/assets/de/9f01.pdf")
   })

   it("leaves an external anchor href untouched (navigation, not an asset)", () => {
      expect(attr('<a href="https://example.com/page">x</a>', "a", "href")).toBe("https://example.com/page")
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
      // has no special chars — common for clean CDN URLs. Both forms must be
      // recognised or those feeds never prefetch.
      const html = "<p><a href=https://example.com/post/ABC><img src=https://cdn.example/img/ABC.jpg alt=t></a></p>"
      expect(extractImageUrls(html)).toEqual(["https://cdn.example/img/ABC.jpg"])
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

   it("ignores an <img> with only srcset (no src) — nothing to prefetch", () => {
      expect(extractImageUrls('<img srcset="https://cdn.example/a 1x, https://cdn.example/b 2x">')).toEqual([])
   })

   it("prefers the real src when a data-src placeholder precedes it (greedy match lands on the last src=)", () => {
      const html = '<img data-src="https://lazy.example/placeholder.gif" src="https://cdn.example/real.jpg">'
      expect(extractImageUrls(html)).toEqual(["https://cdn.example/real.jpg"])
   })

   it("scrapes a lone data-src as a fallback (documented: \\bsrc matches data-src; harmless for prefetch)", () => {
      // Pins current behavior — the prefetch list is best-effort warming, so
      // warming a data-src lazy URL when there's no real src is acceptable.
      expect(extractImageUrls('<img data-src="https://lazy.example/x.jpg">')).toEqual(["https://lazy.example/x.jpg"])
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

describe("isValidProxy", () => {
   const cases: Array<[string, boolean]> = [
      ["", true], // empty disables the proxy
      ["https://p.example/?url=", true],
      ["http://192.168.1.4:8000/unsafe/", true], // http allowed for LAN proxies
      ["HTTPS://P.EXAMPLE/?url=", true], // scheme match is case-insensitive
      ["ftp://p.example/", false],
      ["p.example/?url=", false], // schemeless can't produce a fetchable URL
      ["javascript:alert(1)", false],
   ]
   for (const [value, want] of cases) {
      it(`${JSON.stringify(value)} → ${want}`, () => {
         expect(isValidProxy(value)).toBe(want)
      })
   }
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

describe("srcColorIndex", () => {
   it("is deterministic for a given feed id", () => {
      expect(srcColorIndex(3)).toBe(srcColorIndex(3))
   })

   it("always lands in [0, SRC_COLORS)", () => {
      for (const id of [0, 1, 7, 8, 42, 255, 1000]) {
         const i = srcColorIndex(id)
         expect(i).toBeGreaterThanOrEqual(0)
         expect(i).toBeLessThan(SRC_COLORS)
      }
   })

   it("gives sequential feed ids distinct colors until the ramp wraps", () => {
      const slots = Array.from({ length: SRC_COLORS }, (_, id) => srcColorIndex(id))
      expect(new Set(slots).size).toBe(SRC_COLORS)
   })

   it("wraps modulo SRC_COLORS", () => {
      expect(srcColorIndex(SRC_COLORS)).toBe(srcColorIndex(0))
      expect(srcColorIndex(SRC_COLORS + 2)).toBe(srcColorIndex(2))
   })

   it("never returns a negative slot for a negative id", () => {
      expect(srcColorIndex(-1)).toBeGreaterThanOrEqual(0)
      expect(srcColorIndex(-1)).toBeLessThan(SRC_COLORS)
   })
})

describe("dayLabel", () => {
   const at = (y: number, m: number, d: number) => Math.floor(new Date(y, m, d, 12, 0, 0).getTime() / 1000)

   it("labels today and yesterday relatively", () => {
      const now = new Date()
      const today = at(now.getFullYear(), now.getMonth(), now.getDate())
      const yesterday = at(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      expect(dayLabel(today)).toBe("TODAY")
      expect(dayLabel(yesterday)).toBe("YESTERDAY")
   })

   it("labels an older date with weekday, day, month and the year", () => {
      // 9 Jun 2020 was a Tuesday; year shown because it isn't the current year.
      expect(dayLabel(at(2020, 5, 9))).toBe("TUE 9 JUN 2020")
   })
})

describe("timeAgoProse", () => {
   beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2025-01-15T12:00:00Z"))
   })

   afterEach(() => {
      vi.useRealTimers()
   })

   const now = Math.floor(new Date("2025-01-15T12:00:00Z").getTime() / 1000)

   it("returns 'just now' for 0 seconds ago", () => {
      expect(timeAgoProse(now)).toBe("just now")
   })

   it("returns 'just now' for a few seconds ago", () => {
      expect(timeAgoProse(now - 45)).toBe("just now")
   })

   it("returns '1 minute ago' for exactly 60 seconds", () => {
      expect(timeAgoProse(now - 60)).toBe("1 minute ago")
   })

   it("returns '2 minutes ago' for 2 minutes (plural)", () => {
      expect(timeAgoProse(now - 120)).toBe("2 minutes ago")
   })

   it("returns '1 hour ago' for exactly 1 hour (singular)", () => {
      expect(timeAgoProse(now - 3600)).toBe("1 hour ago")
   })

   it("returns '2 hours ago' for 2 hours (plural)", () => {
      expect(timeAgoProse(now - 7200)).toBe("2 hours ago")
   })

   it("returns '1 day ago' for exactly 1 day (singular)", () => {
      expect(timeAgoProse(now - 86400)).toBe("1 day ago")
   })

   it("returns '2 days ago' for 2 days (plural)", () => {
      expect(timeAgoProse(now - 172800)).toBe("2 days ago")
   })

   it("returns '1 month ago' for 30 days (singular)", () => {
      expect(timeAgoProse(now - 2592000)).toBe("1 month ago")
   })

   it("returns '2 months ago' for 60 days (plural)", () => {
      expect(timeAgoProse(now - 5184000)).toBe("2 months ago")
   })

   it("returns '1 year ago' for 365 days (singular)", () => {
      expect(timeAgoProse(now - 31536000)).toBe("1 year ago")
   })

   it("returns '2 years ago' for 2 years (plural)", () => {
      expect(timeAgoProse(now - 63072000)).toBe("2 years ago")
   })

   it("handles future timestamp (treats as just now)", () => {
      expect(timeAgoProse(now + 60)).toBe("just now")
   })
})

describe("isStale", () => {
   beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2025-01-15T12:00:00Z"))
   })

   afterEach(() => {
      vi.useRealTimers()
   })

   const now = Math.floor(new Date("2025-01-15T12:00:00Z").getTime() / 1000)
   // STALE_AFTER_SEC = 3 * 86400 = 259200

   it("returns false for 0 (absent fetched_at)", () => {
      expect(isStale(0)).toBe(false)
   })

   it("returns false for a recent timestamp (just now)", () => {
      expect(isStale(now - 60)).toBe(false)
   })

   it("returns false for 2 days ago (below threshold)", () => {
      expect(isStale(now - 2 * 86400)).toBe(false)
   })

   it("returns true at exactly the 3-day threshold", () => {
      expect(isStale(now - 3 * 86400)).toBe(true)
   })

   it("returns true for 4 days ago (above threshold)", () => {
      expect(isStale(now - 4 * 86400)).toBe(true)
   })
})
