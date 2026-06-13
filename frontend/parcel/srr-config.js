// Shared read-only access to the SRR YAML config for the Parcel dev tooling
// (resolve-cdn-url.js, resolve-store.js). Mirrors the backend's config source
// precedence (backend/main.go readConfig): $SRR_CONFIG_INLINE (raw YAML
// content) → $SRR_CONFIG (file path) → $XDG_CONFIG_HOME/srr/srr.yaml. Returns
// "" when no source is readable, so callers fall back to their own defaults.
function readConfigYaml() {
   if (process.env.SRR_CONFIG_INLINE) return process.env.SRR_CONFIG_INLINE
   try {
      const { join } = require("path")
      const f =
         process.env.SRR_CONFIG ||
         join(process.env.XDG_CONFIG_HOME || join(require("os").homedir(), ".config"), "srr", "srr.yaml")
      return require("fs").readFileSync(f, "utf8")
   } catch {
      return ""
   }
}

// Reads a single top-level scalar key from the (flat) SRR config YAML. The
// config is intentionally simple — top-level `key: value` lines — so a line
// match is enough; no YAML dependency in the build tooling.
function parseKey(yaml, key) {
   const m = yaml.match(new RegExp("^" + key + ":\\s*(.+)", "m"))
   // Strip surrounding quotes so a quoted scalar (store: "../packs") reads the
   // same as the backend's real-YAML parse instead of baking the quotes in.
   return m ? m[1].trim().replace(/^(["'])(.*)\1$/, "$2") : null
}

module.exports = { readConfigYaml, parseKey }
