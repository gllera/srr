package main

import (
	"context"
	"net/http"
)

func putRecipe(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body struct {
		Ingest  string   `json:"ingest"`
		Pipe    []string `json:"pipe"`
		Secrets []string `json:"secrets"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	mutateStore(w, r, "ok", func(ctx context.Context, db *DB) error {
		return setRecipe(ctx, db, name, body.Ingest, body.Pipe, body.Secrets)
	})
}

func deleteRecipe(w http.ResponseWriter, r *http.Request) {
	mutateStore(w, r, "deleted", func(ctx context.Context, db *DB) error {
		return removeRecipe(ctx, db, r.PathValue("name"))
	})
}
