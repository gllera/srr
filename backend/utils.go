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

func printFields(v reflect.Value, indent string) {
	t := v.Type()
	for i := range t.NumField() {
		fmt.Printf("%s%s: %v\n", indent, fieldName(t.Field(i)), v.Field(i).Interface())
	}
}
