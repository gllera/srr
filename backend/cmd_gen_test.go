package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenPrintsZeroOnFreshDB(t *testing.T) {
	setupEmptyDB(t)
	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&GenCmd{}).Run(); err != nil {
		t.Fatalf("print: %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != "0" {
		t.Errorf("output = %q, want %q", got, "0")
	}
}

func TestGenBumpIncrementsAndPersists(t *testing.T) {
	setupEmptyDB(t)

	if err := (&GenCmd{Bump: true}).Run(); err != nil {
		t.Fatalf("bump: %v", err)
	}
	db := reopenDB(t)
	if db.core.Gen != 1 {
		t.Errorf("core.Gen = %d, want 1", db.core.Gen)
	}
	db.Close(ctx)

	if err := (&GenCmd{Bump: true}).Run(); err != nil {
		t.Fatalf("second bump: %v", err)
	}
	db = reopenDB(t)
	if db.core.Gen != 2 {
		t.Errorf("core.Gen = %d, want 2", db.core.Gen)
	}
}

// No --bump → print only, no mutation, no lock acquired.
func TestGenPrintDoesNotMutate(t *testing.T) {
	setupEmptyDB(t)
	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&GenCmd{Bump: true}).Run(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := (&GenCmd{}).Run(); err != nil {
		t.Fatalf("print: %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != "1" {
		t.Errorf("output = %q, want %q", got, "1")
	}
	db := reopenDB(t)
	if db.core.Gen != 1 {
		t.Errorf("core.Gen = %d, want preserved 1", db.core.Gen)
	}
}

// --bump resets hdrs: an in-place rebuild invalidates the summary's copied
// headers, so the next fetch must rebuild idx/h<N>.gz.
func TestGenBumpResetsHdrPacks(t *testing.T) {
	setupEmptyDB(t)

	db := reopenDB(t)
	db.core.HdrPacks = 3
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	db.Close(ctx)

	if err := (&GenCmd{Bump: true}).Run(); err != nil {
		t.Fatalf("bump: %v", err)
	}
	db = reopenDB(t)
	if db.core.HdrPacks != 0 {
		t.Errorf("core.HdrPacks = %d, want 0 after bump", db.core.HdrPacks)
	}
}

// gen is omitempty: absent from db.gz at 0 (the reader treats absent as 0),
// present once bumped.
func TestGenOmitemptyWhenZero(t *testing.T) {
	setupEmptyDB(t)

	db := reopenDB(t)
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	db.Close(ctx)
	raw := decompressGz(t, filepath.Join(globals.Store, "db.gz"))
	if strings.Contains(string(raw), `"gen"`) {
		t.Errorf("fresh db.gz contains %q, want omitted: %s", "gen", raw)
	}

	if err := (&GenCmd{Bump: true}).Run(); err != nil {
		t.Fatalf("bump: %v", err)
	}
	raw = decompressGz(t, filepath.Join(globals.Store, "db.gz"))
	if !strings.Contains(string(raw), `"gen":1`) {
		t.Errorf("bumped db.gz missing %q: %s", `"gen":1`, raw)
	}
}
