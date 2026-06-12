package store

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	// cacheImmutable stamps write-once keys: finalized packs (idx|data|
	// search/<n>.gz) never change once written; latest packs (L<seq>) and the
	// summaries (idx/h<N>, search/s<N>) are write-once names — never rewritten
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
// "s"<N> search bloom summaries ("search/s4.gz"). Single source of truth for
// both sides of the contract: packKeyRe below and the service worker's
// RE_PACK/parsePackName (via `srr gen-ts` → format.gen.ts PACK_SERIES_KINDS)
// are built from it.
var PackSeries = []struct {
	Name  string // series directory
	Kinds string // kind letters valid besides the finalized bare stem
}{
	{"idx", "Lh"},
	{"data", "L"},
	{"search", "Ls"},
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
				if err := node.Decode(cfg); err != nil {
					return fmt.Errorf("decoding %q config: %w", scheme, err)
				}
			}
		}
	}

	for scheme, cfg := range configs {
		loadEnv(scheme, cfg)
	}
	return nil
}

// loadEnv overrides config fields with SRR_<SCHEME>_<FIELD> env vars.
func loadEnv(scheme string, cfg any) {
	v := reflect.ValueOf(cfg).Elem()
	t := v.Type()
	prefix := "SRR_" + strings.ToUpper(scheme) + "_"
	for i := range t.NumField() {
		tag, _, _ := strings.Cut(t.Field(i).Tag.Get("yaml"), ",")
		if tag == "" {
			continue
		}
		envKey := prefix + strings.ToUpper(strings.ReplaceAll(tag, "-", "_"))
		val, ok := os.LookupEnv(envKey)
		if !ok {
			continue
		}
		f := v.Field(i)
		switch f.Kind() {
		case reflect.String:
			f.SetString(val)
		case reflect.Bool:
			f.SetBool(val == "true" || val == "1")
		}
	}
}

// Configs returns the registered backend config structs keyed by scheme.
func Configs() map[string]any {
	return configs
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
