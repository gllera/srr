package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
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
}

func (o *ServeCmd) Run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

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
			(&FetchCmd{Interval: o.Interval}).fetchLoop(ctx, client) //nolint:errcheck // always nil when Interval > 0
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
	mux.Handle("GET /", http.FileServerFS(minifiedWebUI()))
	return hostGuard(mux)
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
func hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			http.Error(w, "forbidden: non-loopback Host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
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
	// Default 400: handler errors here are overwhelmingly validation rejections
	// (bad recipe/url/format, dangling refs) which downstream tests assert as 400.
	// The rarer store-IO/open failure also surfaces as 400 but always carries its
	// message in the body; without typed errors (repo forbids custom sentinels)
	// validation and infra errors aren't distinguishable at this shared helper.
	status := http.StatusBadRequest
	if strings.Contains(err.Error(), "not found") {
		status = http.StatusNotFound
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func decodeJSON(r *http.Request, v any) error {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
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
	mux.HandleFunc("GET /api/export", handleExport)
	mux.HandleFunc("POST /api/import", handleImport)
	mux.HandleFunc("PUT /api/syndicate/{name}", putSyndicate)
	mux.HandleFunc("DELETE /api/syndicate/{name}", deleteSyndicate)
	mux.HandleFunc("POST /api/fetch", handleFetch)
	mux.HandleFunc("GET /api/inspect", handleInspect)
}
