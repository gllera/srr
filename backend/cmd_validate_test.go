package main

import "testing"

func TestValidateTagRejectsNumeric(t *testing.T) {
	for _, ok := range []string{"", "news", "2024a"} {
		if err := validateTag(ok); err != nil {
			t.Errorf("validateTag(%q) = %v, want nil", ok, err)
		}
	}
	// "tech-2024" now rejected: dash → underscore on OPML import (B2).
	for _, bad := range []string{"2024", "5", "007", "tech-2024"} {
		if err := validateTag(bad); err == nil {
			t.Errorf("validateTag(%q) = nil, want error (numeric-only or would be mutated by import)", bad)
		}
	}
}

func TestValidatePipe(t *testing.T) {
	// default recipe: #default disallowed; unknown #-token disallowed; built-ins/shell ok.
	if err := validatePipe([]string{"#sanitize", "#minify", "jq ."}, false); err != nil {
		t.Errorf("valid default pipe rejected: %v", err)
	}
	if err := validatePipe([]string{"#default"}, false); err == nil {
		t.Error("default recipe accepted #default, want error")
	}
	if err := validatePipe([]string{"#sanitise"}, false); err == nil {
		t.Error("accepted typo'd #sanitise, want error")
	}
	// non-default recipe: #default allowed.
	if err := validatePipe([]string{"#readability", "#default"}, true); err != nil {
		t.Errorf("non-default recipe with #default rejected: %v", err)
	}
}
