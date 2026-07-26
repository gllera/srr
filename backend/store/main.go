package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"maps"
	"net/url"
	"os"
	"path"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/errgroup"
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

// PackSeries is the write-once object-name grammar, one row per series: the
// directory plus the kind letters a stem may carry in front of the digit run.
// Every row is now bare-stem-only — the kind letters ("L" latest generations,
// "h"/"s" summaries, "d" delta segments) were retired at the generation-manifest
// cutover (docs/MANIFEST-SPEC.md §4.5): a stem is drawn from a per-series
// monotone counter that is never reused, and the manifest's ordered name list
// says what each object holds. `idx/812.gz` means "idx-series object #812" and
// nothing more, which is exactly what makes a rebuild write NEW names beside
// the old ones instead of over them.
//
// Single source of truth for both sides of the contract: packKeyRe below and
// the service worker's RE_PACK/parsePackName (via `srr gen-ts` →
// format.gen.ts PACK_SERIES_KINDS) are built from it.
//
//   - "manifest" holds manifest/<m>.gz, the immutable generation manifest every
//     Commit publishes (§4.2). The manifest counter IS the name.
//   - "seen" holds the backend-only persistent-dedup sidecar, now a manifest-
//     named immutable object rather than a mutable ping/pong pair (§10.2).
//     The frontend/service-worker never fetch it; the SW's route regex simply
//     gains an inert series.
var PackSeries = []struct {
	Name  string // series directory
	Kinds string // kind letters valid besides the finalized bare stem ("" = bare only)
}{
	{"idx", ""},
	{"data", ""},
	{"meta", ""},
	{"manifest", ""},
	{"seen", ""},
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

// ParsePackKey splits a write-once pack-grammar key into the series it belongs
// to and its opaque stem, reporting false for anything the grammar cannot
// produce. It is the only reader of packKeyRe outside this file, and it exists
// so a sweep driven by a store LISTING (the GC's list mode) can ask "is this
// object mine to delete?" without any caller re-deriving the shape.
//
// Everything else answers false — assets/, out/, inbox/, the roots, the
// frontend shell, an AtomicPut staging leftover, a retired kind-lettered
// name — and that is exactly the safety property the list-driven sweep rests on.
func ParsePackKey(key string) (series string, stem int, ok bool) {
	if !packKeyRe.MatchString(key) {
		return "", 0, false
	}
	series, rest, _ := strings.Cut(key, "/")
	stem, err := strconv.Atoi(strings.TrimSuffix(rest, ".gz"))
	if err != nil {
		// The grammar allows an arbitrarily long digit run; one that overflows an
		// int is not a stem any counter here ever handed out.
		return "", 0, false
	}
	return series, stem, true
}

// feHashedRe matches a content-hashed frontend asset at the store root —
// "<name>.<8+ hex>.<ext>" with no path separator. Parcel emits such names
// (frontend.5730a221.css, sw.57d1d92e.js, icon-192.936dab90.png); the hash
// changes per build, so the bytes are write-once and may be cached forever.
// Anchored and slash-free so it never matches a pack key (idx/0.gz) or db.gz.
var feHashedRe = regexp.MustCompile(`^[^/]+\.[0-9a-f]{8,}\.[a-z0-9]+$`)

// HashedFrontendAsset reports whether key is a content-hashed frontend asset at
// the store root. `srr frontend update` uses it to recognise, in a store
// LISTING, the one frontend class whose names are machine-minted per build and
// therefore accumulate across upgrades — as opposed to db.gz, config.gz, an
// operator's own root file, or the stable-named shell files, none of which a
// listing may ever classify as an upgrade orphan.
func HashedFrontendAsset(key string) bool { return feHashedRe.MatchString(key) }

// cacheControlForKey returns the HTTP Cache-Control directive a backend should
// attach when writing key, or "" for keys with no caching policy (e.g. the
// lock marker). Backends that carry HTTP metadata (S3) emit it; filesystem
// backends ignore it. Centralised here so writer and the contract stay in one
// place.
func cacheControlForKey(key string) string {
	switch {
	case key == "db.gz" || key == "config.gz":
		// db.gz is the ~60-byte commit root {v, m, t} — the store's ONE mutable
		// key on the reader path, rewritten every cycle.
		//
		// config.gz is the backend-only configuration sidecar
		// (docs/MANIFEST-SPEC.md §4.3): mutable like db.gz, rewritten only when
		// the operator changes configuration, and never fetched by the frontend
		// or the service worker. Deliberately NOT in PackSeries.
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
// key-derived type (unknown keys fall to the backend's
// application/octet-stream default). This is grammar classification of SRR's
// own key classes, never extension guessing: a pack key's .gz is truthful by
// construction. Centralised next to cacheControlForKey so the writer↔CDN
// contract stays in one place.
//
// An asset's type is never derived HERE. asset-peek/asset-process is its single
// source of truth wherever either is configured, and the caller has already
// resolved that into ObjectMeta by the time a backend asks this. With neither
// configured the asset layer sniffs the payload's own leading bytes and stamps
// an inert media type (assets.go sniffedMediaType) — a zero-config install would
// otherwise serve every self-hosted image as an octet-stream download. Either
// way the type arrives as meta; a key extension never speaks for one.
func contentTypeForKey(key string) string {
	if key == "db.gz" || key == "config.gz" || strings.HasPrefix(key, "inbox/") || packKeyRe.MatchString(key) {
		return contentTypeGzip
	}
	return ""
}

// Backend defines the storage operations used by the application.
//
// MISSING KEYS ARE ONE CONTRACT: every read op reports an absent key as an
// error satisfying errors.Is(err, fs.ErrNotExist), and NOTHING else may. That
// is the whole point — three ad-hoc absence conventions (Get's ignoreMissing
// flag, Stat's silent (0, nil), Rm's silence) let a transient network error
// impersonate absence, and a caller that mistakes "I could not tell" for "it is
// not there" makes an irreversible decision on a lie: it drops the config
// naming a file it failed to delete, or re-uploads an object it already has.
// Callers ask the question with errors.Is and get a truthful answer or an error.
//
// Rm stays the one deliberate exception: deleting an absent key IS success, so
// it returns nil rather than an absence error (an idempotent retry after a
// crash re-deletes names its predecessor already removed).
type Backend interface {
	// Get streams key's body. A missing key is an error wrapping fs.ErrNotExist
	// — check with errors.Is, do not string-match.
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// Stat returns the stored size of key in bytes without reading the body
	// (filesystem stat, S3 HeadObject, HTTP HEAD). A missing key is an error
	// wrapping fs.ErrNotExist; a nil error therefore PROVES the object exists,
	// which is what lets the asset uploader skip its body-carrying Get probe.
	// Callers that want absent-as-zero (expiration's asset-bytes accounting)
	// say so explicitly with errors.Is.
	//
	// A size of 0 with a nil error is a legal answer — a zero-byte object, or a
	// store whose HEAD omits Content-Length. It is NOT absence.
	Stat(ctx context.Context, key string) (int64, error)
	Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error
	// AtomicPut writes via temp-then-rename (local/SFTP) or overwrite (S3). meta
	// carries optional response metadata (Content-Type / Content-Encoding) — used
	// by backends that store it (S3); ignored by backends whose headers come from
	// a static server at request time (local/SFTP).
	AtomicPut(ctx context.Context, key string, r io.Reader, meta ObjectMeta) error
	// Version returns an OPAQUE token for key's current content, or "" when the
	// key is absent. It is meaningful only as an argument to PutIfVersion, and
	// each backend picks whatever its store can make a write conditional on (an
	// ETag on S3, a content digest on a filesystem) — nothing may parse it or
	// compare tokens across backends. errors.ErrUnsupported when the backend
	// cannot express one; callers then fall back to an unconditional AtomicPut.
	//
	// Intended for small MUTABLE roots (db.gz). A backend is free to read the
	// object to answer, so do not call it on packs.
	Version(ctx context.Context, key string) (string, error)
	// PutIfVersion is AtomicPut with a precondition: the write lands only while
	// key's version still equals want, where "" means "the key must not exist".
	// It returns the stored object's NEW version, so a caller holding the token
	// across several writes never needs a re-read.
	//
	// A lost race is ErrPreconditionFailed and the stored object is untouched.
	// errors.ErrUnsupported when the backend cannot express the condition.
	PutIfVersion(ctx context.Context, key string, r io.Reader, meta ObjectMeta, want string) (string, error)
	Rm(ctx context.Context, key string) error
	// List returns the store-relative keys of every object whose key starts with
	// prefix, in lexicographic order. It is what lets a sweep ask the store what
	// it HOLDS instead of inferring it from what some record says it should —
	// the absence of which is why the GC drains generation by generation, why
	// `srr frontend update` keeps a sitemap, and why a crash-leaked object is
	// otherwise unfindable forever.
	//
	// A PREFIX IS NOT AN OBJECT: one that matches nothing — including one naming
	// a directory that does not exist — returns an empty slice and a NIL error,
	// never fs.ErrNotExist. Absence is a fact about a key; a prefix names a set,
	// and an empty set is a perfectly good answer.
	//
	// errors.ErrUnsupported when the backend cannot enumerate (plain HTTP has no
	// portable listing verb), and callers then keep whatever fallback they had.
	List(ctx context.Context, prefix string) ([]string, error)
	Close() error
}

// listDir is the directory part of a listing prefix — what a filesystem-shaped
// backend must walk to answer it. "idx/" and "idx/17" both walk "idx/"; "" walks
// the store root. The caller still filters the walk's results by the full
// prefix, so the split is a cost optimisation, never a semantic one.
func listDir(prefix string) string {
	dir, _ := path.Split(prefix)
	return dir
}

// errMissing is the ONE missing-key error every backend returns, so the whole
// codebase asks the absence question exactly one way: errors.Is(err,
// fs.ErrNotExist). The key rides the message because a bare sentinel names
// nothing when it surfaces three layers up in a warn line.
func errMissing(op, key string) error {
	return fmt.Errorf("%s %s: %w", op, key, fs.ErrNotExist)
}

// isNotExist reports whether a backend's underlying error means "no such key".
//
// os.IsNotExist alone is NOT enough and neither is errors.Is alone: the former
// unwraps only *PathError/*LinkError/*SyscallError and misses a sentinel-based
// error (pkg/sftp maps SSH_FX_NO_SUCH_FILE to one), while the latter misses a
// bare syscall.ENOENT that never got wrapped. Backends funnel through here and
// then re-wrap with errMissing, so what leaves the package is uniform however
// it arrived.
func isNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || os.IsNotExist(err)
}

// ErrPreconditionFailed reports that a conditional write did not land because
// the object changed under it — another writer got there first. It is the
// signal that turns a silent last-write-wins into a loud, retryable abort.
var ErrPreconditionFailed = errors.New("store: object changed under a conditional write")

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

// BatchRemover is the optional Backend extension for a store whose own protocol
// deletes MANY keys per round-trip. RmAll uses it when the backend implements
// it and falls back to its parallel Rm fan-out otherwise, so a backend
// implements it only when the protocol offers something concurrency cannot:
// S3's DeleteObjects takes 1000 keys per request, which turns a thousand-object
// sweep into one call instead of a thousand.
//
// It is deliberately NOT on Backend. Every backend must answer Rm; only some
// have a batch verb, and a default implementation on the interface would be the
// fan-out RmAll already provides.
type BatchRemover interface {
	// RmBatch deletes every key, batching as its protocol allows, and reports
	// the keys still in the store. Same contract as RmAll — which is the only
	// caller — down to never stopping at the first failure.
	RmBatch(ctx context.Context, keys []string) (failed []string, err error)
}

// RmAll deletes every key in keys and reports the ones that are still there.
//
// It NEVER stops at the first failure and never cancels a sibling delete,
// because every caller is a reclaim path whose SUCCESSES are real work that
// must not be lost or misreported: the GC's `gcm` low-water mark may advance
// only over a generation it fully cleared, and `srr frontend update` keeps a
// failed delete tracked in its sitemap so the next run retries exactly it.
// "These keys are gone, those are not" is the answer both need, and a
// first-error abort cannot express it.
//
// Per-key semantics are Rm's, unchanged — in particular deleting an ABSENT key
// is success. The GC deliberately re-deletes a trailing window of already-gone
// names to self-heal crash-leaked objects, so a missing key reported as a
// failure would wedge the sweep permanently.
//
// failed is sorted and err is non-nil exactly when failed is non-empty, joining
// every per-key cause (the backends name the key in their own errors, so
// nothing is re-wrapped here). parallel bounds the fan-out; it is ignored by a
// BatchRemover, whose batching IS its concurrency.
func RmAll(ctx context.Context, be Backend, keys []string, parallel int) ([]string, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	if br, ok := be.(BatchRemover); ok {
		return br.RmBatch(ctx, keys)
	}

	var mu sync.Mutex
	causes := map[string]error{}
	g := new(errgroup.Group) // no WithContext: a failure must not cancel the rest
	g.SetLimit(max(1, parallel))
	for _, k := range keys {
		g.Go(func() error {
			if err := be.Rm(ctx, k); err != nil {
				mu.Lock()
				causes[k] = err
				mu.Unlock()
			}
			// Failures ride causes, never the group: returning one here would
			// make Wait's arbitrary first error the whole answer.
			return nil
		})
	}
	_ = g.Wait() // every goroutine returns nil, by construction above

	return joinFailures(causes)
}

// joinFailures turns a key→cause map into the (sorted keys, joined error) pair
// RmAll and RmBatch both answer with. Sorted so the report — and the joined
// message — is deterministic however the concurrent deletes interleaved.
func joinFailures(causes map[string]error) ([]string, error) {
	if len(causes) == 0 {
		return nil, nil
	}
	failed := slices.Sorted(maps.Keys(causes))
	errs := make([]error, len(failed))
	for i, k := range failed {
		errs[i] = causes[k]
	}
	return failed, errors.Join(errs...)
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
