package main

import (
	"context"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"srrb/mod"
	"srrb/store"
)

func tempStore(t *testing.T) store.Backend {
	t.Helper()
	dir := t.TempDir()
	be, err := store.Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { be.Close() })
	return be
}

func readKey(t *testing.T, be store.Backend, key string) []byte {
	t.Helper()
	rc, err := be.Get(context.Background(), key, false)
	if err != nil {
		t.Fatalf("get %q: %v", key, err)
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read %q: %v", key, err)
	}
	return b
}

// writeCacheFile writes content to cacheDir/name (creating parents) for the
// UploadCacheRef tests, returning the cache dir's absolute path.
func writeCacheFile(t *testing.T, cacheDir, name, content string) {
	t.Helper()
	full := filepath.Join(cacheDir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write cache file: %v", err)
	}
}

// fakeProcess writes an executable shell script to a temp dir and returns its
// path (the asset-process command for newAssetFetcher). body is the script
// after the shebang; the cache file path arrives as "$1".
func fakeProcess(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "process.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("write process script: %v", err)
	}
	return p
}

// procCounter returns a fakeProcess command that drops one uniquely-named file
// into a temp dir on every invocation, plus count() returning how many times it
// has run (the file count) — i.e. how many times asset-process was invoked.
func procCounter(t *testing.T) (proc string, count func() int) {
	t.Helper()
	countDir := t.TempDir()
	proc = fakeProcess(t, "mktemp '"+countDir+"/run.XXXXXX' >/dev/null\ncat \"$1\"")
	count = func() int {
		t.Helper()
		runs, err := os.ReadDir(countDir)
		if err != nil {
			t.Fatalf("read count dir: %v", err)
		}
		return len(runs)
	}
	return proc, count
}

const encodedBytes = "ENCODED-OUTPUT-BYTES"
const jpegBytes = "\xff\xd8\xff\xe0\x00\x10JFIF\x00original-jpeg"
const pdfBytes = "%PDF-1.4\n original pdf"

func TestUploadCacheRefRunsProcessBeforeUpload(t *testing.T) {
	be := tempStore(t)
	// The command ignores its input and emits fixed bytes — stands in for a transcoder.
	out := filepath.Join(t.TempDir(), "out.bin")
	if err := os.WriteFile(out, []byte(encodedBytes), 0o644); err != nil {
		t.Fatalf("write out: %v", err)
	}
	af := newAssetFetcher(be, 1024, fakeProcess(t, "cat '"+out+"'"))

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}

	// Stored bytes are the ENCODER's output; the key is keyed on the SOURCE hash
	// and keeps the source extension.
	sum := sha256.Sum256([]byte(jpegBytes))
	if want := contentHashKey(".jpg", sum); key != want {
		t.Errorf("key = %q, want source-hash key %q", key, want)
	}
	if got := string(readKey(t, be, key)); got != encodedBytes {
		t.Errorf("stored body = %q, want encoded bytes %q", got, encodedBytes)
	}
}

func TestUploadCacheRefSkipsProcessWhenSourceAlreadyUploaded(t *testing.T) {
	be := tempStore(t)
	// Pre-seed the store at the source-hash key with a sentinel.
	sum := sha256.Sum256([]byte(jpegBytes))
	key := contentHashKey(".jpg", sum)
	if err := be.Put(context.Background(), key, strings.NewReader("ALREADY"), true); err != nil {
		t.Fatalf("seed store: %v", err)
	}

	// A command with a side effect: if it runs, it creates ran.
	ran := filepath.Join(t.TempDir(), "ran")
	af := newAssetFetcher(be, 1024, fakeProcess(t, "touch '"+ran+"'\ncat \"$1\""))

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	got, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if got != key {
		t.Errorf("key = %q, want %q", got, key)
	}
	if _, err := os.Stat(ran); !os.IsNotExist(err) {
		t.Error("encoder ran even though the source was already uploaded")
	}
	if body := string(readKey(t, be, key)); body != "ALREADY" {
		t.Errorf("present key was re-uploaded: stored %q, want ALREADY", body)
	}
}

func TestUploadCacheRefProcessRunsForEveryFileType(t *testing.T) {
	be := tempStore(t)
	// A pass-through command with a side effect, on a non-media (PDF) file: the
	// command must still run (no media gate) and its output is stored verbatim.
	ran := filepath.Join(t.TempDir(), "ran")
	af := newAssetFetcher(be, 1024, fakeProcess(t, "touch '"+ran+"'\ncat \"$1\""))

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "doc.pdf", pdfBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "doc.pdf")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if _, err := os.Stat(ran); err != nil {
		t.Errorf("encoder was not run for a non-media file: %v", err)
	}
	if !strings.HasSuffix(key, ".pdf") {
		t.Errorf("key = %q, want source .pdf extension", key)
	}
	if got := string(readKey(t, be, key)); got != pdfBytes {
		t.Errorf("stored body = %q, want %q", got, pdfBytes)
	}
}

func TestUploadCacheRefProcessFailsSoftToOriginal(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1024, fakeProcess(t, "echo boom >&2\nexit 1"))

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef should fail soft, got error: %v", err)
	}
	if got := string(readKey(t, be, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want original %q (fail-soft)", got, jpegBytes)
	}
}

// A process command that overruns procTimeout is killed and fails soft to the
// original bytes — proving the asset-process command IS bounded by procTimeout.
func TestUploadCacheRefProcessTimesOutViaAssetTimeout(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1024, fakeProcess(t, "exec sleep 5"))
	af.procTimeout = 30 * time.Millisecond // well under the 5s sleep

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef should fail soft on timeout, got error: %v", err)
	}
	if got := string(readKey(t, be, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want original %q (process timed out)", got, jpegBytes)
	}
}

// The asset-process timeout is independent of the shared --cmd-timeout: with a
// tiny cmd-timeout but a generous procTimeout, a process that runs longer than
// cmd-timeout still completes. Under the old shared-timeout wiring this process
// would have been killed and failed soft to the original.
func TestUploadCacheRefProcessTimeoutIndependentOfCmdTimeout(t *testing.T) {
	be := tempStore(t)
	out := filepath.Join(t.TempDir(), "out.bin")
	if err := os.WriteFile(out, []byte(encodedBytes), 0o644); err != nil {
		t.Fatalf("write out: %v", err)
	}
	// Sleeps longer than the shared cmd-timeout set below, but far under its own.
	af := newAssetFetcher(be, 1024, fakeProcess(t, "sleep 0.2\ncat '"+out+"'"))
	af.procTimeout = 10 * time.Second

	orig := mod.CmdTimeout
	mod.CmdTimeout = 20 * time.Millisecond // shrink the SHARED bound below the sleep
	defer func() { mod.CmdTimeout = orig }()

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if got := string(readKey(t, be, key)); got != encodedBytes {
		t.Errorf("stored body = %q, want encoded %q (asset timeout, not cmd-timeout, applies)", got, encodedBytes)
	}
}

// A zero (unset/default) procTimeout means UNLIMITED: no deadline is applied, so
// even a command that far outruns the shared --cmd-timeout completes. Proves the
// default asset-process timeout is uncapped (media transcode can run arbitrarily
// long) — bounded only by run cancellation, not by any fallback timeout. Under the
// old wiring a zero procTimeout fell back to SubprocessTimeout and this would have
// been killed and failed soft to the original.
func TestUploadCacheRefProcessTimeoutUnlimited(t *testing.T) {
	be := tempStore(t)
	out := filepath.Join(t.TempDir(), "out.bin")
	if err := os.WriteFile(out, []byte(encodedBytes), 0o644); err != nil {
		t.Fatalf("write out: %v", err)
	}
	// Sleeps far longer than the tiny shared cmd-timeout set below.
	af := newAssetFetcher(be, 1024, fakeProcess(t, "sleep 0.2\ncat '"+out+"'"))
	af.procTimeout = 0 // unlimited — the default

	orig := mod.CmdTimeout
	mod.CmdTimeout = 20 * time.Millisecond // shrink the SHARED bound below the sleep
	defer func() { mod.CmdTimeout = orig }()

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if got := string(readKey(t, be, key)); got != encodedBytes {
		t.Errorf("stored body = %q, want encoded %q (unlimited procTimeout must not fall back to cmd-timeout)", got, encodedBytes)
	}
}

// asset-peek is bounded by --asset-process-timeout (procTimeout), NOT the shared
// --cmd-timeout: with a tiny cmd-timeout and the default unlimited procTimeout, a
// slow peek still completes and its extension is applied. Proves --cmd-timeout no
// longer affects asset processing (neither peek nor process).
func TestUploadCacheRefPeekUnaffectedByCmdTimeout(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1024, "") // no asset-process
	af.peek = strings.Fields(fakeProcess(t, "sleep 0.2\nprintf '{\"mimetype\":\"image/webp\",\"extension\":\"webp\",\"supported\":true}'") + " {input}")
	af.procTimeout = 0 // unlimited — the default

	orig := mod.CmdTimeout
	mod.CmdTimeout = 20 * time.Millisecond // shrink the SHARED bound below the peek sleep
	defer func() { mod.CmdTimeout = orig }()

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	// The slow peek outran --cmd-timeout but must still have applied: the key takes
	// the peek's .webp extension, not the source .jpg (which would signal fail-soft).
	sum := sha256.Sum256([]byte(jpegBytes))
	if want := contentHashKey(".webp", sum); key != want {
		t.Errorf("key = %q, want peek-extension key %q (peek must not be bound by --cmd-timeout)", key, want)
	}
}

func TestUploadCacheRefProcessSubstitutesInputToken(t *testing.T) {
	be := tempStore(t)
	// The script echoes its FIRST positional arg. With {input} substituted in
	// place the cache path lands at $1; if the path were instead appended (the
	// no-token fallback) $1 would be the literal "{input}".
	af := newAssetFetcher(be, 1024, fakeProcess(t, `printf 'GOT:%s' "$1"`)+" {input}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)
	full := filepath.Join(cacheDir, "photo.jpg")

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if got, want := string(readKey(t, be, key)), "GOT:"+full; got != want {
		t.Errorf("stored body = %q, want %q ({input} not substituted in place)", got, want)
	}
}

func TestUploadCacheRefProcessSubstitutesInputTokenWithinArg(t *testing.T) {
	be := tempStore(t)
	// {input} inside a larger arg (--in=<path>) must be replaced per-field, not
	// only when it is the whole arg. The script strips the flag prefix and cats
	// the file, prefixed so a fail-soft fallback (which would upload the original
	// jpeg bytes) is distinguishable from a real run.
	af := newAssetFetcher(be, 1024, fakeProcess(t, "f=\"${1#--in=}\"\nprintf 'OK'\ncat \"$f\"")+" --in={input}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if got, want := string(readKey(t, be, key)), "OK"+jpegBytes; got != want {
		t.Errorf("stored body = %q, want %q ({input} not substituted within --in=)", got, want)
	}
}

// metaCaptureBackend records the ObjectMeta handed to AtomicPut so a test can
// assert the Content-Type / Content-Encoding the asset layer threaded through.
type metaCaptureBackend struct {
	store.Backend
	gotKey  string
	gotMeta store.ObjectMeta
}

func (m *metaCaptureBackend) AtomicPut(ctx context.Context, key string, r io.Reader, meta store.ObjectMeta) error {
	m.gotKey = key
	m.gotMeta = meta
	return m.Backend.AtomicPut(ctx, key, r, meta)
}

func TestUploadCacheRefProcessOutputWritesFileBytes(t *testing.T) {
	be := tempStore(t)
	// {output} mode: the command writes the processed bytes to the output file
	// and prints metadata JSON to stdout. The stored bytes must come from the
	// FILE, not stdout.
	body := "printf 'PROCESSED' > \"$2\"\nprintf '{\"mimetype\":\"image/webp\",\"extension\":\"webp\"}'"
	af := newAssetFetcher(be, 1024, fakeProcess(t, body)+" {input} {output}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if got := string(readKey(t, be, key)); got != "PROCESSED" {
		t.Errorf("stored body = %q, want the output-file bytes %q", got, "PROCESSED")
	}
}

func TestUploadCacheRefProcessOutputThreadsObjectMeta(t *testing.T) {
	cap := &metaCaptureBackend{Backend: tempStore(t)}
	body := "printf 'P' > \"$2\"\nprintf '{\"mimetype\":\"image/webp\",\"extension\":\"webp\",\"encoding\":\"gzip\"}'"
	af := newAssetFetcher(cap, 1024, fakeProcess(t, body)+" {input} {output}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg"); err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if cap.gotMeta.ContentType != "image/webp" {
		t.Errorf("ContentType = %q, want image/webp (from process JSON)", cap.gotMeta.ContentType)
	}
	if cap.gotMeta.ContentEncoding != "gzip" {
		t.Errorf("ContentEncoding = %q, want gzip (from process JSON)", cap.gotMeta.ContentEncoding)
	}
}

func TestUploadCacheRefProcessOutputEmptyFileFailsSoft(t *testing.T) {
	cap := &metaCaptureBackend{Backend: tempStore(t)}
	// Prints JSON but never writes the output file → empty output → fail-soft.
	af := newAssetFetcher(cap, 1024, fakeProcess(t, "printf '{\"mimetype\":\"image/webp\"}'")+" {input} {output}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef should fail soft, got error: %v", err)
	}
	if got := string(readKey(t, cap, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want original %q (fail-soft)", got, jpegBytes)
	}
	if cap.gotMeta != (store.ObjectMeta{}) {
		t.Errorf("ObjectMeta = %+v, want empty on fail-soft", cap.gotMeta)
	}
}

func TestUploadCacheRefProcessOutputBadJSONFailsSoft(t *testing.T) {
	be := tempStore(t)
	// Writes the output file but emits non-JSON on stdout → metadata parse fails
	// → fail-soft to the original.
	af := newAssetFetcher(be, 1024, fakeProcess(t, "printf 'DATA' > \"$2\"\nprintf 'not json'")+" {input} {output}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef should fail soft, got error: %v", err)
	}
	if got := string(readKey(t, be, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want original %q (fail-soft)", got, jpegBytes)
	}
}

func TestUploadCacheRefPeekSetsKeyExtensionAndMeta(t *testing.T) {
	cap := &metaCaptureBackend{Backend: tempStore(t)}
	af := newAssetFetcher(cap, 1024, "") // no asset-process
	af.peek = strings.Fields(fakeProcess(t, `printf '{"mimetype":"image/webp","extension":"webp","supported":true}'`) + " {input}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	// Key keeps the SOURCE hash but takes the PEEK extension.
	sum := sha256.Sum256([]byte(jpegBytes))
	if want := contentHashKey(".webp", sum); key != want {
		t.Errorf("key = %q, want peek-extension key %q", key, want)
	}
	if cap.gotMeta.ContentType != "image/webp" {
		t.Errorf("ContentType = %q, want image/webp (from peek)", cap.gotMeta.ContentType)
	}
}

func TestUploadCacheRefPeekUnsupportedHostsOriginalSkipsProcess(t *testing.T) {
	cap := &metaCaptureBackend{Backend: tempStore(t)}
	ran := filepath.Join(t.TempDir(), "ran")
	af := newAssetFetcher(cap, 1024, fakeProcess(t, "touch '"+ran+"'\ncat \"$1\""))
	af.peek = strings.Fields(fakeProcess(t, `printf '{"mimetype":"image/svg+xml","extension":"svg","supported":false}'`) + " {input}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	if _, err := os.Stat(ran); !os.IsNotExist(err) {
		t.Error("asset-process ran for an unsupported asset")
	}
	sum := sha256.Sum256([]byte(jpegBytes))
	if want := contentHashKey(".svg", sum); key != want {
		t.Errorf("key = %q, want peek-extension key %q", key, want)
	}
	if got := string(readKey(t, cap, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want original %q (unsupported)", got, jpegBytes)
	}
	if cap.gotMeta.ContentType != "image/svg+xml" {
		t.Errorf("ContentType = %q, want image/svg+xml (from peek)", cap.gotMeta.ContentType)
	}
}

func TestUploadCacheRefPeekFailSoftUsesSourceExtension(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1024, "")
	af.peek = strings.Fields(fakeProcess(t, "echo boom >&2\nexit 1") + " {input}") // peek fails

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	sum := sha256.Sum256([]byte(jpegBytes))
	if want := contentHashKey(".jpg", sum); key != want {
		t.Errorf("key = %q, want SOURCE-extension key %q (peek fail-soft)", key, want)
	}
	if got := string(readKey(t, be, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want %q", got, jpegBytes)
	}
}

func TestUploadCacheRefProcessMetaOverridesPeekMeta(t *testing.T) {
	cap := &metaCaptureBackend{Backend: tempStore(t)}
	// asset-process declares image/avif in {output} mode; peek predicted image/webp.
	// The actual result's type (process) wins for Content-Type; the key keeps the
	// peek extension (decided before process runs).
	body := "printf 'AVIF' > \"$2\"\nprintf '{\"mimetype\":\"image/avif\",\"extension\":\"webp\"}'"
	af := newAssetFetcher(cap, 1024, fakeProcess(t, body)+" {input} {output}")
	af.peek = strings.Fields(fakeProcess(t, `printf '{"mimetype":"image/webp","extension":"webp","supported":true}'`) + " {input}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	sum := sha256.Sum256([]byte(jpegBytes))
	if want := contentHashKey(".webp", sum); key != want {
		t.Errorf("key = %q, want peek-extension key %q", key, want)
	}
	if got := string(readKey(t, cap, key)); got != "AVIF" {
		t.Errorf("stored body = %q, want process output AVIF", got)
	}
	if cap.gotMeta.ContentType != "image/avif" {
		t.Errorf("ContentType = %q, want image/avif (process overrides peek)", cap.gotMeta.ContentType)
	}
}

func TestUploadCacheRefStoresUnderContentHashKey(t *testing.T) {
	const body = "IMAGEBYTES"
	be := tempStore(t)
	af := newAssetFetcher(be, 1024, "")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "sub/photo.jpg", body)

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "sub/photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}

	sum := sha256.Sum256([]byte(body))
	if want := contentHashKey(".jpg", sum); key != want {
		t.Errorf("key = %q, want content-hash key %q", key, want)
	}
	if !strings.HasPrefix(key, "assets/") || !strings.HasSuffix(key, ".jpg") {
		t.Errorf("unexpected key shape: %q", key)
	}
	if got := string(readKey(t, be, key)); got != body {
		t.Errorf("stored body = %q, want %q", got, body)
	}
}

func TestUploadCacheRefSkipsWhenAlreadyPresent(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1024, "")
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "p.jpg", "ORIGINAL")

	key, err := af.UploadCacheRef(context.Background(), cacheDir, "p.jpg")
	if err != nil {
		t.Fatalf("first UploadCacheRef: %v", err)
	}

	// Overwrite the stored object with a sentinel; a second call must find the
	// key present and skip the re-upload, leaving the sentinel intact.
	if err := be.Put(context.Background(), key, strings.NewReader("SENTINEL"), true); err != nil {
		t.Fatalf("seed store: %v", err)
	}
	key2, err := af.UploadCacheRef(context.Background(), cacheDir, "p.jpg")
	if err != nil {
		t.Fatalf("second UploadCacheRef: %v", err)
	}
	if key2 != key {
		t.Errorf("key not stable across runs: %q vs %q", key2, key)
	}
	if got := string(readKey(t, be, key)); got != "SENTINEL" {
		t.Errorf("present key was re-uploaded: stored %q, want SENTINEL", got)
	}
}

func TestUploadCacheRefRejectsTraversal(t *testing.T) {
	parent := t.TempDir()
	cacheDir := filepath.Join(parent, "cache")
	if err := os.Mkdir(cacheDir, 0o755); err != nil {
		t.Fatalf("mkdir cache: %v", err)
	}
	// A real file outside the cache dir, referenced via "..".
	if err := os.WriteFile(filepath.Join(parent, "outside.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	af := newAssetFetcher(tempStore(t), 1024, "")
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "../outside.jpg"); err == nil {
		t.Fatal("expected traversal rejection, got nil")
	}
}

func TestUploadCacheRefRejectsSymlink(t *testing.T) {
	parent := t.TempDir()
	cacheDir := filepath.Join(parent, "cache")
	if err := os.Mkdir(cacheDir, 0o755); err != nil {
		t.Fatalf("mkdir cache: %v", err)
	}
	target := filepath.Join(parent, "secret.jpg")
	if err := os.WriteFile(target, []byte("secret"), 0o644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(cacheDir, "link.jpg")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	af := newAssetFetcher(tempStore(t), 1024, "")
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "link.jpg"); err == nil {
		t.Fatal("expected symlink rejection, got nil")
	}
}

// An oversize SOURCE is no longer rejected at upload — the cap moved to download
// (#selfhost / external ingest). The cache file is trusted and stored as-is.
func TestUploadCacheRefStoresOversizeSourceUnchecked(t *testing.T) {
	be := tempStore(t)
	af := newAssetFetcher(be, 1, "") // 1 KB cap, but no source check anymore
	cacheDir := t.TempDir()
	big := strings.Repeat("x", 4096)
	writeCacheFile(t, cacheDir, "big.jpg", big)
	key, err := af.UploadCacheRef(context.Background(), cacheDir, "big.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef should not size-check the source, got: %v", err)
	}
	if got := string(readKey(t, be, key)); got != big {
		t.Errorf("stored body len = %d, want the full %d-byte source", len(got), len(big))
	}
}

// The asset-process OUTPUT is generated at upload (not download-bounded), so a
// fail-soft size guard remains: an over-cap transcode output uploads the original.
func TestUploadCacheRefProcessOutputOversizeFailsSoft(t *testing.T) {
	be := tempStore(t)
	// {output} mode: write a 4 KB result + valid metadata. With a 1 KB cap the
	// output exceeds it, so readProcOutput fails soft and the original is stored.
	body := `head -c 4096 /dev/zero > "$2"` + "\n" +
		`printf '{"mimetype":"image/webp","extension":"webp"}'`
	af := newAssetFetcher(be, 1, fakeProcess(t, body)+" {input} {output}") // 1 KB cap
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)
	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef should fail soft on oversize output, got: %v", err)
	}
	if got := string(readKey(t, be, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want original %q (oversize output fails soft)", got, jpegBytes)
	}
}

// The stdout-mode asset-process output is generated at upload too (not
// download-bounded), so the same fail-soft cap as the {output} path applies: an
// over-cap stdout result uploads the original. (Regression: the cap check was
// only restored to the {output} branch; webify writes to stdout.)
func TestUploadCacheRefProcessStdoutOversizeFailsSoft(t *testing.T) {
	be := tempStore(t)
	// stdout mode (no {output} token): emit 4 KB to stdout. With a 1 KB cap the
	// output exceeds it, so runProcess fails soft and the original is stored.
	af := newAssetFetcher(be, 1, fakeProcess(t, `head -c 4096 /dev/zero`)) // 1 KB cap
	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)
	key, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("UploadCacheRef should fail soft on oversize stdout output, got: %v", err)
	}
	if got := string(readKey(t, be, key)); got != jpegBytes {
		t.Errorf("stored body = %q, want original %q (oversize stdout output fails soft)", got, jpegBytes)
	}
}

func TestUploadCacheRefMissingFile(t *testing.T) {
	af := newAssetFetcher(tempStore(t), 1024, "")
	if _, err := af.UploadCacheRef(context.Background(), t.TempDir(), "nope.jpg"); err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

// failMidWriteBackend wraps a real Backend and fails AtomicPut after writing
// writeOK bytes, simulating a mid-stream crash or I/O error.  Get/Put/Rm/Close
// are promoted from the embedded backend so the existence check works normally.
type failMidWriteBackend struct {
	store.Backend       // inner backend; Get/Put/Rm/Close pass through
	writeOK       int64 // bytes to copy before injecting an error
}

var errMidWrite = io.ErrUnexpectedEOF

func (f *failMidWriteBackend) AtomicPut(_ context.Context, _ string, r io.Reader, _ store.ObjectMeta) error {
	// Drain exactly writeOK bytes then return an error, simulating a mid-write failure.
	buf := make([]byte, f.writeOK)
	io.ReadFull(r, buf) //nolint:errcheck — we intentionally discard the partial read
	return errMidWrite
}

// TestUploadCacheRefNoPartialFileOnAtomicPutFailure is the B6 regression test:
// a mid-upload failure must leave no partial object at the immutable
// content-hash key.  With AtomicPut the write goes to a .tmp file; on failure
// the tmp is abandoned and the final key is never created, so the next
// existence check returns "not found" rather than truncated bytes.
func TestUploadCacheRefNoPartialFileOnAtomicPutFailure(t *testing.T) {
	inner := tempStore(t)
	be := &failMidWriteBackend{Backend: inner, writeOK: 4} // fail after 4 bytes

	af := newAssetFetcher(be, 1024, "")
	cacheDir := t.TempDir()
	// Content longer than writeOK so the mid-stream failure fires.
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	_, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err == nil {
		t.Fatal("expected upload error, got nil")
	}

	// The immutable key must NOT exist — not even partially.
	sum := sha256.Sum256([]byte(jpegBytes))
	key := contentHashKey(".jpg", sum)
	rc, getErr := inner.Get(context.Background(), key, true)
	if getErr != nil {
		t.Fatalf("Get after failed upload: %v", getErr)
	}
	if rc != nil {
		rc.Close()
		t.Errorf("partial object found at immutable key %q after failed upload; AtomicPut should prevent this", key)
	}
}

// TestUploadCacheRefMemoizesWithinRun verifies the within-run memo: a marker
// reused in one fetch short-circuits the repeat before the asset-peek subprocess
// (and the store existence round-trip it precedes), so peek runs exactly once for
// the same source bytes.
func TestUploadCacheRefMemoizesWithinRun(t *testing.T) {
	cap := &metaCaptureBackend{Backend: tempStore(t)}
	af := newAssetFetcher(cap, 1024, "") // no asset-process; peek alone
	runs := filepath.Join(t.TempDir(), "peekruns")
	af.peek = strings.Fields(fakeProcess(t,
		`printf x >> '`+runs+`'; printf '{"mimetype":"image/webp","extension":"webp","supported":true}'`) + " {input}")

	cacheDir := t.TempDir()
	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)

	k1, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("first UploadCacheRef: %v", err)
	}
	k2, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg")
	if err != nil {
		t.Fatalf("second UploadCacheRef: %v", err)
	}
	if k1 != k2 {
		t.Errorf("keys differ across the same-bytes references: %q vs %q", k1, k2)
	}
	if b, _ := os.ReadFile(runs); len(b) != 1 {
		t.Errorf("asset-peek ran %d times, want 1 (within-run memo should skip the repeat)", len(b))
	}
}

// Processed outputs are staged under <cache-dir>/_processed/, not the OS temp
// dir: big transcodes can't fill a tmpfs /tmp, and a crash-leaked output sits
// inside the swept cache tree, reclaimed by the post-cycle age sweep. A
// successful upload still removes the staging file immediately.
func TestUploadCacheRefProcessOutputStagedUnderCacheDir(t *testing.T) {
	be := tempStore(t)
	cacheDir := t.TempDir()
	rec := filepath.Join(t.TempDir(), "outpath")
	body := "printf '%s' \"$2\" > " + rec + "\nprintf 'PROCESSED' > \"$2\"\nprintf '{\"mimetype\":\"image/webp\",\"extension\":\"webp\"}'"
	af := newAssetFetcher(be, 1024, fakeProcess(t, body)+" {input} {output}")
	af.procDir = filepath.Join(cacheDir, "_processed")

	writeCacheFile(t, cacheDir, "photo.jpg", jpegBytes)
	if _, err := af.UploadCacheRef(context.Background(), cacheDir, "photo.jpg"); err != nil {
		t.Fatalf("UploadCacheRef: %v", err)
	}
	got, err := os.ReadFile(rec)
	if err != nil {
		t.Fatalf("read recorded output path: %v", err)
	}
	if !strings.HasPrefix(string(got), af.procDir+string(filepath.Separator)) {
		t.Errorf("output staged at %q, want under %q", got, af.procDir)
	}
	ents, err := os.ReadDir(af.procDir)
	if err != nil {
		t.Fatalf("read _processed: %v", err)
	}
	if len(ents) != 0 {
		t.Errorf("staging file not cleaned after successful upload: %v", ents)
	}
}
