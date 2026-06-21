package store

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"

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
// "s"<N> meta bloom summaries ("meta/s4.gz"). Single source of truth for
// both sides of the contract: packKeyRe below and the service worker's
// RE_PACK/parsePackName (via `srr gen-ts` → format.gen.ts PACK_SERIES_KINDS)
// are built from it.
var PackSeries = []struct {
	Name  string // series directory
	Kinds string // kind letters valid besides the finalized bare stem
}{
	{"idx", "Lh"},
	{"data", "L"},
	{"meta", "Ls"},
}

// packKeyRe matches the write-once pack names, built from PackSeries.
// Anchored strictly — "L", "Lx7" or "LL3" must not be stamped immutable, and
// a kind letter another series owns ("data/h3.gz") is not a pack name.
var packKeyRe = func() *regexp.Regexp {
	alts := make([]string, len(PackSeries))
	for i, s := range PackSeries {
		alts[i] = s.Name + "/[" + s.Kinds + "]?"
	}
	return regexp.MustCompile(`^(?:` + strings.Join(alts, "|") + `)[0-9]+\.gz$`)
}()

// cacheControlForKey returns the HTTP Cache-Control directive a backend should
// attach when writing key, or "" for keys with no caching policy (e.g. the
// lock marker). Backends that carry HTTP metadata (S3) emit it; filesystem
// backends ignore it. Centralised here so writer and the contract stay in one
// place.
func cacheControlForKey(key string) string {
	switch {
	case key == "db.gz":
		return cacheRevalidate
	case strings.HasPrefix(key, "out/"):
		// out/* is the one mutable object class besides db.gz: an output
		// syndication feed (out/<name>.rss or out/<name>.json) is overwritten
		// on every fetch cycle. Must-revalidate so clients always see the
		// latest window. Not in PackSeries/packKeyRe — NOT immutable.
		return cacheRevalidate
	case strings.HasPrefix(key, "assets/") || packKeyRe.MatchString(key):
		return cacheImmutable
	default:
		return ""
	}
}

// Backend defines the storage operations used by the application.
type Backend interface {
	Get(ctx context.Context, key string, ignoreMissing bool) (io.ReadCloser, error)
	Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error
	AtomicPut(ctx context.Context, key string, r io.Reader) error
	Rm(ctx context.Context, key string) error
	Close() error
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
		default:
			return fmt.Errorf("%s: unsupported config field kind %s", envKey, f.Kind())
		}
	}
	return nil
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
