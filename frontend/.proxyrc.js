// Dev-server only. Parcel's dev server has no default-document at the bare
// root: it serves bundles by name, so `GET /` (and any extensionless path)
// returns 403 Forbidden while `/index.html` serves fine. Parcel's
// reporter-dev-server applies this file as connect middleware BEFORE its own
// request handler (`applyProxyTable(app)` then `app.use(finalHandler)`), so we
// rewrite a bare-root request to `/index.html` in place. No redirect: the URL
// stays http://localhost:1234/ and Parcel serves the app's HTML directly.
// (Parcel reads req.originalUrl || req.url when routing, so both are set.)
//
// Read ONLY by `parcel serve` (dev). `parcel build` ignores it, so production
// output is unaffected.
module.exports = function (app) {
   app.use((req, res, next) => {
      if (req.url === "/" || req.url === "") {
         req.url = "/index.html"
         req.originalUrl = "/index.html"
      }
      next()
   })
}
