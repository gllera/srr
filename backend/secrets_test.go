package main

import (
	"strings"
	"testing"
)

func TestParseSecretsScoped(t *testing.T) {
	data := []byte("store: packs\nsecrets:\n  telegram:\n    TOKEN: abc\n    API_HASH: \"def123\"\n  github:\n    GH_PAT: xyz\n")
	got, err := parseSecrets(data)
	if err != nil {
		t.Fatalf("parseSecrets: %v", err)
	}
	if got["telegram"]["TOKEN"] != "abc" || got["telegram"]["API_HASH"] != "def123" {
		t.Errorf("telegram scope = %v, want TOKEN=abc API_HASH=def123", got["telegram"])
	}
	if got["github"]["GH_PAT"] != "xyz" {
		t.Errorf("github scope = %v, want GH_PAT=xyz", got["github"])
	}
}

func TestParseSecretsAbsent(t *testing.T) {
	got, err := parseSecrets([]byte("store: packs\n"))
	if err != nil {
		t.Fatalf("parseSecrets: %v", err)
	}
	if got != nil {
		t.Errorf("absent section should yield nil, got %v", got)
	}
}

func TestParseSecretsNilAndMalformed(t *testing.T) {
	// Empty input takes the early return: nil map, no error.
	if got, err := parseSecrets(nil); err != nil || got != nil {
		t.Errorf("parseSecrets(nil) = (%v, %v), want (nil, nil)", got, err)
	}
	// Malformed YAML surfaces the unmarshal error.
	if _, err := parseSecrets([]byte("secrets: [oops")); err == nil {
		t.Error("parseSecrets(malformed) = nil err, want a parse error")
	}
}

// A pre-scope flat map (name → value directly under secrets:) must fail with a
// migration hint naming the scoped layout, not a bare yaml type error.
func TestParseSecretsLegacyFlatMapHint(t *testing.T) {
	_, err := parseSecrets([]byte("secrets:\n  TOKEN: abc\n"))
	if err == nil {
		t.Fatal("legacy flat secrets map: expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "scope") {
		t.Errorf("legacy flat map error should mention scopes, got: %v", err)
	}
}

func TestParseSecretsRejectsBadNames(t *testing.T) {
	cases := map[string][]byte{
		"empty scope name":     []byte("secrets:\n  \"\":\n    A: v\n"),
		"scope name with '.'":  []byte("secrets:\n  \"a.b\":\n    A: v\n"),
		"empty secret name":    []byte("secrets:\n  tg:\n    \"\": v\n"),
		"secret name with '='": []byte("secrets:\n  tg:\n    \"A=B\": v\n"),
	}
	for name, data := range cases {
		if _, err := parseSecrets(data); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}
