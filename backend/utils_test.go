package main

import (
	"reflect"
	"testing"
)

func TestToKebab(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"foo", "foo"},
		{"Foo", "foo"},
		{"FooBar", "foo-bar"},
		{"FooBarBaz", "foo-bar-baz"},
		{"fooBar", "foo-bar"},
		// All-caps run is preserved (no dash inside acronyms); only a lower→upper
		// boundary inserts a dash.
		{"URL", "url"},
		{"PackSize", "pack-size"},
		{"MaxFeedSize", "max-feed-size"},
	}
	for _, c := range cases {
		if got := toKebab(c.in); got != c.want {
			t.Errorf("toKebab(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFieldNameUsesYAMLTagWhenPresent(t *testing.T) {
	type S struct {
		Foo string `yaml:"custom-name,inline"`
	}
	f := reflect.TypeOf(S{}).Field(0)
	if got := fieldName(f); got != "custom-name" {
		t.Errorf("fieldName = %q, want %q", got, "custom-name")
	}
}

func TestFieldNameFallsBackToKebab(t *testing.T) {
	type S struct {
		PackSize int
	}
	f := reflect.TypeOf(S{}).Field(0)
	if got := fieldName(f); got != "pack-size" {
		t.Errorf("fieldName = %q, want %q", got, "pack-size")
	}
}

func TestFieldNameIgnoresEmptyYAMLTag(t *testing.T) {
	type S struct {
		Foo string `yaml:",inline"`
	}
	f := reflect.TypeOf(S{}).Field(0)
	if got := fieldName(f); got != "foo" {
		t.Errorf("fieldName = %q, want %q", got, "foo")
	}
}
