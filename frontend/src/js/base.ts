// PACK_BASE is the URL every store key resolves against: pack addressing in
// data.ts and the content-URL bounds check in fmt.ts must agree on one base,
// and neither module is a neutral owner (fmt.ts is the sanitizer's home;
// importing data.ts triggers its eager db.gz fetch). Computed once at module
// load; SRR_CDN_URL is replaced at build time (see parcel/resolve-cdn-url.js).
export const PACK_BASE = new URL(SRR_CDN_URL, window.location.href)
