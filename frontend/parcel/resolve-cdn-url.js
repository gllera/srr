function resolve() {
   if (process.env.SRR_CDN_URL) return process.env.SRR_CDN_URL
   try {
      const { join } = require("path")
      const f =
         process.env.SRR_CONFIG ||
         join(
            process.env.XDG_CONFIG_HOME || join(require("os").homedir(), ".config"),
            "srr",
            "srr.yaml",
         )
      const m = require("fs").readFileSync(f, "utf8").match(/^cdn-url:\s*(.+)/m)
      if (m) return m[1].trim()
   } catch {}
   return "http://localhost:3000"
}

const cached = resolve()
module.exports = () => cached
