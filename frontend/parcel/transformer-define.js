const { Transformer } = require("@parcel/plugin")

// Build-time defines for the app's own source. Parcel 2.16.4 reliably does
// NEITHER of these here, so we substitute literals ourselves:
//
//  - SRR_CDN_URL  → the resolved CDN base (env -> config cdn-url -> dev default).
//    Parcel tree-shook the prior side-effect-only runtime entry that set this
//    global (it exported nothing and nothing imported it), leaving the deployed
//    app to throw "SRR_CDN_URL is not defined" on boot.
//
//  - process.env.NODE_ENV → the build's NODE_ENV ("production" under
//    `parcel build`, "development" under `parcel serve`). Parcel leaves this
//    reference un-inlined, so it throws "process is not defined" at runtime —
//    which crashed app.ts right before its NODE_ENV-gated service-worker
//    registration, silently killing the whole offline/PWA path.
//
// Resolution still lives in resolve-cdn-url.js; this only substitutes results.
const cdnUrl = require("./resolve-cdn-url")()
const nodeEnv = process.env.NODE_ENV || "production"
// SRR_VERSION → the build's version label (config.ts's status footer). CI sets
// VERSION to the release tag (release.yml, both build jobs); elsewhere "dev".
const version = process.env.VERSION || "dev"

module.exports = new Transformer({
   async transform({ asset }) {
      let code = await asset.getCode()
      let changed = false
      if (code.includes("SRR_CDN_URL")) {
         code = code.replaceAll("SRR_CDN_URL", JSON.stringify(cdnUrl))
         changed = true
      }
      if (code.includes("SRR_VERSION")) {
         code = code.replaceAll("SRR_VERSION", JSON.stringify(version))
         changed = true
      }
      if (code.includes("process.env.NODE_ENV")) {
         code = code.replaceAll("process.env.NODE_ENV", JSON.stringify(nodeEnv))
         changed = true
      }
      if (changed) asset.setCode(code)
      return [asset]
   },
})
