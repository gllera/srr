package main

import (
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"

	"srr/store"
)

type ConfigCmd struct {
	Key string `arg:"" optional:"" help:"Config key to print (omit for all)."`
}

// expectedEnv is the conventional env-var name for a field shown as `name`
// under `scheme` (empty for globals): SRR_[<SCHEME>_]<SCREAMING_SNAKE(name)>.
// It mirrors store.EnvName's grammar so cmd_config can tell whether an env name
// is mechanically derivable from the displayed field name.
func expectedEnv(scheme, name string) string {
	env := "SRR_"
	if scheme != "" {
		env += strings.ToUpper(scheme) + "_"
	}
	return env + strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
}

// globalEnvName returns the env var that sets a global flag (its kong env: tag),
// or "" when that name is the conventional derivation of the field name — there
// is no need to print what the reader can derive. A hand-rolled tag that breaks
// the convention is still returned so it stays visible.
func globalEnvName(f reflect.StructField) string {
	env := f.Tag.Get("env")
	if env == expectedEnv("", fieldName(f)) {
		return ""
	}
	return env
}

// backendEnvNameFor returns a per-field env-name deriver for a backend config
// section, bound to scheme. store.EnvName (the name store.loadEnv reads) is the
// conventional SRR_<SCHEME>_<FIELD> derivation by construction, so it always
// matches expectedEnv and is suppressed — backend env names are never printed.
func backendEnvNameFor(scheme string) func(reflect.StructField) string {
	return func(f reflect.StructField) string {
		env := store.EnvName(scheme, f)
		if env == expectedEnv(scheme, fieldName(f)) {
			return ""
		}
		return env
	}
}

// printSecretEntries prints the srr.yaml secrets, sorted by name, with values
// masked by the shared maskSecret placeholder so `srr config` never reveals them.
func printSecretEntries(indent string) {
	for _, name := range slices.Sorted(maps.Keys(secrets)) {
		fmt.Printf("%s%s: %v\n", indent, name, maskSecret(secrets[name]))
	}
}

func (o *ConfigCmd) Run() error {
	gv := reflect.ValueOf(*globals)
	gt := gv.Type()

	// Every registered backend section is printed regardless of the active store
	// scheme, so unset (inactive-backend) configs are discoverable too. Sorted
	// for deterministic output (store.Configs returns a map).
	cfgs := store.Configs()
	schemes := slices.Sorted(maps.Keys(cfgs))

	if o.Key == "" {
		printFields(gv, "", globalEnvName)
		for _, scheme := range schemes {
			fmt.Printf("%s:\n", scheme)
			printFields(reflect.ValueOf(cfgs[scheme]).Elem(), "  ", backendEnvNameFor(scheme))
		}
		if len(secrets) > 0 {
			fmt.Println("secrets:")
			printSecretEntries("  ")
		}
		return nil
	}

	// The srr.yaml secrets section, always masked: the whole section ("secrets")
	// or one entry ("secrets.TOKEN"). Resolved before the backend-section lookup
	// since "secrets" is not a store scheme.
	if o.Key == "secrets" {
		printSecretEntries("")
		return nil
	}
	if name, ok := strings.CutPrefix(o.Key, "secrets."); ok {
		if val, exists := secrets[name]; exists {
			fmt.Println(maskSecret(val))
			return nil
		}
	}

	for i := range gt.NumField() {
		if fieldName(gt.Field(i)) == o.Key {
			fmt.Println(gv.Field(i).Interface())
			return nil
		}
	}

	// A whole backend section by scheme ("s3"), then a single field ("s3.region"),
	// both resolved against the registry rather than the active store's scheme.
	if cfg, ok := cfgs[o.Key]; ok {
		printFields(reflect.ValueOf(cfg).Elem(), "", backendEnvNameFor(o.Key))
		return nil
	}

	if scheme, field, ok := strings.Cut(o.Key, "."); ok {
		if cfg, ok := cfgs[scheme]; ok {
			cv := reflect.ValueOf(cfg).Elem()
			ct := cv.Type()
			for i := range ct.NumField() {
				if fieldName(ct.Field(i)) == field {
					fmt.Println(cv.Field(i).Interface())
					return nil
				}
			}
		}
	}

	return fmt.Errorf("unknown config key: %s", o.Key)
}
