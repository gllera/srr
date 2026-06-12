package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// requireSh skips a test on the rare platform without /bin/sh, since the
// external-fetcher path shells out unconditionally.
func requireSh(t *testing.T) {
	t.Helper()
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh available")
	}
}

// emit writes payload to a temp file and returns a shell command that drains
// stdin (the request) and prints the file verbatim as the response — the
// canonical "ignore the request, return this Result" external fetcher.
func emit(t *testing.T, payload string) string {
	t.Helper()
	resp := filepath.Join(t.TempDir(), "resp.json")
	if err := os.WriteFile(resp, []byte(payload), 0644); err != nil {
		t.Fatalf("write resp: %v", err)
	}
	return "cat > /dev/null; cat " + resp
}

// TestExternalFetcherProtocol round-trips a request through a real shell
// pipeline. Confirms encode/decode of etag/last_modified, the uint32 GUID, and
// RFC3339 published parsing. Items on the wire are mod.RawItem records, so the
// external fetcher emits an already-hashed uint32 GUID.
func TestExternalFetcherProtocol(t *testing.T) {
	requireSh(t)

	guid := hash("abc")
	payload := fmt.Sprintf(`{"etag":"e1","last_modified":"lm1","items":[{"guid":%d,"title":"T","content":"C","link":"https://x/1","published":"2024-03-01T12:00:00Z"}]}`, guid)

	got, err := New().Fetch(context.Background(), emit(t, payload), nil, nil, Request{URL: "https://x", MaxSize: 1024})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if got.ETag != "e1" || got.LastModified != "lm1" {
		t.Errorf("etag/last_modified roundtrip lost: %+v", got)
	}
	if len(got.Items) != 1 {
		t.Fatalf("got %d items, want 1", len(got.Items))
	}
	if got.Items[0].GUID != guid {
		t.Errorf("GUID round-trip lost: got %d, want %d", got.Items[0].GUID, guid)
	}
	if got.Items[0].Published == nil || got.Items[0].Published.Unix() != 1709294400 {
		t.Errorf("Published = %v, want 2024-03-01T12:00:00Z", got.Items[0].Published)
	}
}

func TestExternalFetcherNotModified(t *testing.T) {
	requireSh(t)

	got, err := New().Fetch(context.Background(), emit(t, `{"not_modified":true,"etag":"e2"}`), nil, nil, Request{URL: "https://x", MaxSize: 1024})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if !got.NotModified {
		t.Errorf("not_modified roundtrip lost")
	}
	if got.ETag != "e2" {
		t.Errorf("etag roundtrip lost: %q", got.ETag)
	}
}

// TestExternalFetcherRequestOnStdin proves the command receives the full
// Request as JSON on stdin — the half of the protocol the other tests skip by
// draining stdin to /dev/null.
func TestExternalFetcherRequestOnStdin(t *testing.T) {
	requireSh(t)

	reqFile := filepath.Join(t.TempDir(), "req.json")
	cmd := fmt.Sprintf("cat > %s; echo '{\"items\":[]}'", reqFile)
	want := Request{URL: "https://example.com/x", ETag: "e-tag", LastModified: "lm", MaxSize: 4096}

	if _, err := New().Fetch(context.Background(), cmd, nil, nil, want); err != nil {
		t.Fatalf("fetch: %v", err)
	}

	data, err := os.ReadFile(reqFile)
	if err != nil {
		t.Fatalf("read captured request: %v", err)
	}
	var got Request
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode captured request: %v", err)
	}
	if got != want {
		t.Errorf("request on stdin = %+v, want %+v", got, want)
	}
}

// TestExternalFetcherEnvPassthrough proves SRR_* (and any other) environment
// variables reach the command, which is how an external fetcher receives
// credentials/config. New() snapshots the environment, so Setenv must precede it.
func TestExternalFetcherEnvPassthrough(t *testing.T) {
	requireSh(t)

	t.Setenv("SRR_TEST_TOKEN", "secret123")
	out := filepath.Join(t.TempDir(), "token.txt")
	cmd := fmt.Sprintf(`cat > /dev/null; printf '%%s' "$SRR_TEST_TOKEN" > %s; echo '{"items":[]}'`, out)

	if _, err := New().Fetch(context.Background(), cmd, nil, nil, Request{URL: "https://x"}); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	if string(data) != "secret123" {
		t.Errorf("env not passed through: got %q, want %q", string(data), "secret123")
	}
}

func TestExternalFetcherDatelessItem(t *testing.T) {
	requireSh(t)

	payload := fmt.Sprintf(`{"items":[{"guid":%d,"title":"T","content":"C","link":"https://x/1"}]}`, hash("no-date"))
	got, err := New().Fetch(context.Background(), emit(t, payload), nil, nil, Request{URL: "https://x", MaxSize: 1024})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(got.Items) != 1 {
		t.Fatalf("got %d items, want 1", len(got.Items))
	}
	if got.Items[0].Published != nil {
		t.Errorf("dateless item Published = %v, want nil", *got.Items[0].Published)
	}
}

func TestExternalFetcherMultipleItemsOrdered(t *testing.T) {
	requireSh(t)

	payload := `{"items":[{"guid":1,"title":"a"},{"guid":2,"title":"b"},{"guid":3,"title":"c"}]}`
	got, err := New().Fetch(context.Background(), emit(t, payload), nil, nil, Request{URL: "https://x", MaxSize: 1024})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	want := []string{"a", "b", "c"}
	if len(got.Items) != len(want) {
		t.Fatalf("got %d items, want %d", len(got.Items), len(want))
	}
	for i, w := range want {
		if got.Items[i].Title != w {
			t.Errorf("item[%d].Title = %q, want %q (order not preserved)", i, got.Items[i].Title, w)
		}
	}
}

func TestExternalFetcherNonZeroExit(t *testing.T) {
	requireSh(t)

	_, err := New().Fetch(context.Background(), "cat > /dev/null; exit 3", nil, nil, Request{URL: "https://x"})
	if err == nil {
		t.Fatal("expected error on non-zero exit, got nil")
	}
}

func TestExternalFetcherEmptyOutput(t *testing.T) {
	requireSh(t)

	_, err := New().Fetch(context.Background(), "cat > /dev/null; true", nil, nil, Request{URL: "https://x"})
	if err == nil {
		t.Fatal("expected error on empty output, got nil")
	}
	if !strings.Contains(err.Error(), "no output") {
		t.Errorf("error = %v, want mention of 'no output'", err)
	}
}

func TestExternalFetcherGarbageOutput(t *testing.T) {
	requireSh(t)

	_, err := New().Fetch(context.Background(), "cat > /dev/null; echo not-json", nil, nil, Request{URL: "https://x"})
	if err == nil {
		t.Fatal("expected decode error on non-JSON output, got nil")
	}
}

// TestExternalFetcherContextCanceled confirms an already-canceled context
// aborts the subprocess instead of running it — the path graceful shutdown and
// per-fetch deadlines rely on.
func TestExternalFetcherContextCanceled(t *testing.T) {
	requireSh(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := New().Fetch(ctx, "cat > /dev/null; cat", nil, nil, Request{URL: "https://x"})
	if err == nil {
		t.Fatal("expected error when context is canceled, got nil")
	}
}

// --- external working directory ---------------------------------------------
//
// The engine no longer owns asset upload: it only runs the command in the
// caller-provided Request.AssetDir (its working directory). Upload of the files
// the command downloads there is the caller's end-of-pipeline step, exercised
// in the main package (assets_test.go).

const assetTestURL = "https://example.com/feed"

// TestExternalFetcherRunsInProvidedDir confirms the command runs in the
// caller-provided Request.AssetDir — so it can read/write files with plain
// relative paths — and that the directory round-trips to the command as
// Request.asset_dir.
func TestExternalFetcherRunsInProvidedDir(t *testing.T) {
	requireSh(t)

	dir := t.TempDir()
	// The command writes the request to a relative path and touches a marker;
	// both land in its working directory, which must be AssetDir.
	cmd := `cat > req.json; : > marker.txt; echo '{"items":[]}'`

	_, err := New().Fetch(context.Background(), cmd, nil, nil, Request{URL: assetTestURL, AssetDir: dir})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}

	// Relative writes from the command landed in dir => it was the cwd.
	if _, err := os.Stat(filepath.Join(dir, "marker.txt")); err != nil {
		t.Errorf("command did not run in the provided dir: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "req.json"))
	if err != nil {
		t.Fatalf("read captured request: %v", err)
	}
	var got Request
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if got.AssetDir != dir {
		t.Errorf("Request.asset_dir = %q, want %q", got.AssetDir, dir)
	}
}

// TestExternalFetcherNoAssetDir confirms that with no AssetDir set (preview,
// self-hosting disabled) the command receives an empty asset_dir and the engine
// leaves the calling process's working directory unchanged.
func TestExternalFetcherNoAssetDir(t *testing.T) {
	requireSh(t)

	reqOut := filepath.Join(t.TempDir(), "req.json")
	cmd := fmt.Sprintf(`cat > %s; echo '{"items":[]}'`, reqOut)

	if _, err := New().Fetch(context.Background(), cmd, nil, nil, Request{URL: assetTestURL}); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	data, err := os.ReadFile(reqOut)
	if err != nil {
		t.Fatalf("read captured request: %v", err)
	}
	var got Request
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if got.AssetDir != "" {
		t.Errorf("asset_dir should be empty when unset, got %q", got.AssetDir)
	}
}
