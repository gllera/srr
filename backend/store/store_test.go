package store

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

var ctx = context.Background()

func setupLocalStore(t *testing.T) (Backend, string) {
	t.Helper()
	dir := t.TempDir()
	b, err := Open(ctx, dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { b.Close() })
	return b, dir
}

func TestLocalRmNonExistent(t *testing.T) {
	b, _ := setupLocalStore(t)
	if err := b.Rm(ctx, "nonexistent.txt"); err != nil {
		t.Errorf("Rm(nonexistent) = %v, want nil", err)
	}
}

func readAllClose(t *testing.T, rc io.ReadCloser) string {
	t.Helper()
	if rc == nil {
		return ""
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return string(data)
}

func TestLocalPutCreatesSubdirectories(t *testing.T) {
	b, dir := setupLocalStore(t)

	if err := b.Put(ctx, "sub/dir/file.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rc, err := b.Get(ctx, "sub/dir/file.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
	if _, err := os.Stat(filepath.Join(dir, "sub", "dir")); os.IsNotExist(err) {
		t.Error("subdirectories should have been auto-created")
	}
}

func TestLocalPutExclusiveCreateReturnsError(t *testing.T) {
	b, _ := setupLocalStore(t)

	if err := b.Put(ctx, "file.txt", strings.NewReader("first"), false); err != nil {
		t.Fatalf("Put(first): %v", err)
	}
	if err := b.Put(ctx, "file.txt", strings.NewReader("second"), false); err == nil {
		t.Error("Put(ignoreExisting=false) on existing file should fail")
	}
}

func TestLocalAtomicPutNoTempFileRemains(t *testing.T) {
	b, dir := setupLocalStore(t)

	if err := b.AtomicPut(ctx, "atomic.txt", strings.NewReader("content"), ObjectMeta{}); err != nil {
		t.Fatalf("AtomicPut: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "atomic.txt.tmp")); !os.IsNotExist(err) {
		t.Error("temp file should not remain after AtomicPut")
	}
	rc, _ := b.Get(ctx, "atomic.txt", false)
	if got := readAllClose(t, rc); got != "content" {
		t.Errorf("content = %q, want %q", got, "content")
	}
}

// TestLocalAtomicPutFailureRemovesTempFile mirrors the SFTP backend's cleanup
// guarantee: a failed AtomicPut (here a failing reader) must not leave the
// uniqueTempName(<key>) staging file behind — otherwise a recurring failure
// (e.g. a full disk hit every serve --interval cycle) accumulates orphans.
func TestLocalAtomicPutFailureRemovesTempFile(t *testing.T) {
	b, dir := setupLocalStore(t)
	wantErr := errors.New("injected read failure")
	if err := b.AtomicPut(ctx, "atomic.txt", iotest.ErrReader(wantErr), ObjectMeta{}); err == nil {
		t.Fatal("AtomicPut with a failing reader should return an error")
	}
	// uniqueTempName appends .tmp.<pid>.<counter>, so glob rather than a fixed name.
	matches, _ := filepath.Glob(filepath.Join(dir, "atomic.txt.tmp.*"))
	if len(matches) != 0 {
		t.Errorf("temp file(s) leaked after failed AtomicPut: %v", matches)
	}
	if _, err := os.Stat(filepath.Join(dir, "atomic.txt")); !os.IsNotExist(err) {
		t.Error("destination file should not exist after a failed AtomicPut")
	}
}

// AtomicPut sweeps uniqueTempName leftovers a hard-killed predecessor stranded
// in the target's directory (its rename never ran, and the per-process unique
// name means nothing would ever overwrite or GC them): stale ones (older than
// tempSweepMaxAge) are removed, while a fresh one — potentially another live
// writer's in-flight staging file — is kept by the age gate.
func TestLocalAtomicPutSweepsStaleTempLeftovers(t *testing.T) {
	b, dir := setupLocalStore(t)
	stale := filepath.Join(dir, "db.gz.tmp.99999.1")
	fresh := filepath.Join(dir, "db.gz.tmp.99999.2")
	for _, f := range []string{stale, fresh} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-tempSweepMaxAge - time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	// A write to a DIFFERENT key in the same directory triggers the sweep —
	// leftovers heal on any sibling write, not only a rewrite of their own key.
	if err := b.AtomicPut(ctx, "other.txt", strings.NewReader("content"), ObjectMeta{}); err != nil {
		t.Fatalf("AtomicPut: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale temp leftover survived the sweep (err=%v), want removed", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("fresh temp file swept (err=%v), want kept by the age gate", err)
	}
}

// The sweep's age gate must compare two readings of ONE clock. staleTemp takes
// the store's own "now" — the caller's just-created staging file's mtime, read
// from the same directory listing — precisely because an NFS-mounted local
// store or an SFTP server can stamp mtimes from a clock that differs
// arbitrarily from this host's, and asset uploads run concurrently inside a
// single process, so two live staging files in one directory need no second
// writer at all. A store clock running >24h behind us would otherwise make
// every in-flight temp look ancient and get it deleted mid-write.
func TestStaleTempUsesOneClock(t *testing.T) {
	now := time.Now()
	if staleTemp(now.Add(-time.Minute), now) {
		t.Error("a fresh temp is stale; want kept")
	}
	if !staleTemp(now.Add(-tempSweepMaxAge-time.Minute), now) {
		t.Error("an aged temp is not stale; want swept")
	}
	// The store's clock reads 48h behind this host's: a temp created "now" by
	// the store's reckoning must not look 48h old.
	skewed := now.Add(-48 * time.Hour)
	if staleTemp(skewed, skewed) {
		t.Error("clock skew made an in-flight temp look stale; want kept")
	}
	// Unknown age must never mean "delete". Note pkg/sftp reports a missing
	// mtime as the Unix EPOCH, not Go's zero time, so IsZero does not catch it
	// — what saves us is that such a server stamps the reference file the same
	// way, making the difference 0. Both encodings are pinned here.
	if staleTemp(time.Time{}, now) {
		t.Error("a zero mtime was swept; want kept")
	}
	epoch := time.Unix(0, 0)
	if staleTemp(epoch, epoch) {
		t.Error("an epoch mtime measured against an epoch reference was swept; want kept")
	}
}

// isTempLeftover must match exactly the uniqueTempName grammar
// (<base>.tmp.<pid>.<n>) so the sweep can never touch a user file that merely
// contains ".tmp.".
func TestIsTempLeftover(t *testing.T) {
	for name, want := range map[string]bool{
		"db.gz.tmp.123.4":       true,
		"frontend.js.tmp.1.999": true,
		"db.gz.tmp":             false,
		"db.gz.tmp.123":         false,
		"db.gz.tmp.12a.3":       false,
		"db.gz.tmp..3":          false,
		"db.gz.tmp.3.":          false,
		"notes.tmp.backup":      false,
		"db.gz":                 false,
	} {
		if got := isTempLeftover(name); got != want {
			t.Errorf("isTempLeftover(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestLocalGetMissingIgnored(t *testing.T) {
	b, _ := setupLocalStore(t)

	rc, err := b.Get(ctx, "missing.txt", true)
	if err != nil || rc != nil {
		t.Errorf("Get(missing, ignoreMissing=true) = (%v, %v), want (nil, nil)", rc, err)
	}
}

func TestLocalGetMissingErrors(t *testing.T) {
	b, _ := setupLocalStore(t)

	rc, err := b.Get(ctx, "missing.txt", false)
	if rc != nil {
		rc.Close()
	}
	if err == nil {
		t.Error("Get(missing, ignoreMissing=false) should return error")
	}
}

func TestOpenUnsupportedScheme(t *testing.T) {
	_, err := Open(ctx, "ftp://example.com/path")
	if err == nil {
		t.Error("Open with unsupported scheme should return error")
	}
}

// The writer↔CDN cache contract: finalized packs are immutable and may be
// cached forever; db.gz and the toggled latest packs are rewritten every fetch
// and must always revalidate (a stale db.gz misroutes the reader to the wrong
// latest pack). Keys with no policy return "".
func TestCacheControlForKey(t *testing.T) {
	cases := []struct {
		key, want string
	}{
		{"db.gz", cacheRevalidate},
		{"idx/0.gz", cacheImmutable},
		{"idx/12.gz", cacheImmutable},
		{"data/1.gz", cacheImmutable},
		{"data/250.gz", cacheImmutable},
		{"idx/L1.gz", cacheImmutable},
		{"idx/L0.gz", cacheImmutable},
		{"data/L7.gz", cacheImmutable},
		{"meta/0.gz", cacheImmutable},
		{"meta/L3.gz", cacheImmutable},
		{"idx/h2.gz", cacheImmutable},
		{"meta/s4.gz", cacheImmutable},
		{"assets/ab/0123456789abcdef.jpg", cacheImmutable},
		{"idx/L.gz", ""},
		{"data/Lx7.gz", ""},
		{"data/LL3.gz", ""},
		{"data/h3.gz", ""},
		{"idx/s3.gz", ""},
		{"meta/h3.gz", ""},
		{"search/0.gz", ""},
		{"search/L3.gz", ""},
		{"search/s4.gz", ""},
		{"L1.gz", ""},
		{"idx/true.gz", ""},
		{"data/false.gz", ""},
		{"idx/sub/3.gz", ""},
		{".locked", ""},
		{"unknown.txt", ""},
		// out/* is the one documented mutable class besides db.gz: revalidate.
		{"out/myfeed.rss", cacheRevalidate},
		{"out/myfeed.json", cacheRevalidate},
		{"out/nested/feed.rss", cacheRevalidate},
		// out/ must NOT match packKeyRe (not immutable).
		{"out/0.gz", cacheRevalidate},
		// The seen.gz dedup sidecar is a third mutable class, rewritten every
		// non-idle fetch cycle — revalidate if a CDN ever fronts it. SyncSeen
		// writes the two ping/pong slots; the bare name is the legacy fallback.
		{"seen.0.gz", cacheRevalidate},
		{"seen.1.gz", cacheRevalidate},
		{"seen.gz", cacheRevalidate},
	}
	for _, c := range cases {
		if got := cacheControlForKey(c.key); got != c.want {
			t.Errorf("cacheControlForKey(%q) = %q, want %q", c.key, got, c.want)
		}
	}
}

// Frontend files live at the store root (next to db.gz), uploaded by
// `srr frontend update`. The mutable entry point + manifests must revalidate;
// content-hashed assets are write-once and may be cached forever. Only affects
// S3 (local/SFTP ignore ObjectMeta).
func TestCacheControlForKeyFrontend(t *testing.T) {
	cases := []struct {
		key, want string
	}{
		// Mutable root files: revalidate.
		{"index.html", cacheRevalidate},
		{"manifest.webmanifest", cacheRevalidate},
		{"sitemap.txt", cacheRevalidate},
		// Content-hashed root assets: immutable.
		{"frontend.5730a221.css", cacheImmutable},
		{"frontend.778222e7.js", cacheImmutable},
		{"sw.57d1d92e.js", cacheImmutable},
		{"icon.aea4e164.svg", cacheImmutable},
		{"icon-192.936dab90.png", cacheImmutable},
		{"apple-touch-icon.bcdd2574.png", cacheImmutable},
		// Not a hash (too short / non-hex) → no policy.
		{"frontend.css", ""},
		{"app.1234.js", ""},
		// Only sitemap.txt is special; a generic root .txt gets no policy.
		{"readme.txt", ""},
	}
	for _, c := range cases {
		if got := cacheControlForKey(c.key); got != c.want {
			t.Errorf("cacheControlForKey(%q) = %q, want %q", c.key, got, c.want)
		}
	}
}

// SRR's own gzip objects — db.gz and every pack-grammar name — declare
// application/gzip when the caller sets no explicit ObjectMeta type. Nothing
// else gets a key-derived type: assets are typed by peek/process alone, and
// unknown keys fall to the backend's octet-stream default. There is
// deliberately no encoding counterpart — packs must never carry
// Content-Encoding (the reader gunzips manually via DecompressionStream).
func TestContentTypeForKey(t *testing.T) {
	cases := []struct{ key, want string }{
		{"db.gz", contentTypeGzip},
		{"seen.0.gz", contentTypeGzip}, // ping/pong dedup slot — one of SRR's own gzip objects
		{"seen.1.gz", contentTypeGzip},
		{"seen.gz", contentTypeGzip}, // legacy fallback name
		{"idx/0.gz", contentTypeGzip},
		{"idx/L1.gz", contentTypeGzip},
		{"idx/h2.gz", contentTypeGzip},
		{"data/250.gz", contentTypeGzip},
		{"data/L7.gz", contentTypeGzip},
		{"meta/0.gz", contentTypeGzip},
		{"meta/L3.gz", contentTypeGzip},
		{"meta/s4.gz", contentTypeGzip},
		// Not pack names: kind letter owned by another series / malformed stems.
		{"data/h3.gz", ""},
		{"idx/s3.gz", ""},
		{"idx/L.gz", ""},
		{"L1.gz", ""},
		{"idx/sub/3.gz", ""},
		// Assets: peek/process is the single source of truth — no key-derived type.
		{"assets/ab/0123456789abcdef.jpg", ""},
		// Non-gzip object classes.
		{"out/myfeed.rss", ""},
		{".locked", ""},
		{"index.html", ""},
		{"unknown.txt", ""},
	}
	for _, c := range cases {
		if got := contentTypeForKey(c.key); got != c.want {
			t.Errorf("contentTypeForKey(%q) = %q, want %q", c.key, got, c.want)
		}
	}
}

func TestLoadEnvBoolParsing(t *testing.T) {
	type testConfig struct {
		Enabled bool `yaml:"enabled"`
	}

	tests := []struct {
		envVal string
		want   bool
	}{
		{"true", true},
		{"1", true},
		{"false", false},
		{"0", false},
		{"yes", false},
	}

	for _, tt := range tests {
		t.Run(tt.envVal, func(t *testing.T) {
			cfg := &testConfig{}
			t.Setenv("SRR_TEST_ENABLED", tt.envVal)
			loadEnv("test", cfg)
			if cfg.Enabled != tt.want {
				t.Errorf("loadEnv(%q) → Enabled = %v, want %v", tt.envVal, cfg.Enabled, tt.want)
			}
		})
	}
}

func TestLoadEnvStringOverride(t *testing.T) {
	type testConfig struct {
		Region string `yaml:"region"`
	}

	cfg := &testConfig{Region: "default"}
	t.Setenv("SRR_TEST_REGION", "us-west-2")
	loadEnv("test", cfg)
	if cfg.Region != "us-west-2" {
		t.Errorf("Region = %q, want %q", cfg.Region, "us-west-2")
	}
}

func TestLoadEnvNoOverrideWhenUnset(t *testing.T) {
	type testConfig struct {
		Region string `yaml:"region"`
	}

	cfg := &testConfig{Region: "original"}
	loadEnv("test", cfg)
	if cfg.Region != "original" {
		t.Errorf("Region = %q, want %q (unmodified)", cfg.Region, "original")
	}
}

func TestLoadEnvHyphenatedTag(t *testing.T) {
	type testConfig struct {
		AccessKey string `yaml:"access-key"`
	}

	cfg := &testConfig{}
	t.Setenv("SRR_TEST_ACCESS_KEY", "mykey")
	loadEnv("test", cfg)
	if cfg.AccessKey != "mykey" {
		t.Errorf("AccessKey = %q, want %q", cfg.AccessKey, "mykey")
	}
}

func TestLoadEnvIntOverride(t *testing.T) {
	type testConfig struct {
		Port int `yaml:"port"`
	}

	cfg := &testConfig{Port: 22}
	t.Setenv("SRR_TEST_PORT", "2222")
	if err := loadEnv("test", cfg); err != nil {
		t.Fatalf("loadEnv: %v", err)
	}
	if cfg.Port != 2222 {
		t.Errorf("Port = %d, want 2222", cfg.Port)
	}
}

func TestLoadEnvBadIntErrors(t *testing.T) {
	type testConfig struct {
		Port int `yaml:"port"`
	}

	cfg := &testConfig{Port: 22}
	t.Setenv("SRR_TEST_PORT", "not-a-number")
	if err := loadEnv("test", cfg); err == nil {
		t.Fatal("loadEnv: want error for unparseable int, got nil")
	}
	if cfg.Port != 22 {
		t.Errorf("Port = %d, want 22 (unchanged on error)", cfg.Port)
	}
}

func TestEnvName(t *testing.T) {
	// EnvName is the single source of truth for the backend env-override grammar:
	// loadEnv reads this name and `srr config` prints it, so this pins both.
	type cfg struct {
		Region    string `yaml:"region"`
		AccessKey string `yaml:"access-key-id"`
		Inline    string `yaml:"endpoint,omitempty"` // option after the tag is dropped
		NoTag     string ``
	}
	tt := reflect.TypeOf(cfg{})
	cases := []struct {
		field int
		want  string
	}{
		{0, "SRR_S3_REGION"},
		{1, "SRR_S3_ACCESS_KEY_ID"},
		{2, "SRR_S3_ENDPOINT"},
		{3, ""}, // no yaml tag → no derived env name
	}
	for _, c := range cases {
		if got := EnvName("s3", tt.Field(c.field)); got != c.want {
			t.Errorf("EnvName(s3, %s) = %q, want %q", tt.Field(c.field).Name, got, c.want)
		}
	}
}

// A map[string]string field parses the comma-separated "Name: value" env
// encoding (split on the FIRST colon per entry), replacing the YAML map whole.
func TestLoadEnvHeadersMap(t *testing.T) {
	type testConfig struct {
		Headers map[string]string `yaml:"headers"`
	}

	cfg := &testConfig{Headers: map[string]string{"Old": "gone"}}
	t.Setenv("SRR_TEST_HEADERS", "CF-Access-Client-Id: abc, X-Url: http://h:8080/x")
	if err := loadEnv("test", cfg); err != nil {
		t.Fatalf("loadEnv: %v", err)
	}
	want := map[string]string{"CF-Access-Client-Id": "abc", "X-Url": "http://h:8080/x"}
	if !reflect.DeepEqual(cfg.Headers, want) {
		t.Errorf("Headers = %#v, want %#v", cfg.Headers, want)
	}
}

func TestLoadEnvHeadersMapMalformed(t *testing.T) {
	type testConfig struct {
		Headers map[string]string `yaml:"headers"`
	}

	for _, bad := range []string{"no-colon-here", ": novalue"} {
		cfg := &testConfig{}
		t.Setenv("SRR_TEST_HEADERS", bad)
		if err := loadEnv("test", cfg); err == nil {
			t.Errorf("loadEnv(%q): want error for malformed entry", bad)
		}
	}
}

func TestLoadEnvUnsupportedKindErrors(t *testing.T) {
	// A field kind loadEnv can't apply must error when an override is present,
	// rather than silently leaving it un-overridable (the "env beats YAML"
	// invariant). float64 is not a supported kind.
	type testConfig struct {
		Ratio float64 `yaml:"ratio"`
	}

	cfg := &testConfig{}
	t.Setenv("SRR_TEST_RATIO", "1.5")
	if err := loadEnv("test", cfg); err == nil {
		t.Fatal("loadEnv: want error for unsupported field kind, got nil")
	}
}

// snapshotConfigs saves and restores the package-global backend config structs
// LoadConfigs decodes into (it operates on the shared registry, so a test that
// calls it mutates s3Cfg/httpCfg for real).
func snapshotConfigs(t *testing.T) {
	t.Helper()
	s3Orig, httpOrig := s3Cfg, httpCfg
	t.Cleanup(func() { s3Cfg, httpCfg = s3Orig, httpOrig })
}

// LoadConfigs is the single YAML decoder for every backend section: a valid s3/
// http section decodes into its registered struct.
func TestLoadConfigsDecodesSections(t *testing.T) {
	snapshotConfigs(t)
	s3Cfg, httpCfg = S3Config{}, HTTPConfig{}
	yaml := "s3:\n  region: eu-central-1\n  endpoint: https://s3.example.com\n" +
		"http:\n  token: sekrit\n  insecure: true\n"
	if err := LoadConfigs([]byte(yaml)); err != nil {
		t.Fatalf("LoadConfigs: %v", err)
	}
	if s3Cfg.Region != "eu-central-1" || s3Cfg.Endpoint != "https://s3.example.com" {
		t.Errorf("s3Cfg = %+v, want region/endpoint decoded", s3Cfg)
	}
	if httpCfg.Token != "sekrit" || !httpCfg.Insecure {
		t.Errorf("httpCfg = %+v, want token/insecure decoded", httpCfg)
	}
}

// A misspelled/unknown key is a hard error (the strict KnownFields contract),
// not silently dropped.
func TestLoadConfigsUnknownKeyErrors(t *testing.T) {
	snapshotConfigs(t)
	if err := LoadConfigs([]byte("s3:\n  endpont: https://x\n")); err == nil {
		t.Error("LoadConfigs: want error for an unknown key, got nil")
	}
}

func TestLoadConfigsMalformedYAMLErrors(t *testing.T) {
	snapshotConfigs(t)
	// An unterminated flow mapping is a YAML syntax error.
	if err := LoadConfigs([]byte("s3: {region: eu\n")); err == nil {
		t.Error("LoadConfigs: want error for malformed YAML, got nil")
	}
}

func TestLoadConfigsEmptyAllowed(t *testing.T) {
	snapshotConfigs(t)
	for _, data := range [][]byte{nil, []byte(""), []byte("   \n")} {
		if err := LoadConfigs(data); err != nil {
			t.Errorf("LoadConfigs(%q) = %v, want nil (empty input allowed)", data, err)
		}
	}
}

// An env override applies through LoadConfigs end-to-end, even with the YAML
// section absent (env beats YAML).
func TestLoadConfigsEnvOverride(t *testing.T) {
	snapshotConfigs(t)
	s3Cfg = S3Config{}
	t.Setenv("SRR_S3_REGION", "us-west-2")
	if err := LoadConfigs([]byte("http:\n  token: t\n")); err != nil {
		t.Fatalf("LoadConfigs: %v", err)
	}
	if s3Cfg.Region != "us-west-2" {
		t.Errorf("s3Cfg.Region = %q, want us-west-2 (env override through LoadConfigs)", s3Cfg.Region)
	}
}
