const { Optimizer } = require("@parcel/plugin")

const cdnUrl = require("./resolve-cdn-url")()
const href = (cdnUrl.endsWith("/") ? cdnUrl : cdnUrl + "/") + "db.gz"
const crossorigin = /^https?:\/\//.test(href) ? " crossorigin" : ""
const tag = `<link rel="preload" href="${href}" as="fetch"${crossorigin}>`

module.exports = new Optimizer({
   async optimize({ contents, bundle }) {
      if (bundle.type !== "html") return { contents }
      // The admin console (src/admin.html) never fetches db.gz — skip its preload
      // (it would 404 on the admin origin). Keyed on the SOURCE entry, not the
      // output name, so it is unaffected by build-admin's index.html rename. The
      // reader (index.html) still gets the preload, so its output is unchanged.
      const entry = bundle.getMainEntry && bundle.getMainEntry()
      if (entry && entry.filePath && entry.filePath.endsWith("admin.html")) return { contents }
      let html = contents.toString().replace("</head>", tag + "</head>")
      html = html.replace(/\n\s*/g, "")
      return { contents: html }
   },
})
