package main

import (
	"context"
	"net/http"
)

func listSyndicate(w http.ResponseWriter, r *http.Request) {
	// Seed with a non-nil empty slice so an empty store serializes as [] (not
	// null) without a separate guard.
	out := []OutFeed{}
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		out = append(out, db.core.Out...)
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func putSyndicate(w http.ResponseWriter, r *http.Request) {
	var entry OutFeed
	if err := decodeJSON(r, &entry); err != nil {
		writeErr(w, err)
		return
	}
	entry.Name = r.PathValue("name") // the path is the authority for the name
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return setOutFeed(ctx, db, entry)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func deleteSyndicate(w http.ResponseWriter, r *http.Request) {
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return removeOutFeed(ctx, db, r.PathValue("name"))
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
