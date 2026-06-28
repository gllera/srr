package main

import (
	"context"
	"net/http"
)

// buildRecipeMap copies the db.gz recipes map for read-only JSON output. Pure,
// so listRecipes and the overview bundle share it within one withDB scope.
func buildRecipeMap(db *DB) map[string]Recipe {
	recipes := make(map[string]Recipe, len(db.core.Recipes))
	for k, v := range db.core.Recipes {
		recipes[k] = v
	}
	return recipes
}

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
