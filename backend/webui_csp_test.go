package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The admin page's Content-Security-Policy is written down three times: webUICSP
// (stamped on every API response), the <meta> in frontend/src/admin.html (the
// page's own policy on any host), and the reverse-proxy header in the
// docs/SELF-HOSTING.md Caddy example. They are meant to be the same policy —
// the meta minus frame-ancestors, which a <meta> CSP cannot carry — and nothing
// else keeps them in step, so this test does.
func TestAdminCSPCopiesAgree(t *testing.T) {
	const frameAncestors = "; frame-ancestors 'none'"
	if !strings.HasSuffix(webUICSP, frameAncestors) {
		t.Fatalf("webUICSP must end with %q (the one directive a meta CSP cannot carry): %q", frameAncestors, webUICSP)
	}

	html, err := os.ReadFile("../frontend/src/admin.html")
	if err != nil {
		t.Fatal(err)
	}
	meta := regexp.MustCompile(`(?s)http-equiv="Content-Security-Policy"\s+content="([^"]+)"`).FindSubmatch(html)
	if meta == nil {
		t.Fatal("admin.html has no Content-Security-Policy meta tag")
	}
	if got, want := string(meta[1]), strings.TrimSuffix(webUICSP, frameAncestors); got != want {
		t.Errorf("admin.html meta CSP drifted from webUICSP:\n got %q\nwant %q", got, want)
	}

	doc, err := os.ReadFile("../docs/SELF-HOSTING.md")
	if err != nil {
		t.Fatal(err)
	}
	hdr := regexp.MustCompile(`header @admin Content-Security-Policy "([^"]+)"`).FindSubmatch(doc)
	if hdr == nil {
		t.Fatal("docs/SELF-HOSTING.md has no `header @admin Content-Security-Policy` line")
	}
	if got := string(hdr[1]); got != webUICSP {
		t.Errorf("SELF-HOSTING.md @admin header drifted from webUICSP:\n got %q\nwant %q", got, webUICSP)
	}
}
