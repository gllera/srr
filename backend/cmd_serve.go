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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing/fstest"
	"time"

	"github.com/tdewolff/minify"
	"github.com/tdewolff/minify/css"
	"github.com/tdewolff/minify/html"
	"github.com/tdewolff/minify/js"
)

//go:embed webui
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
	ui := minifiedWebUI()
	mux.Handle("GET /", webUICacheHeaders(ui, http.FileServerFS(ui)))
	return hostGuard(mux)
}

// webUICacheHeaders gives the embedded admin UI cache VALIDATORS it otherwise
// has none of: the assets are served from an fstest.MapFS whose entries have a
// zero ModTime, so net/http emits no Last-Modified and no ETag, while the names
// are static (app.js) — a caching layer in front of the GUI therefore has
// nothing to revalidate against and serves the previous release's bytes after
// every update. (That is the trap already worked around with a Cloudflare
// cache-bypass rule for admin-srr.llera.eu; this fixes the cause, and the rule
// can stay as belt-and-braces.)
//
// A content ETag per file, computed once at startup, plus no-cache: the client
// keeps the bytes but must revalidate, and an unchanged file answers 304.
func webUICacheHeaders(fsys fs.FS, next http.Handler) http.Handler {
	etags := map[string]string{}
	_ = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // a missing UI file is a build bug, not a request-time error
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
		if tag, ok := etags[p]; ok {
			w.Header().Set("ETag", tag)
			w.Header().Set("Cache-Control", "no-cache")
			// Compare against every candidate in If-None-Match; the GUI is served
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

// minifiedWebUI minifies the embedded webui assets once at startup and serves
// them from an in-memory FS. It reuses the tdewolff/minify the #minify mod
// already vendors, so the build stays pure-Go with no JS toolchain. Embed reads
// cannot fail at runtime, so a failure here is a build bug.
func minifiedWebUI() fs.FS {
	sub, err := fs.Sub(webuiFS, "webui")
	if err != nil {
		panic(err) // embed is compile-time; a failure here is a build bug
	}
	m := minify.New()
	m.AddFunc("text/css", css.Minify)
	m.AddFunc("text/html", html.Minify)
	m.AddFunc("application/javascript", js.Minify)
	mediaType := map[string]string{
		".css":  "text/css",
		".html": "text/html",
		".js":   "application/javascript",
	}
	out := fstest.MapFS{}
	err = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return walkErr
		}
		b, err := fs.ReadFile(sub, p)
		if err != nil {
			return err
		}
		if mt, ok := mediaType[path.Ext(p)]; ok {
			if mb, err := m.Bytes(mt, b); err == nil {
				b = mb // fall back to the original bytes if minify chokes
			}
		}
		out[p] = &fstest.MapFile{Data: b}
		return nil
	})
	if err != nil {
		panic(err) // reading the embedded FS cannot fail at runtime
	}
	return out
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
	mux.HandleFunc("POST /api/gen/bump", bumpGen)
	mux.HandleFunc("PUT /api/dedup", handleDedup)
	mux.HandleFunc("GET /api/export", handleExport)
	mux.HandleFunc("POST /api/import", handleImport)
	mux.HandleFunc("PUT /api/syndicate/{name}", putSyndicate)
	mux.HandleFunc("DELETE /api/syndicate/{name}", deleteSyndicate)
	mux.HandleFunc("POST /api/fetch", handleFetch)
	mux.HandleFunc("GET /api/inspect", handleInspect)
}
