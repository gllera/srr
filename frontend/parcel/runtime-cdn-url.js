const { Runtime } = require("@parcel/plugin")

const cdnUrl = require("./resolve-cdn-url")()

module.exports = new Runtime({
   apply({ bundle }) {
      if (bundle.type !== "js" || !bundle.env.isBrowser()) return

      return {
         filePath: __filename,
         code: `globalThis.SRR_CDN_URL = ${JSON.stringify(cdnUrl)};`,
         isEntry: true,
      }
   },
})
