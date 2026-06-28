package main

import (
	"context"
	"net/http"
)

func putRecipe(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body struct {
		Ingest string   `json:"ingest"`
		Pipe   []string `json:"pipe"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return setRecipe(ctx, db, name, body.Ingest, body.Pipe)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func deleteRecipe(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return removeRecipe(ctx, db, name)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
