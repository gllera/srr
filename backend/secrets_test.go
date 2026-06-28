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
