package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func healSourceFile(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "new-bytes.mp4")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

// heal replaces an existing asset object's bytes in place — the operator
// repair path for a published-broken asset (immutable articles reference the
// key forever, so the key must keep its name).
func TestHealAssetOverwritesExisting(t *testing.T) {
	be := &metaCaptureBackend{Backend: tempStore(t)}
	const key = "assets/5a/5ab110f6bbe86ae8.mp4"
	if err := be.Put(context.Background(), key, strings.NewReader("BROKEN"), true); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := healAsset(context.Background(), be, key, healSourceFile(t, "FIXED"), "", false, false); err != nil {
		t.Fatalf("healAsset: %v", err)
	}
	if got := string(readKey(t, be, key)); got != "FIXED" {
		t.Errorf("stored body = %q, want FIXED", got)
	}
	if be.gotMeta.ContentType != "video/mp4" {
		t.Errorf("ContentType = %q, want video/mp4 (derived from key extension)", be.gotMeta.ContentType)
	}
}

// An explicit --content-type wins over the extension derivation.
func TestHealAssetContentTypeOverride(t *testing.T) {
	be := &metaCaptureBackend{Backend: tempStore(t)}
	const key = "assets/5a/5ab110f6bbe86ae8.mp4"
	if err := be.Put(context.Background(), key, strings.NewReader("BROKEN"), true); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := healAsset(context.Background(), be, key, healSourceFile(t, "FIXED"), "video/webm", false, false); err != nil {
		t.Fatalf("healAsset: %v", err)
	}
	if be.gotMeta.ContentType != "video/webm" {
		t.Errorf("ContentType = %q, want the explicit video/webm", be.gotMeta.ContentType)
	}
}

// Healing a key that does not exist is a typo, not a repair — refuse rather
// than create an orphan object nothing references.
func TestHealAssetMissingKeyRefused(t *testing.T) {
	be := tempStore(t)
	err := healAsset(context.Background(), be, "assets/ab/0123456789abcdef.mp4", healSourceFile(t, "FIXED"), "", false, false)
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("err = %v, want missing-key refusal", err)
	}
}

// Only well-formed assets/ keys are heal-able — anything else risks
// clobbering packs or db.gz.
func TestHealAssetRejectsNonAssetKey(t *testing.T) {
	be := tempStore(t)
	for _, key := range []string{"db.gz", "data/1.gz", "assets/../db.gz", "assets/zz/nothex.mp4"} {
		if err := healAsset(context.Background(), be, key, healSourceFile(t, "X"), "", true, false); err == nil {
			t.Errorf("key %q accepted, want rejection", key)
		}
	}
}

// A zero-byte source is refused: heal must never republish an empty object over
// a (possibly still-serviceable) existing one. The stored bytes stay untouched
// and AtomicPut is never reached.
func TestHealAssetRejectsZeroByteSource(t *testing.T) {
	be := &metaCaptureBackend{Backend: tempStore(t)}
	const key = "assets/5a/5ab110f6bbe86ae8.mp4"
	if err := be.Put(context.Background(), key, strings.NewReader("ORIGINAL"), true); err != nil {
		t.Fatalf("seed: %v", err)
	}

	err := healAsset(context.Background(), be, key, healSourceFile(t, ""), "", false, false)
	if err == nil || !strings.Contains(err.Error(), "zero-byte") {
		t.Fatalf("err = %v, want a zero-byte refusal", err)
	}
	if got := string(readKey(t, be, key)); got != "ORIGINAL" {
		t.Errorf("stored body = %q, want unchanged ORIGINAL", got)
	}
	if be.gotKey != "" {
		t.Errorf("AtomicPut ran (gotKey=%q); a zero-byte heal must not publish", be.gotKey)
	}
}

// --create re-creates a referenced-but-deleted key (e.g. an operator removed a
// broken object before the repair): the explicit flag keeps the default
// typo-guard while allowing the legitimate case.
func TestHealAssetCreateFlagAllowsMissingKey(t *testing.T) {
	be := &metaCaptureBackend{Backend: tempStore(t)}
	const key = "assets/ab/0123456789abcdef.mp4"
	if err := healAsset(context.Background(), be, key, healSourceFile(t, "FIXED"), "", true, false); err != nil {
		t.Fatalf("healAsset --create: %v", err)
	}
	if got := string(readKey(t, be, key)); got != "FIXED" {
		t.Errorf("stored body = %q, want FIXED", got)
	}
}

// --dry-run must report the write and touch nothing. The old/new sizes are the
// point: a size-changing heal skews the owning feed's AssetBytes counter, so an
// operator has to be able to see the delta before committing to it.
func TestAssetHealDryRunWritesNothing(t *testing.T) {
	be := tempStore(t)
	const key = "assets/5a/5ab110f6bbe86ae8.mp4"
	if err := be.Put(context.Background(), key, strings.NewReader("BROKEN"), true); err != nil {
		t.Fatalf("seed: %v", err)
	}

	out := captureCmdStdout(t)
	if err := healAsset(context.Background(), be, key, healSourceFile(t, "FIXEDBYTES"), "", false, true); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	body := out.String()
	for _, want := range []string{key, "exists: true", "6 -> 10", "dry run"} {
		if !strings.Contains(body, want) {
			t.Errorf("dry-run report missing %q:\n%s", want, body)
		}
	}
	if got := string(readKey(t, be, key)); got != "BROKEN" {
		t.Errorf("dry run overwrote the object: %q, want the original BROKEN", got)
	}
}

// The --create dry run must say so, and still write nothing.
func TestAssetHealDryRunCreate(t *testing.T) {
	be := tempStore(t)
	out := captureCmdStdout(t)
	const key = "assets/cd/fedcba9876543210.webp"
	if err := healAsset(context.Background(), be, key, healSourceFile(t, "NEW"), "", true, true); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if !strings.Contains(out.String(), "would be CREATED") {
		t.Errorf("missing the create notice:\n%s", out.String())
	}
	rc, err := be.Get(context.Background(), key, true)
	if err != nil {
		t.Fatal(err)
	}
	if rc != nil {
		rc.Close()
		t.Error("dry run created the object")
	}
}
