package main

import (
	"fmt"
	"reflect"
	"strings"
)

func toKebab(s string) string {
	var buf []byte
	for i := range s {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			if i > 0 && s[i-1] >= 'a' && s[i-1] <= 'z' {
				buf = append(buf, '-')
			}
			buf = append(buf, c+'a'-'A')
		} else {
			buf = append(buf, c)
		}
	}
	return string(buf)
}

func fieldName(f reflect.StructField) string {
	if tag, _, _ := strings.Cut(f.Tag.Get("yaml"), ","); tag != "" {
		return tag
	}
	return toKebab(f.Name)
}

// maskSecret renders a `secret:"true"`-tagged field's value so `srr config` never
// prints credentials (S3 secret key / session token, SFTP password) in cleartext:
// a fixed placeholder when set, empty when unset.
func maskSecret(v any) any {
	switch t := v.(type) {
	case string:
		if t == "" {
			return ""
		}
	case map[string]string:
		if len(t) == 0 {
			return ""
		}
	}
	return "********"
}

// printFields prints each field as "name: value", optionally annotated with the
// env var that sets it. envName derives that name per field (the kong env: tag
// for globals, the derived SRR_<SCHEME>_<FIELD> for backend configs); pass nil
// to print values only.
func printFields(v reflect.Value, indent string, envName func(reflect.StructField) string) {
	t := v.Type()
	for i := range t.NumField() {
		f := t.Field(i)
		val := v.Field(i).Interface()
		if f.Tag.Get("secret") == "true" {
			val = maskSecret(val)
		}
		line := fmt.Sprintf("%s%s: %v", indent, fieldName(f), val)
		if envName != nil {
			if e := envName(f); e != "" {
				line += fmt.Sprintf("  [%s]", e)
			}
		}
		fmt.Println(line)
	}
}
