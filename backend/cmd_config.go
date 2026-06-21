package main

import (
	"fmt"
	"net/url"
	"reflect"
	"strings"

	"srrb/store"
)

type ConfigCmd struct {
	Key string `arg:"" optional:"" help:"Config key to print (omit for all)."`
}

// globalEnvName returns the env var that sets a global flag (its kong env: tag).
func globalEnvName(f reflect.StructField) string {
	return f.Tag.Get("env")
}

// backendEnvNameFor returns a per-field env-name deriver for a backend config
// section, bound to scheme: it prints the very name store.loadEnv reads, since
// both go through store.EnvName.
func backendEnvNameFor(scheme string) func(reflect.StructField) string {
	return func(f reflect.StructField) string {
		return store.EnvName(scheme, f)
	}
}

func (o *ConfigCmd) Run() error {
	gv := reflect.ValueOf(*globals)
	gt := gv.Type()

	// A malformed store (e.g. "packs%") makes url.Parse return (nil, err); read
	// the scheme only on success so we print config cleanly instead of panicking
	// on u.Scheme. Other commands surface the parse error via store.Open.
	var scheme string
	if u, err := url.Parse(globals.Store); err == nil {
		scheme = u.Scheme
	}
	storeCfg, hasStoreCfg := store.Configs()[scheme]

	if o.Key == "" {
		printFields(gv, "", globalEnvName)
		if hasStoreCfg {
			fmt.Printf("%s:\n", scheme)
			printFields(reflect.ValueOf(storeCfg).Elem(), "  ", backendEnvNameFor(scheme))
		}
		return nil
	}

	for i := range gt.NumField() {
		if fieldName(gt.Field(i)) == o.Key {
			fmt.Println(gv.Field(i).Interface())
			return nil
		}
	}

	if hasStoreCfg {
		cv := reflect.ValueOf(storeCfg).Elem()
		ct := cv.Type()

		if o.Key == scheme {
			printFields(cv, "", backendEnvNameFor(scheme))
			return nil
		}

		if after, ok := strings.CutPrefix(o.Key, scheme+"."); ok {
			for i := range ct.NumField() {
				if fieldName(ct.Field(i)) == after {
					fmt.Println(cv.Field(i).Interface())
					return nil
				}
			}
		}
	}

	return fmt.Errorf("unknown config key: %s", o.Key)
}
