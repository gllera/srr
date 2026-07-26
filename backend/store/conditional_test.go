package store

import (
	"errors"
	"strings"
	"testing"
)

// Conditional-write conformance (Version + PutIfVersion), the primitive the root
// flip CASes on. Every backend that claims support must satisfy the same four
// rules, so they live in one table applied to each: local and SFTP implement it
// best-effort over a filesystem, S3 for real over ETags, and HTTP declines it.

// conditionalConformance asserts the shared contract against one backend.
func conditionalConformance(t *testing.T, b Backend) {
	t.Helper()

	// 1. An absent key versions as "".
	v0, err := b.Version(ctx, "root")
	if err != nil {
		t.Fatalf("Version(absent): %v", err)
	}
	if v0 != "" {
		t.Fatalf("Version(absent) = %q, want \"\"", v0)
	}

	// 2. want == "" is "must not exist": it creates, and the returned token is
	//    the stored object's, so a caller never needs a re-read.
	v1, err := b.PutIfVersion(ctx, "root", strings.NewReader("gen1"), ObjectMeta{}, "")
	if err != nil {
		t.Fatalf("PutIfVersion(create): %v", err)
	}
	if v1 == "" {
		t.Fatal("PutIfVersion(create) returned an empty version")
	}
	if got, err := b.Version(ctx, "root"); err != nil || got != v1 {
		t.Fatalf("Version after create = (%q, %v), want (%q, nil)", got, err, v1)
	}

	// 3. Creating again must fail: the key exists now.
	if _, err := b.PutIfVersion(ctx, "root", strings.NewReader("gen1b"), ObjectMeta{}, ""); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("PutIfVersion(create over an existing key) = %v, want ErrPreconditionFailed", err)
	}

	// 4. The current token swaps; a STALE one does not — and a refused write
	//    leaves the stored object untouched, which is the property the root flip
	//    depends on (the loser must not clobber the winner's generation).
	v2, err := b.PutIfVersion(ctx, "root", strings.NewReader("gen2"), ObjectMeta{}, v1)
	if err != nil {
		t.Fatalf("PutIfVersion(current version): %v", err)
	}
	if v2 == v1 {
		t.Fatal("the version did not change across a write")
	}
	if _, err := b.PutIfVersion(ctx, "root", strings.NewReader("gen3"), ObjectMeta{}, v1); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("PutIfVersion(stale version) = %v, want ErrPreconditionFailed", err)
	}
	rc, err := b.Get(ctx, "root")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "gen2" {
		t.Errorf("a refused conditional write changed the object: %q, want %q", got, "gen2")
	}
}

func TestLocalConditionalWrite(t *testing.T) {
	b, _ := setupLocalStore(t)
	conditionalConformance(t, b)
}

func TestSFTPConditionalWrite(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	conditionalConformance(t, d)
}

func TestS3ConditionalWrite(t *testing.T) {
	b, _ := setupFakeS3(t)
	conditionalConformance(t, b)
}

// The HTTP backend cannot promise the condition is honoured (a server may
// return an ETag and ignore If-Match, with no way to tell in band), so it
// declines rather than degrade silently — and DB.flipRoot falls back to the
// unconditional AtomicPut on exactly this signal.
func TestHTTPConditionalWriteUnsupported(t *testing.T) {
	b := openHTTPStore(t, newHTTPFixture(t))
	if _, err := b.Version(ctx, "root"); !errors.Is(err, errors.ErrUnsupported) {
		t.Errorf("Version = %v, want errors.ErrUnsupported", err)
	}
	if _, err := b.PutIfVersion(ctx, "root", strings.NewReader("x"), ObjectMeta{}, ""); !errors.Is(err, errors.ErrUnsupported) {
		t.Errorf("PutIfVersion = %v, want errors.ErrUnsupported", err)
	}
}
