import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { sanitizeHtml, timeAgo, formatDate } from "./fmt"

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

   it("adds loading=lazy to images", () => {
      const result = sanitizeHtml('<img src="img.png">')
      expect(result).toContain('loading="lazy"')
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
