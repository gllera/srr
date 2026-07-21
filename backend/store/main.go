package store

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	// cacheImmutable stamps write-once keys: finalized packs (idx|data|
	// meta/<n>.gz) never change once written; latest packs (L<seq>) and the
	// summaries (idx/h<N>, meta/s<N>) are write-once names — never rewritten
	// after the db.gz commit that publishes them; assets/ keys are
	// content-hashed. The CDN/client may cache them all forever.
	cacheImmutable = "public, max-age=31536000, immutable"
	// cacheRevalidate stamps db.gz: the store's only mutable key (the
	// consistency root naming the current L<seq> generation), rewritten every
	// fetch. Must-revalidate forces a conditional request every load.
	cacheRevalidate = "no-cache, must-revalidate"
)

// PackSeries is the write-once pack-name grammar, one row per pack series:
// the directory plus the kind letters a stem may carry in front of the digit
// run — none (finalized "idx/12.gz"), "L"<seq> latest generations
// ("data/L3.gz", all series), "h"<N> idx header summaries ("idx/h2.gz"),
// "s"<N> meta bloom summaries ("meta/s4.gz"), "d"<seq> delta segments
// ("data/d7.gz" — one dirty cycle's article batch as data-pack JSONL, data
// series only). Single source of truth for both sides of the contract:
// packKeyRe below and the service worker's RE_PACK/parsePackName (via
// `srr gen-ts` → format.gen.ts PACK_SERIES_KINDS) are built from it.
// The "db" series carries only bare stems: db/<tailGen>.gz, the write-once
// db.gz snapshot each consolidation cycle publishes (the pointer-state backup —
// the packs survive anything, db.gz is the one object whose loss costs manual
// reconstruction). Listing it here is what stamps those snapshots immutable and
// application/gzip. The frontend/service-worker never fetch them; the SW's
// route regex simply gains an inert series.
var PackSeries = []struct {
	Name  string // series directory
	Kinds string // kind letters valid besides the finalized bare stem ("" = bare only)
}{
	{"idx", "Lh"},
	{"data", "Ld"},
	{"meta", "Ls"},
	{"db", ""},
}

// packKeyRe matches the write-once pack names, built from PackSeries.
// Anchored strictly — "L", "Lx7" or "LL3" must not be stamped immutable, and
// a kind letter another series owns ("data/h3.gz") is not a pack name.
var packKeyRe = func() *regexp.Regexp {
	alts := make([]string, len(PackSeries))
	for i, s := range PackSeries {
		// A kind-less series takes no character class at all: "[]?" is not a
		// valid empty class, it would swallow the following "]" and mangle the
		// alternation.
		if s.Kinds == "" {
			alts[i] = s.Name + "/"
			continue
		}
		alts[i] = s.Name + "/[" + s.Kinds + "]?"
	}
	return regexp.MustCompile(`^(?:` + strings.Join(alts, "|") + `)[0-9]+\.gz$`)
}()

// feHashedRe matches a content-hashed frontend asset at the store root —
// "<name>.<8+ hex>.<ext>" with no path separator. Parcel emits such names
// (frontend.5730a221.css, sw.57d1d92e.js, icon-192.936dab90.png); the hash
// changes per build, so the bytes are write-once and may be cached forever.
// Anchored and slash-free so it never matches a pack key (idx/0.gz) or db.gz.
var feHashedRe = regexp.MustCompile(`^[^/]+\.[0-9a-f]{8,}\.[a-z0-9]+$`)

// isSeenObject reports whether key is one of the seen.gz sidecar objects: the
// two ping/pong slots (seen.0.gz / seen.1.gz) that SyncSeen actually writes, or
// the pre-ping-pong legacy name (seen.gz, still read as an upgrade fallback).
// All are mutable, are SRR's own gzip, and must carry the same
// Cache-Control/Content-Type as db.gz.
func isSeenObject(key string) bool {
	return key == "seen.gz" || key == "seen.0.gz" || key == "seen.1.gz"
}

// cacheControlForKey returns the HTTP Cache-Control directive a backend should
// attach when writing key, or "" for keys with no caching policy (e.g. the
// lock marker). Backends that carry HTTP metadata (S3) emit it; filesystem
// backends ignore it. Centralised here so writer and the contract stay in one
// place.
func cacheControlForKey(key string) string {
	switch {
	case key == "db.gz" || isSeenObject(key):
		// The seen.gz sidecar (backend-only persistent dedup + validators + bg) is
		// a third mutable class besides db.gz and out/, written as two ping/pong
		// slots (seen.0.gz/seen.1.gz; bare seen.gz is the legacy upgrade name),
		// rewritten every non-idle fetch cycle. The reader never fetches it, but
		// if a CDN ever serves it, never cache a stale copy.
		return cacheRevalidate
	case strings.HasPrefix(key, "inbox/"):
		// A producer's fetch spool (docs/INBOX-SPEC.md): transient and rewritten
		// each producer cycle, deliberately NOT in PackSeries — never immutable,
		// never reader-fetched. A cached copy would let the consolidator drain a
		// spool the producer has already replaced.
		return cacheRevalidate
	case strings.HasPrefix(key, "out/"):
		// out/* is the one mutable object class besides db.gz: an output
		// syndication feed (out/<name>.rss or out/<name>.json) is overwritten
		// on every fetch cycle. Must-revalidate so clients always see the
		// latest window. Not in PackSeries/packKeyRe — NOT immutable.
		return cacheRevalidate
	case key == "index.html" || key == "manifest.webmanifest" || key == "sitemap.txt":
		// The self-hosted frontend's mutable root files (`srr frontend update`):
		// the SPA entry point, its manifest, and the sitemap manifest are
		// rewritten on every upgrade, so revalidate.
		return cacheRevalidate
	case strings.HasPrefix(key, "assets/") || packKeyRe.MatchString(key) || feHashedRe.MatchString(key):
		return cacheImmutable
	default:
		return ""
	}
}

// contentTypeGzip is the Content-Type of SRR's own gzip object classes (RFC
// 6713): db.gz and every pack-grammar name. It describes the bytes on the
// wire — the reader decompresses packs itself (DecompressionStream in
// data.ts), so these objects must NEVER carry `Content-Encoding: gzip`: a
// transparently-decompressing CDN/browser would hand the reader already-
// inflated bytes and break every deployed client.
const contentTypeGzip = "application/gzip"

// contentTypeForKey returns the Content-Type a backend should attach when
// writing key with no explicit ObjectMeta type, or "" for keys with no
// key-derived type (assets are typed by peek/process alone — never by
// extension or byte-sniffing; unknown keys fall to the backend's
// application/octet-stream default). This is grammar classification of SRR's
// own key classes, not extension guessing: a pack key's .gz is truthful by
// construction. Centralised next to cacheControlForKey so the writer↔CDN
// contract stays in one place.
func contentTypeForKey(key string) string {
	if key == "db.gz" || isSeenObject(key) || strings.HasPrefix(key, "inbox/") || packKeyRe.MatchString(key) {
		return contentTypeGzip
	}
	return ""
}

// Backend defines the storage operations used by the application.
type Backend interface {
	Get(ctx context.Context, key string, ignoreMissing bool) (io.ReadCloser, error)
	// Stat returns the stored size of key in bytes without reading the body
	// (filesystem stat, S3 HeadObject, HTTP HEAD). A missing key is (0, nil) —
	// silent like Rm: the caller (expiration's per-feed asset-bytes accounting)
	// treats absent as zero, and a retried expire cycle re-stats keys an
	// aborted predecessor already deleted.
	Stat(ctx context.Context, key string) (int64, error)
	Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error
	// AtomicPut writes via temp-then-rename (local/SFTP) or overwrite (S3). meta
	// carries optional response metadata (Content-Type / Content-Encoding) — used
	// by backends that store it (S3); ignored by backends whose headers come from
	// a static server at request time (local/SFTP).
	AtomicPut(ctx context.Context, key string, r io.Reader, meta ObjectMeta) error
	Rm(ctx context.Context, key string) error
	Close() error
}

// ObjectMeta is optional response metadata for a stored object. Backends that
// persist it (S3) stamp these headers; backends whose headers are the static
// server's at request time (local/SFTP) ignore them. An empty ContentType means
// the default (S3 stamps application/octet-stream); an empty ContentEncoding is
// omitted (no Content-Encoding header).
type ObjectMeta struct {
	ContentType     string
	ContentEncoding string
}

// InitFunc builds a backend for an output URL.
type InitFunc func(context.Context, *url.URL) (Backend, error)

var registry = map[string]InitFunc{}
var configs = map[string]any{}

// Register registers a built-in backend available by URL scheme.
func Register(scheme string, init InitFunc) {
	if init == nil {
		panic("db: cannot register nil backend init")
	}

	if _, exists := registry[scheme]; exists {
		panic(fmt.Sprintf("db: backend already registered for scheme %q", scheme))
	}
	registry[scheme] = init
}

// RegisterConfig registers a config struct pointer for a backend scheme.
func RegisterConfig(scheme string, cfg any) {
	configs[scheme] = cfg
}

// LoadConfigs decodes YAML config bytes and unmarshals backend-specific
// sections into registered config structs. Empty input is allowed; env
// var overrides still apply.
func LoadConfigs(data []byte) error {
	if len(data) > 0 {
		var raw map[string]yaml.Node
		if err := yaml.Unmarshal(data, &raw); err != nil {
			return fmt.Errorf("parsing config: %w", err)
		}
		for scheme, cfg := range configs {
			if node, ok := raw[scheme]; ok {
				// Decode strictly so a misspelled/unknown key (e.g. "endpont:")
				// is a hard error rather than silently dropped — matching the
				// loud-on-unknown-key philosophy elsewhere (mod Params.only,
				// loadEnv's unsupported-kind error). yaml.Node.Decode has no
				// KnownFields knob, so round-trip the node through a strict Decoder.
				buf, err := yaml.Marshal(&node)
				if err != nil {
					return fmt.Errorf("encoding %q config: %w", scheme, err)
				}
				dec := yaml.NewDecoder(bytes.NewReader(buf))
				dec.KnownFields(true)
				if err := dec.Decode(cfg); err != nil {
					return fmt.Errorf("decoding %q config: %w", scheme, err)
				}
			}
		}
	}

	for scheme, cfg := range configs {
		if err := loadEnv(scheme, cfg); err != nil {
			return err
		}
	}
	return nil
}

// EnvName returns the SRR_<SCHEME>_<FIELD> environment variable that overrides a
// backend config field — the scheme and the field's yaml key upper-cased with
// dashes turned to underscores — or "" for a field with no yaml tag. It is the
// single source of truth for the backend env-override grammar: loadEnv reads
// this key, and `srr config` derives it the same way (via cmd_config.go) to
// detect — and omit — the conventional name, so the two can never drift.
func EnvName(scheme string, f reflect.StructField) string {
	tag, _, _ := strings.Cut(f.Tag.Get("yaml"), ",")
	if tag == "" {
		return ""
	}
	return "SRR_" + strings.ToUpper(scheme) + "_" + strings.ToUpper(strings.ReplaceAll(tag, "-", "_"))
}

// loadEnv overrides config fields with SRR_<SCHEME>_<FIELD> env vars (the names
// `srr config` prints — see EnvName). Returns an error when an override is
// present for a field it can't apply — a malformed int, or a field kind with no
// override support — so the "env beats YAML" invariant can never silently fail
// to apply (e.g. a new int field that would otherwise be YAML-settable but
// un-overridable by env).
func loadEnv(scheme string, cfg any) error {
	v := reflect.ValueOf(cfg).Elem()
	t := v.Type()
	for i := range t.NumField() {
		envKey := EnvName(scheme, t.Field(i))
		if envKey == "" {
			continue
		}
		val, ok := os.LookupEnv(envKey)
		if !ok {
			continue
		}
		f := v.Field(i)
		switch f.Kind() {
		case reflect.String:
			f.SetString(val)
		case reflect.Bool:
			b, err := strconv.ParseBool(val)
			if err != nil {
				return fmt.Errorf("%s: %w", envKey, err)
			}
			f.SetBool(b)
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			n, err := strconv.ParseInt(val, 10, 64)
			if err != nil {
				return fmt.Errorf("%s: %w", envKey, err)
			}
			f.SetInt(n)
		case reflect.Map:
			if f.Type() != reflect.TypeFor[map[string]string]() {
				return fmt.Errorf("%s: unsupported config field type %s", envKey, f.Type())
			}
			m, err := parseEnvMap(val)
			if err != nil {
				return fmt.Errorf("%s: %w", envKey, err)
			}
			f.Set(reflect.ValueOf(m))
		default:
			return fmt.Errorf("%s: unsupported config field kind %s", envKey, f.Kind())
		}
	}
	return nil
}

// parseEnvMap parses the env-var encoding of a map[string]string config field
// (e.g. SRR_HTTP_HEADERS): comma-separated "Name: value" entries, split on the
// FIRST colon per entry, names and values space-trimmed. The env value
// replaces the YAML map whole (same env-beats-YAML rule as scalar fields). A
// value containing a comma is not expressible here — set it in YAML instead.
func parseEnvMap(val string) (map[string]string, error) {
	m := map[string]string{}
	for entry := range strings.SplitSeq(val, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, value, ok := strings.Cut(entry, ":")
		name = strings.TrimSpace(name)
		if !ok || name == "" {
			return nil, fmt.Errorf("malformed entry %q (want \"Name: value\")", entry)
		}
		m[name] = strings.TrimSpace(value)
	}
	return m, nil
}

// Configs returns the registered backend config structs keyed by scheme.
func Configs() map[string]any {
	return configs
}

// tmpWriteCounter makes atomic-write temp names unique across concurrent writers
// of the SAME key. The asset uploader writes one content-hash key from several
// fetch workers at once; a fixed "<file>.tmp" would have them share — and
// corrupt — one temp file, spuriously failing a whole feed fetch.
var tmpWriteCounter atomic.Uint64

// uniqueTempName returns a collision-free temp path for an atomic write of file
// (temp-then-rename), unique per call even for concurrent writers of the same key.
func uniqueTempName(file string) string {
	return fmt.Sprintf("%s.tmp.%d.%d", file, os.Getpid(), tmpWriteCounter.Add(1))
}

// tempSweepMaxAge is how old a uniqueTempName staging leftover must be before
// AtomicPut's pre-write sweep (local/SFTP) deletes it. Every failure path
// removes its own staging file, so a leftover only exists when a hard kill
// (SIGKILL, power loss, OOM) landed between the temp create and the rename —
// and its name is unique per process+write, so nothing ever overwrites it and
// no GC knows it (the pack sweeps only speak the pack-name grammar): without
// the sweep each such crash strands one file in the store forever. The age
// gate keeps the sweep from racing a live writer's in-flight staging file
// (another process mid-AtomicPut under --force); no single atomic write runs
// anywhere near this long.
const tempSweepMaxAge = 24 * time.Hour

// staleTemp reports whether a staging file stamped mod is old enough to sweep.
//
// What makes this safe is the CALLER's discipline, not anything here: both mod
// and now come from the same directory listing, now being the caller's own
// just-created staging file (see sweepTempLeftovers). One clock, one call. An
// SFTP server or an NFS mount whose clock runs behind this host's would
// otherwise make every in-flight staging file look ancient — and asset uploads
// run concurrently within a single process, so two live temps in one directory
// need no second writer at all. Do not reintroduce a separately-obtained now.
//
// The IsZero arm is belt-and-braces only, and deliberately not load-bearing:
// a server that omits mtime in its READDIR attrs reports the Unix epoch, whose
// IsZero() is false (Go's zero time is year 1). Such a server also stamps the
// reference file with the epoch, so now.Sub(mod) is 0 and nothing is swept.
func staleTemp(mod, now time.Time) bool {
	return !mod.IsZero() && now.Sub(mod) >= tempSweepMaxAge
}

// isTempLeftover reports whether a directory entry name is a uniqueTempName
// staging file (<base>.tmp.<pid>.<n>). The strict digits-suffix match keeps
// the sweep from ever touching a user file that merely contains ".tmp.".
func isTempLeftover(name string) bool {
	i := strings.LastIndex(name, ".tmp.")
	if i < 0 {
		return false
	}
	pid, n, ok := strings.Cut(name[i+len(".tmp."):], ".")
	return ok && isDigits(pid) && isDigits(n)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// rmErr maps a remove error to the store's missing-key Rm contract, shared by
// the Local and SFTP backends (whose handling is otherwise identical). A nil
// error or a missing key is success: Rm is contractually silent on missing
// keys, and the GC sweeps (gcSweep) deliberately re-delete a trailing window of
// already-gone names to self-heal crash-leaked packs — so a missing key here is
// expected, not warn-worthy. Debug keeps it inspectable; any other error wraps.
// S3.Rm has no missing-key branch (a delete of a missing key is already
// success) and does not use this.
func rmErr(err error, file string) error {
	if err == nil {
		return nil
	}
	if os.IsNotExist(err) {
		slog.Debug("db not found", "key", file)
		return nil
	}
	return fmt.Errorf("removing %s: %w", file, err)
}

func Open(ctx context.Context, outputPath string) (Backend, error) {
	u, err := url.Parse(outputPath)
	if err != nil {
		return nil, fmt.Errorf("invalid output path %q: %w", outputPath, err)
	}

	init, ok := registry[u.Scheme]
	if !ok {
		return nil, fmt.Errorf("unsupported output URL scheme %q", u.Scheme)
	}

	backend, err := init(ctx, u)
	if err != nil {
		return nil, fmt.Errorf("initialize database backend: %w", err)
	}
	return backend, nil
}
