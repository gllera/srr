package main

import (
	"context"
	"slices"
	"testing"
)

// setupRecipeTestStore points globals.Store at a fresh temp dir, mirroring the
// inline setup used by cmd_pipe_test.go tests.
func setupRecipeTestStore(t *testing.T) {
	t.Helper()
	globals = &Globals{PackSize: 1, Store: t.TempDir()}
}

// recipeSet runs `srr recipe set` against the test store.
func recipeSet(t *testing.T, name, ingest string, pipe ...string) error {
	t.Helper()
	cmd := &RecipeSetCmd{Name: name, Ingest: ingest, Pipe: pipe}
	return cmd.Run()
}

func TestRecipeSetUpsertAndShow(t *testing.T) {
	setupRecipeTestStore(t) // points globals.Store at a temp dir (see cmd_pipe_test.go)
	// builtin-only pipe: the #default composition token is not special until a later task.
	if err := recipeSet(t, "read", "", "#readability", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	err := withDB(false, func(_ context.Context, db *DB) error {
		r := db.core.Recipes["read"]
		if !slices.Equal(r.Pipe, []string{"#readability", "#sanitize"}) {
			t.Errorf("read pipe = %v", r.Pipe)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRecipeSetClearIngest(t *testing.T) {
	setupRecipeTestStore(t)
	_ = recipeSet(t, "tg", "srr-telegram", "#sanitize")
	if err := recipeSet(t, "tg", "", "#sanitize"); err != nil { // -i "" clears
		t.Fatalf("recipe set clear ingest: %v", err)
	}
	_ = withDB(false, func(_ context.Context, db *DB) error {
		if db.core.Recipes["tg"].Ingest != "" {
			t.Errorf("tg ingest = %q, want empty", db.core.Recipes["tg"].Ingest)
		}
		return nil
	})
}

func TestRecipeRmRefusesDefault(t *testing.T) {
	setupRecipeTestStore(t)
	if err := (&RecipeRmCmd{Name: defaultRecipeName}).Run(); err == nil {
		t.Error("recipe rm default accepted, want error")
	}
}

func TestRecipeRmRemoves(t *testing.T) {
	setupRecipeTestStore(t)
	if err := recipeSet(t, "gone", "", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	if err := (&RecipeRmCmd{Name: "gone"}).Run(); err != nil {
		t.Fatalf("recipe rm: %v", err)
	}
	_ = withDB(false, func(_ context.Context, db *DB) error {
		if _, ok := db.core.Recipes["gone"]; ok {
			t.Error("recipe \"gone\" still present after rm")
		}
		return nil
	})
}
