// Shared http(s)-URL validate/normalize helpers, side-effect-free (like
// keys.ts — no imports): fmt.ts, profile.ts, and sync.ts all consume them, and
// the latter two deliberately do not import fmt.ts (which pulls base.ts's
// module-load `new URL(SRR_CDN_URL, …)` side effect and would break their
// unit-testability), so this is the one home the three used to hand-sync copies
// around.

// Mirror the backend bluemonday allowlist (mailto, http, https) for defense-in-depth.
// data:/vbscript:/javascript:/file: in href or src are XSS or info-leak vectors
// (data:text/html executes script; data:image/svg+xml runs <script> in SVG).
export const URL_DENY = /^\s*(?:javascript|data|vbscript|file)\s*:/i

export const HTTP_RE = /^https?:\/\//i

// A user-entered http(s) URL (the image-proxy prefix, the sync endpoint) with
// an OPTIONAL scheme: normalizeHttpish supplies https:// when none is typed.
// isValidHttpish therefore accepts the empty string (disables the feature), an
// explicit http(s):// value, or a schemeless host/path — and rejects only an
// explicit non-http(s) scheme (ftp://, javascript:, data:, …) that we must not
// silently rewrite to https.
export function isValidHttpish(v: string): boolean {
   const s = v.trim()
   if (s === "") return true
   if (HTTP_RE.test(s)) return true
   if (URL_DENY.test(s)) return false
   return !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

// normalizeHttpish canonicalises a user-entered URL for storage: trim it, supply
// the default https:// scheme when absent (folding a leading "//host" in too),
// and — with `trailingSlash` (a PREFIX value, like the image proxy's) — append
// "/" when it ends in an alphanumeric char: a bare host or path segment needs
// that boundary before the caller appends more, while a value already ending in
// "=", "?", "/", … is a ready join point. A full-endpoint value (the sync URL)
// passes false — "/profile" vs "/profile/" can be two different routes. Empty →
// empty (disabled). Idempotent at either flag.
export function normalizeHttpish(v: string, trailingSlash: boolean): string {
   let s = v.trim()
   if (s === "") return ""
   if (!HTTP_RE.test(s)) s = "https://" + s.replace(/^\/+/, "")
   if (trailingSlash && /[a-z0-9]$/i.test(s)) s += "/"
   return s
}
