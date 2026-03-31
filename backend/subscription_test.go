package main

import (
	"testing"
)

func TestStripControl(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"hello world", "helloworld"},    // space is <= ' ', removed
		{"hello\tworld", "helloworld"},   // tab removed
		{"hello\nworld", "helloworld"},   // newline removed
		{"hello\x00world", "helloworld"}, // null byte removed
		{"hello\x7fworld", "helloworld"}, // DEL removed
		{"hello\x01world", "helloworld"}, // control char removed
		{"café", "café"},                 // non-ASCII preserved
		{"", ""},                         // empty string
		{"nocontrol", "nocontrol"},       // no changes needed
		{"\t\n\r ", ""},                  // all control/whitespace
		{"a\x1fb", "ab"},                 // unit separator removed
	}

	for _, tt := range tests {
		got := runStripControl(tt.input)
		if got != tt.want {
			t.Errorf("stripControl(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestStripControlKeepWS(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"hello\tworld", "hello\tworld"}, // tab preserved
		{"hello\nworld", "hello\nworld"}, // newline preserved
		{"hello\rworld", "hello\rworld"}, // carriage return preserved
		{"hello\x00world", "helloworld"}, // null byte removed
		{"hello\x01world", "helloworld"}, // SOH removed
		{"hello\x1fworld", "helloworld"}, // unit separator removed
		{"café", "café"},                 // non-ASCII preserved
		{"", ""},                         // empty string
		{"\t\n\r", "\t\n\r"},             // all kept whitespace
		{"a\x0bb", "ab"},                 // vertical tab removed
		{"hello world", "hello world"},   // space preserved (>= ' ')
	}

	for _, tt := range tests {
		got := runStripControlKeepWS(tt.input)
		if got != tt.want {
			t.Errorf("stripControlKeepWS(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// Helpers to invoke strings.Map with the package functions
func runStripControl(s string) string {
	return stringMap(stripControl, s)
}

func runStripControlKeepWS(s string) string {
	return stringMap(stripControlKeepWS, s)
}

func stringMap(mapping func(rune) rune, s string) string {
	var b []rune
	for _, r := range s {
		if mr := mapping(r); mr >= 0 {
			b = append(b, mr)
		}
	}
	return string(b)
}
