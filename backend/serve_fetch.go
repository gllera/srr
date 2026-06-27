package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
)

// handleFetch runs one fetch cycle and streams per-feed progress as SSE. An
// optional ?feed=<id> restricts the cycle to one feed. The triggered fetch holds
// the store lock for its duration (like `srr art fetch`); if another process
// holds it, the stream carries an in-band `event: error` (SSE has already sent
// 200, so contention can't be a 409 here).
func handleFetch(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, fmt.Errorf("streaming unsupported"))
		return
	}
	var filter func(*Feed) bool
	if fid := r.URL.Query().Get("feed"); fid != "" {
		id, err := strconv.Atoi(fid)
		if err != nil {
			writeErr(w, fmt.Errorf("invalid feed id %q", fid))
			return
		}
		filter = func(ch *Feed) bool { return ch.id == id }
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	progress := make(chan feedProgress, 64)
	done := make(chan error, 1)
	go func() {
		client := newFetchClient(globals.Workers)
		err := (&FetchCmd{}).runFetch(r.Context(), client, filter, func(p feedProgress) {
			progress <- p
		})
		// Per-request transport: drop its idle keep-alive sockets now rather than
		// letting them linger ~90s (IdleConnTimeout), so rapid GUI re-triggers
		// don't pile up orphaned connections.
		client.CloseIdleConnections()
		done <- err
		close(progress)
	}()

	for p := range progress {
		writeSSE(w, flusher, "feed", p)
	}
	if err := <-done; err != nil {
		msg := err.Error()
		if errors.Is(err, os.ErrExist) {
			msg = "store is locked by another srr process — the fetch loop may be running; try again"
		}
		writeSSE(w, flusher, "error", map[string]string{"error": msg})
		return
	}
	writeSSE(w, flusher, "done", map[string]string{"status": "ok"})
}

func writeSSE(w http.ResponseWriter, f http.Flusher, event string, v any) {
	data, _ := json.Marshal(v)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
	f.Flush()
}
