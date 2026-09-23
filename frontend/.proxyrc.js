// Dev-server only, two jobs. Parcel's reporter-dev-server applies this file as
// connect middleware BEFORE its own request handler (`applyProxyTable(app)`
// then `app.use(finalHandler)`), so both rewrites below run in front of Parcel.
//
// 1. Parcel's dev server has no default-document at the bare root: it serves
//    bundles by name, so `GET /` (and any extensionless path) returns 403
//    Forbidden while `/index.html` serves fine. We rewrite a bare-root request
//    to `/index.html` in place. No redirect: the URL stays
//    http://localhost:1234/ and Parcel serves the app's HTML directly. (Parcel
//    reads req.originalUrl || req.url when routing, so both are set.)
//
// 2. Dev only: the admin page calls /api/* and the reader's sync /sync/* on its
//    own origin; forward both to a local `srr serve` (default 127.0.0.1:8088,
//    override with SRR_SERVE_ADDR). The Host header is rewritten to the
//    loopback address so serve's hostGuard accepts it, exactly like the
//    production reverse proxy.
//
// Read ONLY by `parcel serve` (dev). `parcel build` ignores it, so production
// output is unaffected.
const http = require("node:http")

const API = process.env.SRR_SERVE_ADDR || "127.0.0.1:8088"
// API.split(":") breaks on an IPv6 literal ("[::1]:8088") and on a bare
// ":8088" (port-only, host defaulting to loopback) — split on the LAST colon
// instead, and strip the brackets an IPv6 host is wrapped in.
const splitAt = API.lastIndexOf(":")
let apiHost = splitAt === -1 ? API : API.slice(0, splitAt)
// No colon at all (host-only, e.g. a bare "127.0.0.1") means no port was
// given either — default it to 8088 rather than falling through to
// Number("") = 0, which would try to dial port 0.
const apiPort = splitAt === -1 ? "8088" : API.slice(splitAt + 1) || "8088"
apiHost = apiHost.replace(/^\[|\]$/g, "") || "127.0.0.1"
// serve's hostGuard accepts localhost/127.0.0.1/::1 with ANY port, so a
// loopback Host built from the parsed port always passes — unlike forwarding
// SRR_SERVE_ADDR's raw value, which for a port-only ":8088" would send the
// literal Host ":8088" and get rejected as non-loopback.
const proxyHost = `localhost:${apiPort}`

module.exports = function (app) {
   app.use((req, res, next) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/sync/")) {
         const up = http.request(
            { host: apiHost, port: Number(apiPort), method: req.method, path: req.url, headers: { ...req.headers, host: proxyHost } },
            (r) => {
               res.writeHead(r.statusCode || 502, r.headers)
               r.pipe(res)
            },
         )
         up.on("error", (e) => {
            res.statusCode = 502
            res.end(`dev proxy: no srr serve at ${API} (${e.message})`)
         })
         // A client disconnect (e.g. the admin page cancelling a streamed
         // /api/fetch) must cancel the upstream request too, or srr serve keeps
         // running the whole cycle it can no longer report on.
         res.on("close", () => up.destroy())
         req.pipe(up)
         return
      }
      if (req.url === "/" || req.url === "") {
         req.url = "/index.html"
         req.originalUrl = "/index.html"
      }
      next()
   })
}
