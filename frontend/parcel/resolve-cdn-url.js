function parseCdnUrl(yaml) {
   const m = yaml.match(/^cdn-url:\s*(.+)/m)
   return m ? m[1].trim() : null
}

function resolve() {
   if (process.env.SRR_CDN_URL) return process.env.SRR_CDN_URL
   if (process.env.SRR_CONFIG_INLINE) {
      return parseCdnUrl(process.env.SRR_CONFIG_INLINE) || "http://localhost:3000"
   }
   try {
      const { join } = require("path")
      const f =
         process.env.SRR_CONFIG ||
         join(
            process.env.XDG_CONFIG_HOME || join(require("os").homedir(), ".config"),
            "srr",
            "srr.yaml",
         )
      const url = parseCdnUrl(require("fs").readFileSync(f, "utf8"))
      if (url) return url
   } catch {}
   return "http://localhost:3000"
}

const cached = resolve()
module.exports = () => cached
