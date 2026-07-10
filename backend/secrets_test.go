package main

import "testing"

func TestParseSecrets(t *testing.T) {
	data := []byte("store: packs\nsecrets:\n  TOKEN: abc\n  API_HASH: \"def123\"\n")
	got, err := parseSecrets(data)
	if err != nil {
		t.Fatalf("parseSecrets: %v", err)
	}
	if got["TOKEN"] != "abc" || got["API_HASH"] != "def123" {
		t.Errorf("parsed secrets = %v, want TOKEN=abc API_HASH=def123", got)
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

func TestParseSecretsRejectsBadName(t *testing.T) {
	cases := map[string][]byte{
		"empty name":    []byte("secrets:\n  \"\": v\n"),
		"name with '='": []byte("secrets:\n  \"A=B\": v\n"),
	}
	for name, data := range cases {
		if _, err := parseSecrets(data); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}
