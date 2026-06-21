package main

import (
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
)

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stdout = w
	done := make(chan string)
	go func() {
		var buf strings.Builder
		_, _ = io.Copy(&buf, r)
		done <- buf.String()
	}()
	fn()
	w.Close()
	os.Stdout = old
	return <-done
}

func TestPrintFieldsKebabCase(t *testing.T) {
	type S struct {
		PackSize    int
		MaxFeedSize int
	}
	out := captureStdout(t, func() {
		printFields(reflect.ValueOf(S{PackSize: 200, MaxFeedSize: 5000}), "", nil)
	})
	if !strings.Contains(out, "pack-size: 200\n") {
		t.Errorf("missing kebab-cased pack-size line: %q", out)
	}
	if !strings.Contains(out, "max-feed-size: 5000\n") {
		t.Errorf("missing kebab-cased max-feed-size line: %q", out)
	}
}

func TestPrintFieldsRespectsYAMLTag(t *testing.T) {
	type S struct {
		Region string `yaml:"my-region"`
	}
	out := captureStdout(t, func() {
		printFields(reflect.ValueOf(S{Region: "us-east-1"}), "  ", nil)
	})
	if !strings.Contains(out, "  my-region: us-east-1\n") {
		t.Errorf("expected yaml-tag-named indented line: %q", out)
	}
}

func TestPrintFieldsAnnotatesEnvName(t *testing.T) {
	type S struct {
		Workers int `env:"SRR_WORKERS"`
	}
	out := captureStdout(t, func() {
		printFields(reflect.ValueOf(S{Workers: 4}), "", func(f reflect.StructField) string {
			return f.Tag.Get("env")
		})
	})
	if !strings.Contains(out, "workers: 4  [SRR_WORKERS]\n") {
		t.Errorf("expected env-annotated line, got: %q", out)
	}
}

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
