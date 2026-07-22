package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// webui/dist is the Parcel-built admin console (a separate `parcel build` into
// its own dist dir — see the frontend project). It is generated and gitignored
// except for a committed placeholder index.html, so a bare `go build`/`go vet`/
// `go test` still compiles without Node; `all:` embeds Parcel's hashed asset
// names as-is. The sources are no longer hand-written and no longer minified at
// startup (Parcel minifies): `minifiedWebUI` + the tdewolff/minify pass are gone.
//
//go:embed all:webui/dist
var webuiFS embed.FS

type ServeCmd struct {
	Addr     string        `short:"a" default:"localhost:8088" env:"SRR_SERVE_ADDR" help:"Address to listen on (loopback only by default)."`
	Interval time.Duration `help:"Also run a background fetch loop at this interval (e.g. 30m); 0 disables." default:"0" env:"SRR_SERVE_INTERVAL"`

	// feedFilter scopes the background fetch loop to a subset of feeds (same
	// SRR_FETCH_* env/flags as `srr art fetch`), copied into the FetchCmd below.
	feedFilter
}

func (o *ServeCmd) Run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// --force disables the .locked exclusive-create, which is the mutual exclusion
	// the 409 contract relies on. In a long-lived serve process it lets the
	// --interval fetch cycle and concurrent GUI mutations commit db.gz/packs at
	// once (lost writes / torn state) — safe for a one-shot CLI op, a footgun here.
	if globals.Force {
		slog.Warn("serve started with --force: the store lock is disabled, so the fetch loop and GUI mutations are no longer mutually exclusive")
	}

	srv := &http.Server{Addr: o.Addr, Handler: newMux()}
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		sctx, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = srv.Shutdown(sctx)
	}()

	// Optional background fetch loop: when --interval is set, serve runs the same
	// all-feeds cycle as `srr art fetch --interval`, in-process, sharing the
	// server's signal context so one Ctrl-C/SIGTERM stops both. A running cycle
	// holds the store lock for its duration, so a concurrent GUI mutation gets a
	// 409 (msgLockContention) — the same contract as a separate fetch process.
	var loop sync.WaitGroup
	if o.Interval > 0 {
		client := newFetchClient(globals.Workers)
		loop.Go(func() {
			defer client.CloseIdleConnections()
			(&FetchCmd{Interval: o.Interval, feedFilter: o.feedFilter}).fetchLoop(ctx, client) //nolint:errcheck // always nil when Interval > 0
		})
		fmt.Printf("SRR admin GUI at http://%s  (store: %s, fetching every %s)\n", o.Addr, globals.Store, o.Interval)
	} else {
		fmt.Printf("SRR admin GUI at http://%s  (store: %s)\n", o.Addr, globals.Store)
	}

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-done
	loop.Wait()
	return nil
}

// newMux wires the API routes and the embedded UI, wrapped in the Host guard.
func newMux() http.Handler {
	mux := http.NewServeMux()
	registerAPI(mux)
	// The MCP endpoint. Streamable HTTP uses three methods on the one path —
	// POST (requests), GET (a server→client stream) and DELETE (session
	// teardown) — so all three are registered; anything else on /mcp gets the
	// mux's own 405, matching what the SDK handler would answer.
	//
	// They are registered method-BY-method rather than as a bare "/mcp" because
	// Go 1.22+ ServeMux treats a bare "/mcp" and the "GET /" wildcard below as
	// CONFLICTING (neither is more specific in both dimensions: "/mcp" has the
	// more specific path, "GET /" the more specific method) and PANICS at
	// registration. With the method stated, "GET /mcp" beats "GET /" on path
	// specificity and the POST/DELETE patterns overlap nothing, so the admin
	// UI's file server never sees an MCP request.
	//
	// The endpoint stays inside hostGuard: a non-browser MCP client sends no
	// Origin (so only the unconditional loopback-Host check applies, which the
	// tunnel's httpHostHeader rewrite satisfies), and /mcp exposes a strict
	// subset of what /api/* already offers the same caller.
	mcpHandler := mcpHTTPHandler()
	for _, m := range []string{http.MethodPost, http.MethodGet, http.MethodDelete} {
		mux.Handle(m+" /mcp", mcpHandler)
	}
	// The static file server stays (this is NOT "serve becomes API-only"): it now
	// serves the Parcel-built bundle embedded above instead of hand-written
	// sources. "GET /mcp" still beats this "GET /" wildcard on path specificity.
	ui := embeddedWebUI()
	mux.Handle("GET /", webUICacheHeaders(ui, http.FileServerFS(ui)))
	// secHeaders wraps OUTSIDE hostGuard so even a 403 carries the CSP/nosniff/
	// Referrer-Policy/X-Frame-Options headers (SEC3).
	return secHeaders(hostGuard(mux))
}

// embeddedWebUI exposes the Parcel dist as the file server's root FS. Embed
// reads cannot fail at runtime, so a failure here is a build bug.
func embeddedWebUI() fs.FS {
	sub, err := fs.Sub(webuiFS, "webui/dist")
	if err != nil {
		panic(err) // embed is compile-time; a failure here is a build bug
	}
	return sub
}

// webUICSP is the admin console's Content-Security-Policy (SEC3). The bundle is
// generated, so it has no inline scripts/styles to grandfather — script-src and
// style-src stay 'self'. img-src/media-src CANNOT be 'self': the preview dialog
// renders real article HTML in a sandbox="" srcdoc iframe, and a srcdoc document
// inherits the embedder's CSP, so a strict img-src would blank every preview —
// the empty sandbox (no allow-scripts) is what stops execution, CSP is the
// backstop. frame-src 'self' covers srcdoc. This is the console's OWN policy;
// the reader keeps its different one (frontend/_headers + its index.html meta).
const webUICSP = "default-src 'self'; img-src * data: blob:; media-src * data: blob:; " +
	"style-src 'self'; script-src 'self'; object-src 'none'; frame-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// secHeaders stamps the static security headers on every response — the API
// (200 and error), the served bundle, and a hostGuard 403 alike (it wraps
// outside the guard). SEC3: header middleware, strict static CSP, nosniff,
// Referrer-Policy, plus X-Frame-Options as the belt-and-braces clickjacking
// legacy of frame-ancestors 'none'.
func secHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", webUICSP)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// webUIHashedRe matches a Parcel content-hashed asset name (frontend.<hash>.js,
// styles.<hash>.css, …): a slash-free basename of <stem>.<8+ hex>.<ext>. The
// name changes whenever the bytes do, so such a file is safe to cache forever.
// Mirrors store.feHashedRe (the frontend-shell classifier).
var webUIHashedRe = regexp.MustCompile(`^[^/]+\.[0-9a-f]{8,}\.[a-z0-9]+$`)

// webUICacheHeaders gives the embedded admin UI the right Cache-Control for a
// content-hashed Parcel bundle, mirroring store.cacheControlForKey:
//
//   - a hashed asset name (frontend.<hash>.js) → immutable, cached for a year
//     with no revalidation (the hash IS the version);
//   - index.html and any other unhashed root file → no-cache + a startup-computed
//     content ETag, so a caching layer keeps the bytes but must revalidate and an
//     unchanged file answers 304.
//
// This structurally fixes the trap the old MapFS scheme worked around (zero
// ModTime ⇒ no validators ⇒ a static app.js name went stale after every release,
// the reason for the admin-srr.llera.eu cache-bypass rule): Parcel hashes the
// asset names, so only the small mutable HTML shell needs a validator now.
func webUICacheHeaders(fsys fs.FS, next http.Handler) http.Handler {
	etags := map[string]string{}
	_ = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // a missing UI file is a build bug, not a request-time error
		}
		if webUIHashedRe.MatchString(path.Base(p)) {
			return nil // hashed assets are immutable — no validator needed
		}
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			return nil
		}
		etags["/"+p] = fmt.Sprintf(`"%x"`, sha256.Sum256(b))
		return nil
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/" {
			p = "/index.html" // what FileServerFS will serve for the directory
		}
		if webUIHashedRe.MatchString(path.Base(p)) {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			next.ServeHTTP(w, r)
			return
		}
		if tag, ok := etags[p]; ok {
			w.Header().Set("ETag", tag)
			w.Header().Set("Cache-Control", "no-cache")
			// Compare against every candidate in If-None-Match; the shell is served
			// as-is (no transforms), so a strong-tag equality check is enough.
			for _, cand := range strings.Split(r.Header.Get("If-None-Match"), ",") {
				if strings.TrimSpace(cand) == tag {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// hostGuard rejects requests whose Host (or cross-origin Origin) is not a
// loopback address — anti-CSRF/DNS-rebinding hardening for the mutating API.
// A GUI fronted by a Host-rewriting proxy (cloudflared tunnel + httpHostHeader)
// passes the Host check but its browser mutations carry the outer, non-loopback
// Origin; those are allowed only when the browser-set (unforgeable) fetch
// metadata asserts the request initiator shares that outer origin. The Host
// check stays unconditional: a DNS-rebinding page is same-origin to the browser
// but cannot present a loopback Host.
func hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			http.Error(w, "forbidden: non-loopback Host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && r.Header.Get("Sec-Fetch-Site") != "same-origin" {
			u, err := url.Parse(origin)
			if err != nil || !loopbackHost(u.Host) {
				http.Error(w, "forbidden: cross-origin request", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func loopbackHost(host string) bool {
	h := host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		h = hh
	}
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// --- shared JSON/HTTP helpers ----------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// msgLockContention is the operator-facing message when a mutating request can't
// acquire the store lock. Shared with the SSE fetch handler, which can't go
// through writeErr after its 200 headers are sent.
const msgLockContention = "store is locked by another srr process — the fetch loop may be running; try again"

// writeErr maps a handler error to a status: lock contention → 409,
// "not found" → 404, everything else → 400. The message is always echoed.
func writeErr(w http.ResponseWriter, err error) {
	if errors.Is(err, os.ErrExist) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": msgLockContention})
		return
	}
	// 404 is decided STRUCTURALLY: the true not-found producers (FeedByID) wrap
	// the stdlib fs.ErrNotExist sentinel, so classification no longer depends on
	// error wording — a validation message that happens to contain "not found"
	// can't silently become a 404, and a renamed message can't stop being one.
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	// Default 400: handler errors here are overwhelmingly validation rejections
	// (bad recipe/url/format, dangling refs) which downstream tests assert as 400.
	// The rarer store-IO/open failure also surfaces as 400 but always carries its
	// message in the body; without typed errors (repo forbids custom sentinels)
	// validation and infra errors aren't distinguishable at this shared helper.
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
}

// maxRequestBody caps every admin-API request body. The GUI is loopback/
// Access-gated, but an unbounded io.ReadAll / json.Decode still lets a single
// large body balloon memory — 8 MiB is far above any real feed-config or OPML
// payload.
const maxRequestBody = 8 << 20

func decodeJSON(r *http.Request, v any) error {
	if err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxRequestBody)).Decode(v); err != nil {
		return fmt.Errorf("decode request body: %w", err)
	}
	return nil
}

func pathID(r *http.Request) (int, error) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		return 0, fmt.Errorf("invalid feed id %q: %w", r.PathValue("id"), err)
	}
	return id, nil
}

// registerAPI is grown across phases. Routes are added by their tasks.
func registerAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/overview", getOverview)
	mux.HandleFunc("POST /api/feeds", createFeed)
	mux.HandleFunc("POST /api/feeds/apply", applyFeedsHandler)
	mux.HandleFunc("PUT /api/feeds/{id}", updateFeed)
	mux.HandleFunc("DELETE /api/feeds/{id}", deleteFeed)
	mux.HandleFunc("PUT /api/recipes/{name}", putRecipe)
	mux.HandleFunc("DELETE /api/recipes/{name}", deleteRecipe)
	mux.HandleFunc("GET /api/preview", handlePreview)
	mux.HandleFunc("GET /api/resolve", handleResolve)
	mux.HandleFunc("PUT /api/dedup", handleDedup)
	mux.HandleFunc("GET /api/export", handleExport)
	mux.HandleFunc("POST /api/import", handleImport)
	mux.HandleFunc("PUT /api/syndicate/{name}", putSyndicate)
	mux.HandleFunc("DELETE /api/syndicate/{name}", deleteSyndicate)
	mux.HandleFunc("POST /api/fetch", handleFetch)
	mux.HandleFunc("GET /api/inspect", handleInspect)
}
