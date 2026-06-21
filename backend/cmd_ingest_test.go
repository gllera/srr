package main

import (
	"context"
	"testing"
)

func TestIngestCmdSetAndClear(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	if err := (&IngestCmd{Ingest: strPtr("my-fetcher")}).Run(); err != nil {
		t.Fatalf("set: %v", err)
	}
	db, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	if db.core.Ingest != "my-fetcher" {
		t.Errorf("core.Ingest = %q, want %q", db.core.Ingest, "my-fetcher")
	}
	db.Close(context.Background())

	// "" arg → clear; field falls back to built-in "#feed" via ingest.Select.
	if err := (&IngestCmd{Ingest: strPtr("")}).Run(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	db, err = NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB after clear: %v", err)
	}
	defer db.Close(context.Background())
	if db.core.Ingest != "" {
		t.Errorf("core.Ingest after clear = %q, want empty", db.core.Ingest)
	}
}

// No arg → print only, no mutation, no lock acquired.
func TestIngestCmdPrintDoesNotMutate(t *testing.T) {
	dir := t.TempDir()
	globals = &Globals{PackSize: 1, Store: dir}

	if err := (&IngestCmd{Ingest: strPtr("my-fetcher")}).Run(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := (&IngestCmd{Ingest: nil}).Run(); err != nil {
		t.Fatalf("print: %v", err)
	}
	db, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(context.Background())
	if db.core.Ingest != "my-fetcher" {
		t.Errorf("core.Ingest = %q, want preserved %q", db.core.Ingest, "my-fetcher")
	}
}
