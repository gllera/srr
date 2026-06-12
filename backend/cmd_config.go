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
		printFields(gv, "")
		if hasStoreCfg {
			fmt.Printf("%s:\n", scheme)
			printFields(reflect.ValueOf(storeCfg).Elem(), "  ")
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
			printFields(cv, "")
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
