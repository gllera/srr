package store

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	// cacheImmutable stamps pack files (idx/, data/): finalized packs
	// (idx/<n>.gz, data/<n>.gz) never change once written, and latest packs
	// (idx/L<seq>.gz, data/L<seq>.gz) are write-once — a generation is never
	// rewritten after db.gz publishes it — so the CDN/client may cache both
	// forever.
	cacheImmutable = "public, max-age=31536000, immutable"
	// cacheRevalidate stamps db.gz: the store's only mutable key (the
	// consistency root naming the current L<seq> generation), rewritten every
	// fetch. Must-revalidate forces a conditional request every load.
	cacheRevalidate = "no-cache, must-revalidate"
)

// cacheControlForKey returns the HTTP Cache-Control directive a backend should
// attach when writing key, or "" for keys with no caching policy (e.g. the
// lock marker). Backends that carry HTTP metadata (S3) emit it; filesystem
// backends ignore it. Centralised here so writer and the contract stay in one
// place.
func cacheControlForKey(key string) string {
	base := path.Base(key)
	switch {
	case key == "db.gz":
		return cacheRevalidate
	case (strings.HasPrefix(key, "idx/") || strings.HasPrefix(key, "data/")) && isPackStem(strings.TrimSuffix(base, ".gz")):
		return cacheImmutable
	default:
		return ""
	}
}

// isPackStem reports whether s is a pack filename stem: the digit run of a
// finalized pack ("0", "12") or the L-prefixed generation name of a
// write-once latest pack ("L3"). Anchored strictly — "L", "Lx7" or "LL3"
// must not be stamped immutable.
func isPackStem(s string) bool {
	return isPackNumber(strings.TrimPrefix(s, "L"))
}

// isPackNumber reports whether s is a non-empty run of ASCII digits — the
// filename stem of a finalized pack (e.g. "0", "12", "250").
func isPackNumber(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
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
