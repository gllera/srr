package store

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"encoding/xml"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"io/fs"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// fakeS3 is an in-memory S3 lookalike behind httptest. The endpoint override
// (s3Cfg.Endpoint → cfg.BaseEndpoint) plus an IP-literal host force the SDK
// into path-style addressing (/bucket/<key>), so the handler routes on the
// URL path and ignores SigV4 entirely. It honors the two protocol features
// the production code relies on: `If-None-Match: *` exclusive creates and
// `If-Match: <etag>` conditional writes (both 412 + PreconditionFailed),
// ETags on PUT and HEAD (the token S3.Version hands back), and aws-chunked PUT
// bodies (the SDK's wire format for non-seekable bodies with a trailing CRC32 —
// production streams exactly those).
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	headers map[string]http.Header // last successful PUT's request headers per key
	// undeletable keys answer DeleteObjects with a per-object <Error>, which is
	// how real S3 reports a partial failure: HTTP 200 with some keys refused.
	undeletable map[string]bool
	deleteCalls int    // DeleteObjects requests served, i.e. the batching
	noBatchVerb bool   // answer DeleteObjects 501, as a gateway lacking it does
	deleteFail  string // answer DeleteObjects with this S3 error CODE (400)
}

// s3ETag mints the fake's entity tag. Real S3 uses the content MD5 for
// single-part uploads; only the QUOTING and the "changes with the bytes"
// property matter to the code under test, both of which this reproduces.
func s3ETag(body []byte) string {
	return fmt.Sprintf(`"%x"`, sha256.Sum256(body))
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

// s3FakePage is how many keys one ListObjectsV2 response carries. Deliberately
// tiny: the production List drives an SDK paginator, and a fake that always
// answers in one page would never exercise the continuation-token loop.
const s3FakePage = 2

type s3ListEntry struct {
	Key  string `xml:"Key"`
	Size int64  `xml:"Size"`
}

type s3ListResult struct {
	XMLName     xml.Name `xml:"ListBucketResult"`
	Name        string   `xml:"Name"`
	Prefix      string   `xml:"Prefix"`
	KeyCount    int      `xml:"KeyCount"`
	MaxKeys     int      `xml:"MaxKeys"`
	IsTruncated bool     `xml:"IsTruncated"`
	NextToken   string   `xml:"NextContinuationToken,omitempty"`
	Contents    []s3ListEntry
}

// list answers ListObjectsV2: keys under `prefix`, lexicographic, resumed after
// `continuation-token` (real S3 tokens are opaque; the last key served is a
// legal choice and keeps the fake a few lines). Called with f.mu held.
func (f *fakeS3) list(w http.ResponseWriter, r *http.Request) {
	prefix := r.URL.Query().Get("prefix")
	after := r.URL.Query().Get("continuation-token")

	var keys []string
	for k := range f.objects {
		if strings.HasPrefix(k, prefix) && k > after {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)

	res := s3ListResult{Name: "bucket", Prefix: prefix, MaxKeys: s3FakePage}
	if len(keys) > s3FakePage {
		keys = keys[:s3FakePage]
		res.IsTruncated = true
		res.NextToken = keys[len(keys)-1]
	}
	for _, k := range keys {
		res.Contents = append(res.Contents, s3ListEntry{Key: k, Size: int64(len(f.objects[k]))})
	}
	res.KeyCount = len(res.Contents)

	w.Header().Set("Content-Type", "application/xml")
	xml.NewEncoder(w).Encode(res) //nolint:errcheck // test fake
}

// The DeleteObjects request/response bodies, only as far as the production
// RmBatch speaks them: a list of keys in, the refused ones back out.
type s3DeleteRequest struct {
	XMLName xml.Name `xml:"Delete"`
	Quiet   bool     `xml:"Quiet"`
	Objects []struct {
		Key string `xml:"Key"`
	} `xml:"Object"`
}

type s3DeletedKey struct {
	Key string `xml:"Key"`
}

type s3DeleteFailure struct {
	Key     string `xml:"Key"`
	Code    string `xml:"Code"`
	Message string `xml:"Message"`
}

type s3DeleteResult struct {
	XMLName xml.Name          `xml:"DeleteResult"`
	Deleted []s3DeletedKey    `xml:"Deleted"`
	Errors  []s3DeleteFailure `xml:"Error"`
}

// deleteObjects answers a POST /bucket?delete= multi-object delete: every key
// goes unless it is marked undeletable, and a refused key comes back as a
// per-object <Error> inside an otherwise successful 200 — the partial-failure
// shape S3.RmBatch must map back to logical keys. Called with f.mu held.
func (f *fakeS3) deleteObjects(w http.ResponseWriter, r *http.Request) {
	f.deleteCalls++
	if f.noBatchVerb {
		s3Error(w, http.StatusNotImplemented, "NotImplemented")
		return
	}
	if f.deleteFail != "" {
		// 400, deliberately: the SDK retryer would replay a 5xx/throttle and
		// make the test flaky. A non-retryable status is what pins the
		// whole-call-failure arm rather than the retry ladder.
		s3Error(w, http.StatusBadRequest, f.deleteFail)
		return
	}
	body, err := readPutBody(r)
	if err != nil {
		s3Error(w, http.StatusBadRequest, "MalformedBody")
		return
	}
	var req s3DeleteRequest
	if err := xml.Unmarshal(body, &req); err != nil {
		s3Error(w, http.StatusBadRequest, "MalformedXML")
		return
	}

	var res s3DeleteResult
	for _, o := range req.Objects {
		if f.undeletable[o.Key] {
			res.Errors = append(res.Errors, s3DeleteFailure{Key: o.Key, Code: "AccessDenied", Message: "Access Denied"})
			continue
		}
		// Like real S3, deleting a key that is not there is a success.
		delete(f.objects, o.Key)
		if !req.Quiet {
			res.Deleted = append(res.Deleted, s3DeletedKey{Key: o.Key})
		}
	}
	w.Header().Set("Content-Type", "application/xml")
	xml.NewEncoder(w).Encode(res) //nolint:errcheck // test fake
}

func (f *fakeS3) handler(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/bucket/")
	f.mu.Lock()
	defer f.mu.Unlock()
	// A bucket-scoped GET with list-type=2 is ListObjectsV2, not an object read.
	if r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2" {
		f.list(w, r)
		return
	}
	// A bucket-scoped POST with ?delete is the multi-object delete.
	if r.Method == http.MethodPost && r.URL.Query().Has("delete") {
		f.deleteObjects(w, r)
		return
	}
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
		existing, exists := f.objects[key]
		if r.Header.Get("If-None-Match") == "*" && exists {
			s3Error(w, http.StatusPreconditionFailed, "PreconditionFailed")
			return
		}
		if want := r.Header.Get("If-Match"); want != "" && (!exists || want != s3ETag(existing)) {
			s3Error(w, http.StatusPreconditionFailed, "PreconditionFailed")
			return
		}
		body, err := readPutBody(r)
		if err != nil {
			s3Error(w, http.StatusBadRequest, "MalformedBody")
			return
		}
		f.objects[key] = body
		f.headers[key] = r.Header.Clone()
		w.Header().Set("ETag", s3ETag(body))
	case http.MethodHead:
		body, ok := f.objects[key]
		if !ok {
			// Real S3 HEAD responses are bodyless: the SDK derives the generic
			// "NotFound" code from the bare 404 (there is no XML carrying
			// NoSuchKey to parse) — the case S3.Stat's switch must handle.
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Header().Set("ETag", s3ETag(body))
		w.WriteHeader(http.StatusOK)
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
	f := &fakeS3{
		objects:     map[string][]byte{},
		headers:     map[string]http.Header{},
		undeletable: map[string]bool{},
	}
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

	// Drop memoized clients: an ephemeral httptest port can be reused across
	// sequential tests, and a config-identical hit would hand this test the
	// previous server's client (its listener already closed).
	s3ClientsMu.Lock()
	s3Clients = map[S3Config]*s3.Client{}
	s3ClientsMu.Unlock()

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

	rc, err := b.Get(ctx, "hello.txt")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "hi" {
		t.Errorf("content = %q, want %q", got, "hi")
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
	rc, err := b.Get(ctx, "f.txt")
	if rc != nil {
		rc.Close()
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Get after Rm err = %v, want errors.Is(err, fs.ErrNotExist)", err)
	}
	// S3 DeleteObject is unconditional: removing a missing key must not error.
	if err := b.Rm(ctx, "f.txt"); err != nil {
		t.Errorf("Rm(missing) = %v, want nil", err)
	}
}

// TestS3RmBatchBatchesAndMapsPerKeyFailures is why BatchRemover exists: the GC
// sweep's thousand dead objects cost one DeleteObjects round-trip per
// s3DeleteBatch keys instead of a thousand sequential DELETEs. It pins the two
// halves the fan-out cannot give for free — the chunking, and the per-object
// error mapped back to the LOGICAL key (the response names the prefixed one).
func TestS3RmBatchBatchesAndMapsPerKeyFailures(t *testing.T) {
	b, f := setupFakeS3(t)
	saved := s3DeleteBatch
	s3DeleteBatch = 2 // 5 keys => 3 calls, without minting a thousand objects
	t.Cleanup(func() { s3DeleteBatch = saved })

	var keys []string
	for i := range 5 {
		k := fmt.Sprintf("data/%d.gz", i)
		keys = append(keys, k)
		f.objects["prefix/"+k] = []byte("x")
	}
	f.undeletable["prefix/data/3.gz"] = true

	failed, err := RmAll(ctx, b, keys, 1)
	if err == nil {
		t.Fatal("RmAll err = nil, want the refused key reported")
	}
	if want := []string{"data/3.gz"}; !slices.Equal(failed, want) {
		t.Errorf("failed = %v, want %v (logical keys, not the prefixed ones)", failed, want)
	}
	if !strings.Contains(err.Error(), "AccessDenied") || !strings.Contains(err.Error(), "data/3.gz") {
		t.Errorf("err = %v, want the key and the S3 error code", err)
	}
	if f.deleteCalls != 3 {
		t.Errorf("DeleteObjects calls = %d, want 3 (5 keys at %d per call)", f.deleteCalls, s3DeleteBatch)
	}
	for _, k := range keys {
		_, present := f.objects["prefix/"+k]
		if want := k == "data/3.gz"; present != want {
			t.Errorf("%q present = %v, want %v", k, present, want)
		}
	}

	// Re-deleting what is already gone is success: the GC deliberately re-issues
	// a trailing window of deletes to self-heal crash orphans.
	if failed, err := RmAll(ctx, b, []string{"data/0.gz", "data/1.gz"}, 1); err != nil || failed != nil {
		t.Errorf("RmAll(already gone) = (%v, %v), want (nil, nil)", failed, err)
	}
}

// An S3-COMPATIBLE endpoint that does not implement the multi-object delete
// must not cost the callers their reclamation: a wedged expiration cycle would
// never advance retention again. RmBatch falls back to one delete per key.
func TestS3RmBatchFallsBackWhenTheVerbIsUnimplemented(t *testing.T) {
	b, f := setupFakeS3(t)
	f.noBatchVerb = true
	f.objects["prefix/data/0.gz"] = []byte("x")
	f.objects["prefix/data/1.gz"] = []byte("x")

	failed, err := RmAll(ctx, b, []string{"data/0.gz", "data/1.gz"}, 2)
	if err != nil || failed != nil {
		t.Fatalf("RmAll = (%v, %v), want (nil, nil) via the per-key fallback", failed, err)
	}
	if len(f.objects) != 0 {
		t.Errorf("objects left = %v, want everything deleted one by one", slices.Sorted(maps.Keys(f.objects)))
	}
}

// The whole-call-failure arm: the batch verb itself fails, so NOTHING in the
// chunk was deleted. It is the arm that tells the GC a generation was NOT
// cleared, and it had no test — the fake could refuse individual objects and
// decline the verb, but never fail the call.
//
// The stakes are not the GC (its list shape re-derives orphans every run, so it
// self-heals). They are expiration: ExpireArticles applies its refcount
// decrements only on a nil error, so a swallowed whole-call failure permanently
// under-counts assets that are still present in the store.
func TestS3RmBatchReportsAWholeCallFailure(t *testing.T) {
	for _, code := range []string{"InvalidRequest", s3ErrUnauthorized} {
		t.Run(code, func(t *testing.T) {
			b, f := setupFakeS3(t)
			f.deleteFail = code
			keys := []string{"data/0.gz", "data/1.gz", "data/2.gz"}
			for _, k := range keys {
				f.objects["prefix/"+k] = []byte("x")
			}

			failed, err := RmAll(ctx, b, keys, 1)
			if err == nil {
				t.Fatal("RmAll err = nil; a failed batch verb deleted nothing and must say so")
			}
			// EVERY key, not one representative: `failed` is "still in the store",
			// and a caller subtracting it to derive successes would otherwise
			// count two deletions that never happened.
			slices.Sort(failed)
			if !slices.Equal(failed, keys) {
				t.Errorf("failed = %v, want every key %v", failed, keys)
			}
			for _, k := range keys {
				if _, present := f.objects["prefix/"+k]; !present {
					t.Errorf("%q was deleted despite the batch call failing", k)
				}
			}
			if code == s3ErrUnauthorized && !strings.Contains(err.Error(), "unauthorized access to s3") {
				t.Errorf("err = %v, want the unauthorized classification", err)
			}
		})
	}
}

// The writer↔CDN contract rides on PutObject headers, both resolved from the
// LOGICAL key (before the path prefix): Cache-Control via cacheControlForKey,
// and — with no explicit ObjectMeta type — Content-Type via contentTypeForKey
// (SRR's own gzip objects declare application/gzip; anything else keeps the
// application/octet-stream default — never derived from the extension or by
// sniffing the bytes). Pack writes must never stamp Content-Encoding: the
// reader gunzips manually, so a transparently-decompressing CDN would break it.
func TestS3PutCacheControlAndContentType(t *testing.T) {
	b, f := setupFakeS3(t)
	cases := []struct {
		key, wantCC, wantCT string
	}{
		{"db.gz", cacheRevalidate, "application/gzip"},
		{"idx/0.gz", cacheImmutable, "application/gzip"},
		{"data/3.gz", cacheImmutable, "application/gzip"},
		{"seen/4.gz", cacheImmutable, "application/gzip"},
		{"assets/ab/0123456789abcdef.jpg", cacheImmutable, "application/octet-stream"},
		{".locked", "", "application/octet-stream"}, // no cache policy, no key-derived type
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
			if got := h.Get("Content-Type"); got != c.wantCT {
				t.Errorf("Content-Type = %q, want %q", got, c.wantCT)
			}
			// The SDK frames checksum-trailer uploads as aws-chunked on the
			// wire; S3 strips that token from the stored metadata. Nothing
			// else may ride the header.
			for tok := range strings.SplitSeq(h.Get("Content-Encoding"), ",") {
				if tok = strings.TrimSpace(tok); tok != "" && tok != "aws-chunked" {
					t.Errorf("Content-Encoding carries %q, want none", tok)
				}
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
	rc, err := b.Get(ctx, "big.bin")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != payload {
		t.Errorf("round-trip bytes differ: %d vs %d chars", len(got), len(payload))
	}
}

func TestS3Stat(t *testing.T) {
	b, f := setupFakeS3(t)
	f.objects["prefix/obj.bin"] = []byte("12345")

	if n, err := b.Stat(ctx, "obj.bin"); err != nil || n != 5 {
		t.Errorf("Stat = (%d, %v), want (5, nil)", n, err)
	}
	// A missing key is an fs.ErrNotExist-wrapped error, never a silent
	// zero — a nil error from Stat has to PROVE presence. Pinned for all
	// four backends at once in TestBackendMissingKeyConformance; kept here
	// so a single-backend edit trips its own test too.
	if _, err := b.Stat(ctx, "missing.bin"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Stat(missing) err = %v, want errors.Is(err, fs.ErrNotExist)", err)
	}
}

// TestS3ClientMemoPerConfig pins the client-memo contract: two Opens under
// one config share a single SDK client (the serve loop's per-cycle Open must
// not rebuild transport/credentials), while a different config keys its own.
func TestS3ClientMemoPerConfig(t *testing.T) {
	b1, _ := setupFakeS3(t)
	b2, err := Open(ctx, "s3://otherbucket/otherprefix")
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	if b1.(*S3).client != b2.(*S3).client {
		t.Fatal("same config: expected the memoized client to be shared across Opens")
	}

	other := s3Cfg
	other.Region = "eu-west-1"
	c2, err := s3ClientFor(ctx, other)
	if err != nil {
		t.Fatalf("s3ClientFor(other): %v", err)
	}
	if c2 == b1.(*S3).client {
		t.Fatal("different config: expected a distinct client, got the memoized one")
	}
}
