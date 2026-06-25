package store

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeS3 is an in-memory S3 lookalike behind httptest. The endpoint override
// (s3Cfg.Endpoint → cfg.BaseEndpoint) plus an IP-literal host force the SDK
// into path-style addressing (/bucket/<key>), so the handler routes on the
// URL path and ignores SigV4 entirely. It honors the two protocol features
// the production code relies on: `If-None-Match: *` exclusive creates (412 +
// PreconditionFailed) and aws-chunked PUT bodies (the SDK's wire format for
// non-seekable bodies with a trailing CRC32 — production streams exactly
// those).
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	headers map[string]http.Header // last successful PUT's request headers per key
}

func s3Error(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message></Error>`, code, code)
}

// decodeAWSChunked strips the aws-chunked framing: repeated
// `<hexlen>[;chunk-signature=…]\r\n<data>\r\n` runs terminated by a zero-size
// chunk followed by trailers (x-amz-checksum-*) we don't verify.
func decodeAWSChunked(r io.Reader) ([]byte, error) {
	br := bufio.NewReader(r)
	var out bytes.Buffer
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, fmt.Errorf("reading chunk size line: %w", err)
		}
		sizeHex, _, _ := strings.Cut(strings.TrimRight(line, "\r\n"), ";")
		size, err := strconv.ParseInt(sizeHex, 16, 64)
		if err != nil {
			return nil, fmt.Errorf("bad chunk size %q: %w", line, err)
		}
		if size == 0 {
			return out.Bytes(), nil
		}
		if _, err := io.CopyN(&out, br, size); err != nil {
			return nil, fmt.Errorf("reading %d-byte chunk: %w", size, err)
		}
		if _, err := br.Discard(2); err != nil { // chunk-trailing CRLF
			return nil, fmt.Errorf("chunk CRLF: %w", err)
		}
	}
}

func readPutBody(r *http.Request) ([]byte, error) {
	if strings.Contains(r.Header.Get("Content-Encoding"), "aws-chunked") {
		return decodeAWSChunked(r.Body)
	}
	return io.ReadAll(r.Body)
}

func (f *fakeS3) handler(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/bucket/")
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.Method {
	case http.MethodGet:
		body, ok := f.objects[key]
		if !ok {
			s3Error(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		// Real CRC32 response checksum (base64 of the big-endian sum): the
		// production Get sets ChecksumMode=Enabled, so the SDK validates this.
		sum := make([]byte, 4)
		binary.BigEndian.PutUint32(sum, crc32.ChecksumIEEE(body))
		w.Header().Set("x-amz-checksum-crc32", base64.StdEncoding.EncodeToString(sum))
		w.Write(body) //nolint:errcheck
	case http.MethodPut:
		if r.Header.Get("If-None-Match") == "*" {
			if _, exists := f.objects[key]; exists {
				s3Error(w, http.StatusPreconditionFailed, "PreconditionFailed")
				return
			}
		}
		body, err := readPutBody(r)
		if err != nil {
			s3Error(w, http.StatusBadRequest, "MalformedBody")
			return
		}
		f.objects[key] = body
		f.headers[key] = r.Header.Clone()
	case http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		s3Error(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

// setupFakeS3 opens the production S3 backend (s3://bucket/prefix) against an
// in-memory fake. Object keys carry the "prefix/" path prefix. The fake must
// serve TLS: the SDK refuses trailing checksums (the aws-chunked encoding of
// non-seekable bodies — production's *bytes.Buffer streams) over plain HTTP.
// AWS_CA_BUNDLE makes LoadDefaultConfig trust httptest's self-signed cert
// without any production-code seam.
func setupFakeS3(t *testing.T) (Backend, *fakeS3) {
	t.Helper()
	f := &fakeS3{objects: map[string][]byte{}, headers: map[string]http.Header{}}
	srv := httptest.NewTLSServer(http.HandlerFunc(f.handler))
	t.Cleanup(srv.Close)

	caFile := filepath.Join(t.TempDir(), "ca.pem")
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	if err := os.WriteFile(caFile, caPEM, 0o600); err != nil {
		t.Fatalf("writing CA bundle: %v", err)
	}
	t.Setenv("AWS_CA_BUNDLE", caFile)

	saved := s3Cfg
	s3Cfg = S3Config{
		Region:          "us-east-1",
		Endpoint:        srv.URL,
		AccessKeyID:     "test",
		SecretAccessKey: "test",
	}
	t.Cleanup(func() { s3Cfg = saved })

	b, err := Open(ctx, "s3://bucket/prefix")
	if err != nil {
		t.Fatalf("Open s3: %v", err)
	}
	t.Cleanup(func() { b.Close() })
	return b, f
}

func TestS3GetHit(t *testing.T) {
	b, f := setupFakeS3(t)
	f.objects["prefix/hello.txt"] = []byte("hi")

	rc, err := b.Get(ctx, "hello.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "hi" {
		t.Errorf("content = %q, want %q", got, "hi")
	}
}

func TestS3GetMissingIgnored(t *testing.T) {
	b, _ := setupFakeS3(t)
	rc, err := b.Get(ctx, "missing.txt", true)
	if err != nil || rc != nil {
		t.Errorf("Get(missing, ignoreMissing=true) = (%v, %v), want (nil, nil)", rc, err)
	}
}

func TestS3GetMissingErrors(t *testing.T) {
	b, _ := setupFakeS3(t)
	rc, err := b.Get(ctx, "missing.txt", false)
	if rc != nil {
		rc.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "missing.txt") {
		t.Errorf("err = %v, want not-found error naming the key", err)
	}
}

func TestS3PutExclusiveCreate(t *testing.T) {
	b, f := setupFakeS3(t)
	if err := b.Put(ctx, "f.txt", strings.NewReader("first"), false); err != nil {
		t.Fatalf("Put(first): %v", err)
	}
	if got := f.headers["prefix/f.txt"].Get("If-None-Match"); got != "*" {
		t.Errorf("If-None-Match = %q, want %q (exclusive-create condition)", got, "*")
	}
	err := b.Put(ctx, "f.txt", strings.NewReader("second"), false)
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("second exclusive Put = %v, want already-exists error", err)
	}
	if got := string(f.objects["prefix/f.txt"]); got != "first" {
		t.Errorf("content = %q, want untouched %q", got, "first")
	}
}

func TestS3PutOverwrite(t *testing.T) {
	b, f := setupFakeS3(t)
	for _, content := range []string{"first", "second"} {
		if err := b.Put(ctx, "f.txt", strings.NewReader(content), true); err != nil {
			t.Fatalf("Put(%q): %v", content, err)
		}
	}
	if got := f.headers["prefix/f.txt"].Get("If-None-Match"); got != "" {
		t.Errorf("If-None-Match = %q, want absent on overwrite Put", got)
	}
	if got := string(f.objects["prefix/f.txt"]); got != "second" {
		t.Errorf("content = %q, want last write %q", got, "second")
	}
}

// On S3, AtomicPut is a plain overwrite Put (a single PutObject is atomic).
func TestS3AtomicPutOverwrites(t *testing.T) {
	b, f := setupFakeS3(t)
	for _, content := range []string{"first", "second"} {
		if err := b.AtomicPut(ctx, "atomic.txt", bytes.NewBufferString(content), ObjectMeta{}); err != nil {
			t.Fatalf("AtomicPut(%q): %v", content, err)
		}
	}
	if got := string(f.objects["prefix/atomic.txt"]); got != "second" {
		t.Errorf("content = %q, want last write %q", got, "second")
	}
}

func TestS3RmExistingAndMissing(t *testing.T) {
	b, f := setupFakeS3(t)
	f.objects["prefix/f.txt"] = []byte("data")

	if err := b.Rm(ctx, "f.txt"); err != nil {
		t.Fatalf("Rm: %v", err)
	}
	rc, err := b.Get(ctx, "f.txt", true)
	if err != nil || rc != nil {
		t.Errorf("Get after Rm = (%v, %v), want (nil, nil)", rc, err)
	}
	// S3 DeleteObject is unconditional: removing a missing key must not error.
	if err := b.Rm(ctx, "f.txt"); err != nil {
		t.Errorf("Rm(missing) = %v, want nil", err)
	}
}

// The writer↔CDN cache contract rides on PutObject headers: Cache-Control is
// resolved from the LOGICAL key (before the path prefix). Content-Type, with no
// explicit ObjectMeta type, is the application/octet-stream default — SRR no
// longer derives it from the extension or sniffs the bytes (peek/process is the
// single source of truth for an asset's type; packs are opaque gzip blobs).
func TestS3PutCacheControlAndContentType(t *testing.T) {
	b, f := setupFakeS3(t)
	cases := []struct {
		key, wantCC string
	}{
		{"db.gz", cacheRevalidate},
		{"idx/0.gz", cacheImmutable},
		{"data/L3.gz", cacheImmutable},
		{"assets/ab/0123456789abcdef.jpg", cacheImmutable},
		{".locked", ""}, // no cache policy
	}
	for _, c := range cases {
		t.Run(c.key, func(t *testing.T) {
			if err := b.Put(ctx, c.key, strings.NewReader("x"), true); err != nil {
				t.Fatalf("Put: %v", err)
			}
			h := f.headers["prefix/"+c.key]
			if got := h.Get("Cache-Control"); got != c.wantCC {
				t.Errorf("Cache-Control = %q, want %q", got, c.wantCC)
			}
			if got := h.Get("Content-Type"); got != "application/octet-stream" {
				t.Errorf("Content-Type = %q, want application/octet-stream (default)", got)
			}
		})
	}
}

// AtomicPut stamps the explicit ObjectMeta Content-Type and Content-Encoding —
// the asset-peek / asset-process path that lets the operator declare an asset's
// real type and (optional) encoding.
func TestS3AtomicPutStampsObjectMeta(t *testing.T) {
	b, f := setupFakeS3(t)
	meta := ObjectMeta{ContentType: "image/webp", ContentEncoding: "gzip"}
	if err := b.AtomicPut(ctx, "assets/ab/0123456789abcdef.webp", strings.NewReader("x"), meta); err != nil {
		t.Fatalf("AtomicPut: %v", err)
	}
	h := f.headers["prefix/assets/ab/0123456789abcdef.webp"]
	if got := h.Get("Content-Type"); got != "image/webp" {
		t.Errorf("Content-Type = %q, want image/webp", got)
	}
	if got := h.Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
}

// Round-trip through the aws-chunked decode path: a *bytes.Buffer is
// non-seekable, so the SDK streams it with a trailing CRC32 — the same wire
// format production hits (db.Commit hands AtomicPut a *bytes.Buffer).
func TestS3PutGetRoundTripBody(t *testing.T) {
	b, f := setupFakeS3(t)
	payload := strings.Repeat("0123456789abcdef-", 1024) // ~17KB, multiple chunks

	if err := b.Put(ctx, "big.bin", bytes.NewBufferString(payload), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if got := string(f.objects["prefix/big.bin"]); got != payload {
		t.Fatalf("stored bytes differ: %d vs %d chars", len(got), len(payload))
	}
	rc, err := b.Get(ctx, "big.bin", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != payload {
		t.Errorf("round-trip bytes differ: %d vs %d chars", len(got), len(payload))
	}
}
