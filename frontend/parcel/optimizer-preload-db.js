const { Optimizer } = require("@parcel/plugin")

const cdnUrl = require("./resolve-cdn-url")()
const href = (cdnUrl.endsWith("/") ? cdnUrl : cdnUrl + "/") + "db.gz"
const crossorigin = /^https?:\/\//.test(href) ? " crossorigin" : ""
const tag = `<link rel="preload" href="${href}" as="fetch"${crossorigin}>`

module.exports = new Optimizer({
   async optimize({ contents, bundle }) {
      if (bundle.type !== "html") return { contents }
      let html = contents.toString().replace("</head>", tag + "</head>")
      html = html.replace(/\n\s*/g, "")
      return { contents: html }
   },
})
