package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"srr/store"
)

// commitOneGeneration lands a first generation so the store has a root for the
// next handle to condition its flip on.
func commitOneGeneration(t *testing.T) {
	t.Helper()
	db, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)
	if err := db.AddFeed(&Feed{Title: "f", URL: "https://example.com/f"}); err != nil {
		t.Fatal(err)
	}
	db.core.FetchedAt = 1_700_000_000
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
}

// The root flip is a compare-and-swap: a peer that advanced the root while this
// cycle ran makes the flip FAIL rather than silently publish over their
// generation. Without it the loser's write is a last-write-wins that adopts the
// winner's manifest as its own — the one hole the exclusive-create manifest
// publish cannot close (see DB.flipRoot).
func TestCommitRefusesRootFlipAfterAPeerAdvancedIt(t *testing.T) {
	setupTestDB(t)
	commitOneGeneration(t)

	db, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)
	if !db.rootVersioned {
		t.Fatal("the local backend must be able to version the root")
	}
	db.core.FetchedAt = 1_700_000_100

	// A peer writes a newer root under us, exactly as a second writer past a
	// stolen or --force'd lock would.
	peer, err := gzipJSON(RootState{Version: dbFormatVersion, ManifestNum: 99, FetchedAt: 1_700_000_050})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AtomicPut(ctx, dbFileKey, bytes.NewReader(peer), store.ObjectMeta{}); err != nil {
		t.Fatal(err)
	}

	if err := db.Commit(ctx); !errors.Is(err, store.ErrPreconditionFailed) {
		t.Fatalf("Commit over a peer-advanced root = %v, want store.ErrPreconditionFailed", err)
	}
	// The peer's generation must still be the one the store points at.
	core, err := loadStore(func(key string) ([]byte, error) { return db.readGz(ctx, key) })
	if err == nil && core.ManifestNum != 99 {
		t.Errorf("the refused flip still moved the root to m=%d", core.ManifestNum)
	}
}

// A store the backend cannot version (plain HTTP) keeps the unconditional flip
// it always had — the CAS is an upgrade where the primitive exists, never a new
// requirement.
type unversionedBackend struct{ store.Backend }

func (unversionedBackend) Version(context.Context, string) (string, error) {
	return "", errors.ErrUnsupported
}

func (unversionedBackend) PutIfVersion(context.Context, string, io.Reader, store.ObjectMeta, string) (string, error) {
	return "", errors.ErrUnsupported
}

func TestCommitFallsBackWhenTheBackendCannotVersion(t *testing.T) {
	setupTestDB(t)
	commitOneGeneration(t)

	db, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)
	db.Backend = unversionedBackend{Backend: db.Backend}
	db.core.FetchedAt = 1_700_000_100

	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit on a backend without conditional writes: %v", err)
	}
	core, err := loadStore(func(key string) ([]byte, error) { return db.readGz(ctx, key) })
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if core.FetchedAt != 1_700_000_100 {
		t.Errorf("the fallback flip did not land: fetched_at = %d", core.FetchedAt)
	}
}

// Two commits on ONE handle must both land: the conditional write returns the
// new token, so the handle stays in step with the store without a re-read.
func TestCommitTwiceOnOneHandle(t *testing.T) {
	setupTestDB(t)
	commitOneGeneration(t)

	db, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)

	for _, at := range []int64{1_700_000_100, 1_700_000_200} {
		db.core.FetchedAt = at
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("Commit at %d: %v", at, err)
		}
	}
	core, err := loadStore(func(key string) ([]byte, error) { return db.readGz(ctx, key) })
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if core.FetchedAt != 1_700_000_200 {
		t.Errorf("second commit did not land: fetched_at = %d", core.FetchedAt)
	}
}
