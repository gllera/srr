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
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed webui
var webuiFS embed.FS

type ServeCmd struct {
	Addr string `short:"a" default:"localhost:8088" env:"SRR_SERVE_ADDR" help:"Address to listen on (loopback only by default)."`
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

	fmt.Printf("SRR admin GUI at http://%s  (store: %s)\n", o.Addr, globals.Store)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-done
	return nil
}

// newMux wires the API routes and the embedded UI, wrapped in the Host guard.
func newMux() http.Handler {
	mux := http.NewServeMux()
	registerAPI(mux)
	sub, err := fs.Sub(webuiFS, "webui")
	if err != nil {
		panic(err) // embed is compile-time; a failure here is a build bug
	}
	mux.Handle("GET /", http.FileServerFS(sub))
	return hostGuard(mux)
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

// writeErr maps a handler error to a status: lock contention → 409,
// "not found" → 404, everything else → 400. The message is always echoed.
func writeErr(w http.ResponseWriter, err error) {
	if errors.Is(err, os.ErrExist) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "store is locked by another srr process — the fetch loop may be running; try again",
		})
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
	mux.HandleFunc("GET /api/feeds", listFeeds)
	mux.HandleFunc("POST /api/feeds", createFeed)
	mux.HandleFunc("POST /api/feeds/apply", applyFeedsHandler)
	mux.HandleFunc("GET /api/feeds/{id}", getFeed)
	mux.HandleFunc("PUT /api/feeds/{id}", updateFeed)
	mux.HandleFunc("DELETE /api/feeds/{id}", deleteFeed)
	mux.HandleFunc("GET /api/tags", listTags)
	mux.HandleFunc("GET /api/recipes", listRecipes)
	mux.HandleFunc("PUT /api/recipes/{name}", putRecipe)
	mux.HandleFunc("DELETE /api/recipes/{name}", deleteRecipe)
	mux.HandleFunc("GET /api/preview", handlePreview)
	mux.HandleFunc("GET /api/gen", getGen)
	mux.HandleFunc("POST /api/gen/bump", bumpGen)
	mux.HandleFunc("GET /api/export", handleExport)
	mux.HandleFunc("POST /api/import", handleImport)
	mux.HandleFunc("GET /api/syndicate", listSyndicate)
	mux.HandleFunc("PUT /api/syndicate/{name}", putSyndicate)
	mux.HandleFunc("DELETE /api/syndicate/{name}", deleteSyndicate)
	mux.HandleFunc("POST /api/fetch", handleFetch)
	mux.HandleFunc("GET /api/inspect", handleInspect)
}
