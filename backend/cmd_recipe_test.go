package main

import (
	"context"
	"slices"
	"testing"
)

// recipeSet runs `srr recipe set` against the test store.
func recipeSet(t *testing.T, name, ingest string, pipe ...string) error {
	t.Helper()
	cmd := &RecipeSetCmd{Name: name, Ingest: ingest, Pipe: pipe}
	return cmd.Run()
}

func TestRecipeSetUpsertAndShow(t *testing.T) {
	setupEmptyDB(t) // points globals.Store at a temp dir
	// #default is the composition token; recipes other than default may use it.
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
	setupEmptyDB(t)
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
	setupEmptyDB(t)
	if err := (&RecipeRmCmd{Name: defaultRecipeName}).Run(); err == nil {
		t.Error("recipe rm default accepted, want error")
	}
}

func TestRecipeRmRemoves(t *testing.T) {
	setupEmptyDB(t)
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

func TestRecipeSetDefaultRejectsDefaultToken(t *testing.T) {
	setupEmptyDB(t)
	// #default is forbidden inside the default recipe (it IS the default).
	if err := recipeSet(t, defaultRecipeName, "", "#default", "#minify"); err == nil {
		t.Error("recipe set default with #default accepted, want error")
	}
	// but allowed in any other recipe
	if err := recipeSet(t, "x", "", "#default"); err != nil {
		t.Errorf("recipe set x with #default rejected: %v", err)
	}
}

func TestRecipeRmRefusesReferenced(t *testing.T) {
	setupEmptyDB(t)
	_ = recipeSet(t, "read", "", "#readability", "#default")
	_ = withDB(true, func(ctx context.Context, db *DB) error {
		if err := db.AddFeed(&Feed{Title: "T", URL: "http://example.com/rss", Recipe: "read"}); err != nil {
			return err
		}
		return db.Commit(ctx)
	})
	if err := (&RecipeRmCmd{Name: "read"}).Run(); err == nil {
		t.Error("recipe rm of a referenced recipe accepted, want error listing feed ids")
	}
}
