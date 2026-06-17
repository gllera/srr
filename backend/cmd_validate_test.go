package main

import "testing"

func TestValidateTagRejectsNumeric(t *testing.T) {
	for _, ok := range []string{"", "news", "tech-2024", "2024a"} {
		if err := validateTag(ok); err != nil {
			t.Errorf("validateTag(%q) = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{"2024", "5", "007"} {
		if err := validateTag(bad); err == nil {
			t.Errorf("validateTag(%q) = nil, want error (numeric-only)", bad)
		}
	}
}

func TestValidatePipe(t *testing.T) {
	// Root pipe: #base disallowed; unknown #-token disallowed; built-ins/shell ok.
	if err := validatePipe([]string{"#sanitize", "#minify", "jq ."}, false); err != nil {
		t.Errorf("valid root pipe rejected: %v", err)
	}
	if err := validatePipe([]string{"#base"}, false); err == nil {
		t.Error("root pipe accepted #base, want error")
	}
	if err := validatePipe([]string{"#sanitise"}, false); err == nil {
		t.Error("accepted typo'd built-in #sanitise, want error")
	}
	// Feed pipe: #base allowed.
	if err := validatePipe([]string{"#readability", "#base"}, true); err != nil {
		t.Errorf("feed pipe with #base rejected: %v", err)
	}
}
