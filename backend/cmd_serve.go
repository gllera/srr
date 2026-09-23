package main

import (
	"context"
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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type ServeCmd struct {
	Cycle cycleFlags `embed:"" group:"Fetch-cycle flags:"`
	GC    gcFlags    `embed:"" group:"Fetch-cycle flags:"`
	Net   netFlags   `embed:"" group:"Network flags:"`

	Addr     string        `short:"a" default:"localhost:8088" env:"SRR_SERVE_ADDR" help:"Address to listen on (loopback only by default)."`
	Interval time.Duration `help:"Also run a background fetch loop at this interval (e.g. 30m); 0 disables." default:"0" env:"SRR_SERVE_INTERVAL"`
	SyncDir  string        `default:"${syncDir}" env:"SRR_SYNC_DIR" help:"Directory holding the cross-device reader-profile blobs served at /sync/<name> (GET the last-stored profile or 404, PUT to store it). Device state, kept out of the pack store on purpose. Empty disables the endpoint."`

	// feedFilter scopes the background fetch loop to a subset of feeds (same
	// SRR_FETCH_* env/flags as `srr fetch`), copied into the FetchCmd below.
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

	// No ReadHeaderTimeout (G112, Slowloris). Left as-is rather than "fixed"
	// because the value is not obvious and this server is not the usual shape:
	// it binds localhost:8088, its only real client is the cloudflared connector
	// that terminates the public connection and re-originates, and hostGuard
	// already refuses anything whose Host is not loopback. A slow-header attacker
	// therefore needs local access first. Worth revisiting if serve is ever bound
	// to a non-loopback --addr, where the exposure becomes real; whatever value is
	// chosen must bound HEADER reads only, since /api/fetch is a minutes-long SSE
	// stream and OPML import bodies are operator-sized.
	// Resolve the profile-sync store once, before anything can serve a request
	// (serve_sync.go owns the rest). Process-wide like `globals` rather than a
	// newMux parameter, so the handler wiring — and every test that builds a mux
	// — keeps its zero-argument shape.
	syncBlobDir = o.SyncDir

	//nolint:gosec // G112: loopback admin server behind hostGuard; see above
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
	// all-feeds cycle as `srr fetch --interval`, in-process, sharing the
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
		fmt.Printf("SRR API at http://%s  (store: %s, fetching every %s)\n", o.Addr, globals.Store, o.Interval)
	} else {
		fmt.Printf("SRR API at http://%s  (store: %s)\n", o.Addr, globals.Store)
	}

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-done
	loop.Wait()
	return nil
}

// newMux wires the admin API and the profile-sync routes, wrapped in the Host
// guard. serve is API-only: the admin page ships in the frontend bundle
// (admin.html next to the reader) and reaches these routes same-origin through
// the reverse proxy; MCP is `srr mcp` over stdio.
func newMux() http.Handler {
	mux := http.NewServeMux()
	registerAPI(mux)
	// The first-party reader-profile sync blob (RDR18), inside the same
	// hostGuard. Rationale, storage and the deployment note: serve_sync.go.
	registerSync(mux)
	// secHeaders wraps OUTSIDE hostGuard so even a 403 carries the CSP/nosniff/
	// Referrer-Policy/X-Frame-Options headers (SEC3).
	return secHeaders(hostGuard(mux))
}

// webUICSP is a strict static policy stamped on every API response (SEC3) —
// defense in depth, since an API response is JSON/SSE/text and never a
// document meant to run. It no longer guards a page here (serve is API-only;
// the admin page ships as admin.html beside the reader in the frontend
// bundle), but it is kept byte-identical on purpose to the admin page's own
// policy — the meta tag in frontend/src/admin.html and the reverse proxy's
// header (docs/SELF-HOSTING.md) — so this one string documents all three.
// Changing it means changing the other two as well.
const webUICSP = "default-src 'self'; img-src * data: blob:; media-src * data: blob:; " +
	"style-src 'self'; script-src 'self'; object-src 'none'; frame-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// secHeaders stamps the static security headers on every response — the API
// (200 and error) and a hostGuard 403 alike (it wraps outside the guard).
// SEC3: header middleware, strict static CSP, nosniff, Referrer-Policy, plus
// X-Frame-Options as the belt-and-braces clickjacking legacy of
// frame-ancestors 'none'.
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

// writeErrStatus is the JSON error envelope, stated once. writeErr classifies
// an error into a status and comes here; the handlers that already KNOW their
// status (serve_sync's, which distinguish ours-vs-yours failures writeErr
// deliberately cannot) call it directly instead of respelling the shape.
func writeErrStatus(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// mutateStore is the shape every plain mutating endpoint has: run fn in a
// LOCKED store scope on the request's context, answer the classified error, or
// answer {"status": …}. The handlers that return a projection of what they
// wrote (the feed save) keep their own tail; these are the ones whose entire
// body was the ladder.
func mutateStore(w http.ResponseWriter, r *http.Request, status string, fn func(context.Context, *DB) error) {
	if err := withDBCtx(r.Context(), true, fn); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}

// msgLockContention is the operator-facing message when a mutating request can't
// acquire the store lock. Shared with the SSE fetch handler, which can't go
// through writeErr after its 200 headers are sent.
const msgLockContention = "store is locked by another srr process — the fetch loop may be running; try again"

// writeErr maps a handler error to a status: lock contention → 409,
// "not found" → 404, everything else → 400. The message is always echoed.
func writeErr(w http.ResponseWriter, err error) {
	if errors.Is(err, os.ErrExist) {
		writeErrStatus(w, http.StatusConflict, msgLockContention)
		return
	}
	// 404 is decided STRUCTURALLY: the true not-found producers (FeedByID) wrap
	// the stdlib fs.ErrNotExist sentinel, so classification no longer depends on
	// error wording — a validation message that happens to contain "not found"
	// can't silently become a 404, and a renamed message can't stop being one.
	if errors.Is(err, fs.ErrNotExist) {
		writeErrStatus(w, http.StatusNotFound, err.Error())
		return
	}
	// Default 400: handler errors here are overwhelmingly validation rejections
	// (bad recipe/url/format, dangling refs) which downstream tests assert as 400.
	// The rarer store-IO/open failure also surfaces as 400 but always carries its
	// message in the body; without typed errors (repo forbids custom sentinels)
	// validation and infra errors aren't distinguishable at this shared helper.
	writeErrStatus(w, http.StatusBadRequest, err.Error())
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
