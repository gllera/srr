# Self-hosting SRR behind a reverse proxy

This is the deployment shape for running SRR entirely outside Cloudflare (or
any other hosted platform): one box, one origin, a reverse proxy doing
TLS termination, forward-auth and Cache-Control, and `srr serve` doing the
API. Everything here uses `example.com` placeholders — substitute your own
domain and paths.

## 1. Shape

One origin serves everything:

- The **store root** *is* the **reader root**. `srr frontend update`
  installs the reader (`index.html`, content-hashed JS/CSS, the service
  worker) and the admin page (`admin.html`) directly into the pack store
  directory, next to `db.gz`. There is no separate reader deployment.
- `srr serve` is **API-only** — it answers `/api/*` (the admin page's
  backing API) and `/sync/*` (the reader-profile sync endpoint) on
  `127.0.0.1:8088`, and nothing else. The reverse proxy routes those two
  path prefixes to `srr serve`; every other path is served as a static
  file straight out of the store directory.
- A **forward-auth gate** sits in front of the whole thing, on every path but
  two — the login portal itself (`/auth`), and the service-worker script
  (`sw.<hash>.js`), which browsers fetch without cookies, so a gated one never
  registers —
  the store may hold a private subscription list and reading history (see
  `docs/STORE-VISIBILITY.md`), so gating only `/api/*` would leave the
  packs themselves world-readable.
- **MCP is stdio-only.** There is no HTTP/MCP endpoint to route through the
  proxy. Reach a remote store's MCP tools over SSH: `ssh <host> srr mcp`
  (the CLI on the far end talks to the store directly; nothing new needs
  exposing). A non-interactive ssh command runs without your login shell's
  PATH, so a bare `srr mcp` can fail "command not found" even though it
  works interactively — use an absolute install path and pass the store
  explicitly, e.g. `ssh host 'SRR_STORE=/srv/srr ~/.local/bin/srr mcp'`.

## 2. Store directory

Use the `local` backend for a self-hosted box: `-o /srv/srr` (or whatever
directory the reverse proxy's `root` points at). Two things matter:

- The directory must be **readable by the process serving static files**
  (the proxy, or whatever it hands off to) — a plain filesystem read, no
  `srr` process needs to be alive for the reader or the packs to load.
- If the proxy runs under systemd with `ProtectHome=true` (or similar
  sandboxing), the store directory must **not** live under a user's home
  directory, or the proxy will fail to read it. `/srv/srr` (outside
  `/home`) is the safe default; `~/srr-store` is not.

Install the reader + admin page into it once `srr fetch` has populated the
store:

```bash
srr -o /srv/srr frontend update
```

Re-run that after every release you want to pick up; it is the operator's
command, never run automatically.

## 3. Caddy example

A worked reverse-proxy config. It terminates TLS, forward-authenticates
every request, hides backend-only objects, routes the API, mirrors SRR's
own Cache-Control contract, and locks down the two HTML entry points and
any feed-supplied assets sharing the origin.

```caddyfile
srr.example.com {
	encode zstd gzip
	root * /srv/srr

	route {
		# The forward-auth portal lives on this same host under /auth, so its session
		# cookie can be scoped to srr.example.com alone (see §4). It must be reachable
		# without a session, so it comes before the gate.
		@portal path /auth /auth/*
		reverse_proxy @portal 127.0.0.1:9091

		# Browsers fetch the service-worker script WITHOUT cookies, so gating it
		# 302s the registration to the login page and the SW never installs. It is
		# public build output (no store data), so it alone skips the gate.
		@gated not path_regexp swscript ^/sw\.[0-9a-f]{8,}\.js$
		forward_auth @gated 127.0.0.1:9091 {
			uri /auth/api/authz/forward-auth
			copy_headers Remote-User Remote-Groups
		}

		# Backend-only objects the reader never fetches.
		@hidden path /config.gz /.locked /.config.locked /inbox/* /seen/* *.tmp.*
		respond @hidden 404

		@api path /api/* /sync/*
		reverse_proxy @api 127.0.0.1:8088 {
			header_up Host localhost:8088
		}

		# Cache-Control mirroring store.cacheControlForKey. Deferred (`>`) on
		# @immutable so a 404 on a missing/not-yet-published pack (readers fetch
		# packs force-cache, so a bad Cache-Control here sticks) never gets a
		# year-long immutable directive; @mutable's 404s are harmless either way
		# (no-cache is the same instruction a 404 already implies) but deferred
		# too for consistency with @immutable.
		@immutable path_regexp immutable ^/((manifest|idx|data|meta|watch|assets)/.+|[^/]+\.[0-9a-f]{8,}\.[a-z0-9]+)$
		header @immutable >Cache-Control "public, max-age=31536000, immutable"
		@mutable path / /db.gz /index.html /admin.html /manifest.webmanifest /sitemap.txt /out/*
		header @mutable >Cache-Control "no-cache, must-revalidate"
		# The PWA manifest: most mime databases map .webmanifest to nothing (text/plain).
		@webmanifest path *.webmanifest
		header @webmanifest >Content-Type application/manifest+json
		@gz path *.gz
		header @gz >Content-Type application/gzip

		# Feed-supplied files share this origin: never let one act as a page or a script.
		@assets path /assets/* /out/*
		header @assets Content-Security-Policy "sandbox"
		header @assets X-Content-Type-Options nosniff
		# Allowlist, not a denylist: anything under /assets/ whose extension is
		# not a known media/document type is served as an opaque download. A
		# denylist keyed on .js/.mjs alone misses e.g. `assets/ab/x.es` (Ubuntu's
		# /etc/mime.types maps .es to text/javascript, a JS MIME nosniff would
		# not block) and is case-sensitive against `x.JS`.
		@assetother {
			path /assets/*
			not path_regexp (?i)\.(avif|webp|png|jpe?g|gif|svg|ico|bmp|tiff?|heic|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac|pdf|html?|xml|txt|vtt)$
		}
		header @assetother >Content-Type application/octet-stream

		@reader path / /index.html
		header @reader Content-Security-Policy "script-src 'self'; object-src 'none'; base-uri 'none'"
		@admin path /admin.html
		header @admin Content-Security-Policy "default-src 'self'; img-src * data: blob:; media-src * data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

		file_server
	}
}
```

## 4. Authelia

`forward_auth` above expects an Authelia instance (or anything speaking the
same forward-auth protocol) on `127.0.0.1:9091`. For a single-operator
deployment this is deliberately minimal:

- A **file-based user backend** (`authentication_backend.file`) is enough —
  no LDAP, no external IdP, just a users database file with one account.
- A `two_factor` (or `one_factor`, operator's call) **access-control rule**
  scoped to the SRR hostname, e.g. `domain: srr.example.com`.
- **Serve the portal on the SRR host itself, under a path**: Authelia's
  `server.address: tcp://:9091/auth` plus the `@portal` route above, and a
  session cookie with `domain: srr.example.com` and
  `authelia_url: https://srr.example.com/auth`. The common alternative — a
  separate `auth.example.com` with the cookie on the parent `example.com` —
  sends that session cookie to EVERY sibling site under the parent domain, and
  this cookie unlocks an admin API that can run shell commands (recipes). A
  passkey is bound to the portal's hostname, so choose this before enrolling one.
- The **filesystem notifier** (`notifier.filesystem`) is fine for one user —
  it just needs somewhere to write the 2FA/reset emails it would otherwise
  send; wire a real SMTP notifier only if you want those to actually land
  in an inbox.

See Authelia's own documentation for the full configuration reference and
current best practices — this guide only states the shape SRR needs, not a
config to copy verbatim.

## 5. Why these headers

**`.gz` objects must not get `Content-Encoding: gzip`.** Every pack object
(`idx/`, `data/`, `meta/`, `manifest/`, `seen/`, `watch/`, `db.gz`,
`config.gz`) is already a gzip-framed byte stream that the reader's own
`DecompressionStream` path decodes by hand. If the proxy (or Caddy's `encode`
directive) also declares `Content-Encoding: gzip` on top, the BROWSER
transparently inflates the body in transit — that is what `Content-Encoding`
means — and hands the app plain JSON where it expected a gzip stream; the
reader's own `DecompressionStream` step then fails trying to gunzip bytes
that are no longer gzipped. The `@gz` block above pins
`Content-Type: application/gzip` precisely so `encode`'s content
negotiation leaves these paths alone; a `.gz` extension is not itself
enough to guarantee that on every proxy.

**`#selfhost`-fetched assets keep their source extension, so the origin must
not trust it.** `#selfhost` downloads external media into `assets/<hash><ext>`
using the extension of the URL it came from — a feed can point `ext` at
`.js` or `.html` while the actual bytes are whatever the remote server
chose to send. Since these files share the reader's origin, three
independent guards apply: `Content-Security-Policy: sandbox` denies script
execution outright for anything served under `/assets/` or `/out/` (as a
document navigated to directly — it does not gate how some OTHER page's
`<script src>` treats the response, which is what the next two guards are
for), `X-Content-Type-Options: nosniff` stops a browser from MIME-sniffing
its way around a wrong Content-Type, and the `@assetother` block forces
`application/octet-stream` on every `/assets/*` path whose extension is not
on the known media/document allowlist — an allowlist rather than a
`.js`/`.mjs` denylist, because a JS MIME type isn't spelled only `.js`:
measured on caddy:2.11, `assets/ab/x.JS` resolves to `text/javascript` (case)
and `assets/ab/x.es` to `application/ecmascript` (Ubuntu's `/etc/mime.types`
maps `.es` to `text/javascript`), and `#selfhost`'s own extension handling
accepts any 1-5 alphanumeric extension, so nothing upstream constrains it to
a short, known denylist. None of these guards is redundant with the
others — they cover script execution, MIME confusion and content-type-based
script inclusion respectively.

**The admin page and the reader share this origin with the API.** Both
`index.html` and `admin.html` get their own strict CSP (`@reader`/`@admin`
above) matching what each page's own `<meta>` tag already declares — see
`frontend/src/index.html` and the `webUICSP` constant in
`backend/cmd_serve.go` — so the proxy is defense-in-depth on top of what
ships in the bundle, not the only enforcement point. `/api/*` and `/sync/*`
route to `srr serve` with `Host` rewritten to `localhost:8088`: `srr
serve`'s `hostGuard` requires a loopback Host on every request, and a
proxied browser mutation is additionally let through only when the
browser-set `Sec-Fetch-Site: same-origin` header confirms the request
originated from the admin page's own origin (see `backend/cmd_serve.go`).

## 6. CLI from another box

Point the CLI at the store over SFTP from anywhere with network access to
the box:

```bash
srr -o sftp://user@host/srv/srr fetch
```

The `sftp` backend authenticates with SSH keys or an agent, exactly like
plain `ssh`/`scp` — but it does **not** read `~/.ssh/config` host aliases
(`Host box` shortcuts, `ProxyJump`, etc.). Use the real hostname (or IP)
and username in the URL; if you rely on config-file aliases for jump hosts
or non-default ports, resolve them by hand into the URL or into your SSH
client's global settings that the SFTP library does consult (e.g.
`~/.ssh/known_hosts`, key files), not into `-o`'s URL itself.

## 7. Moving an existing S3 store to self-hosted

To migrate an existing S3/R2-backed store to a local self-hosted
directory:

1. **Bulk-copy while the writer keeps running.** Most of a store's bytes
   are immutable, write-once pack objects, so a first pass can safely run
   concurrently with a live fetch loop:
   ```bash
   rclone copy s3remote:mybucket/prefix /srv/srr --progress \
     --exclude '/.locked' --exclude '/.config.locked' --exclude '*.tmp.*'
   ```
2. **Stop the writer** (the `srr serve --interval` process, or whatever
   runs `srr fetch` on a schedule) so nothing commits mid-cutover.
3. **Final copy**, including the mutable/small objects a first pass may
   have raced: `db.gz`, `config.gz`, and `out/*` if syndication is in use.
   ```bash
   rclone copy s3remote:mybucket/prefix /srv/srr --progress \
     --exclude '/.locked' --exclude '/.config.locked' --exclude '*.tmp.*'
   ```
4. **Validate** the copied store before pointing readers or the writer at
   it:
   ```bash
   srr inspect --validate -o /srv/srr
   ```
5. Re-point the writer's `-o`/`--store` (or `stores:` alias) at
   `/srv/srr`, install the reader shell (`srr frontend update -o /srv/srr`
   — see §2), and switch the reverse proxy's `root` to the new directory.
