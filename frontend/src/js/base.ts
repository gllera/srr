// PACK_BASE is the URL every store key resolves against: pack addressing in
// data.ts and the content-URL bounds check in fmt.ts must agree on one base,
// and neither module is a neutral owner (fmt.ts is the sanitizer's home;
// importing data.ts triggers its eager db.gz fetch). Computed once at module
// load; the SRR_CDN_URL global is replaced with a string literal at build time
// (see parcel/transformer-define.js, resolved via parcel/resolve-cdn-url.js).
export const PACK_BASE = new URL(SRR_CDN_URL, window.location.href)

// The build's version label (the settings-menu status footer + anything else that wants to
// name the running build): transformer-define.js inlines SRR_VERSION from the
// $VERSION env — the tag in release.yml's build jobs — else "dev". Exported
// from base.ts because this is the one module the define transformer already
// covers (.parcelrc lists transformers per file).
export const VERSION = SRR_VERSION
