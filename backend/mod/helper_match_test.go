package mod

import (
	"strings"
	"testing"
)

// TestParseMatchRejects pins the CONFIGURATION-error surface. Every one of
// these must fail at declaration time, because the alternative is a watch rule
// that silently matches nothing — indistinguishable from a subject that never
// appeared.
func TestParseMatchRejects(t *testing.T) {
	cases := []struct {
		name, spec, want string
	}{
		{"empty spec", "", "at least one condition"},
		{"only whitespace", "   ", "at least one condition"},
		{"unknown parameter", "titel=/x/", `unknown parameter "titel"`},
		{"bare token", "title", "want key=value"},
		{"duplicate key", "title=/a/ title=/b/", `duplicate parameter "title"`},
		{"unterminated quote", `any="breaking news`, "unterminated quote"},
		{"regex without slashes", "title=cve", "/pattern/"},
		{"regex missing closing slash", "title=/cve", "missing closing"},
		{"empty pattern", "title=//", "empty pattern"},
		{"unsupported flag", "title=/cve/g", "unsupported regex flag"},
		{"invalid regex", "title=/[/", "invalid regex"},
		{"negative min_words", "min_words=-1", "non-negative integer"},
		{"non-numeric min_words", "min_words=lots", "non-negative integer"},
		{"unknown language", "lang=xx", "unknown ISO 639-1 code"},
		{"empty language element", "lang=en,,es", "empty language code"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, err := ParseMatch(tc.spec)
			if err == nil {
				t.Fatalf("ParseMatch(%q) = %v, want an error", tc.spec, m)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("ParseMatch(%q) error = %q, want it to mention %q", tc.spec, err, tc.want)
			}
		})
	}
}

// TestMatchConditions is the semantic table: EVERY declared condition must hold
// (a rule is one description, not a list of alternatives), and lang= is
// fail-CLOSED — the deliberate inversion of #filter's keep_lang.
func TestMatchConditions(t *testing.T) {
	cases := []struct {
		name, spec           string
		title, content, lang string
		want                 bool
	}{{
		name: "title regex hits", spec: `title=/CVE-\d{4}/`,
		title: "CVE-2026-1 lands", want: true,
	}, {
		name: "title regex misses", spec: `title=/CVE-\d{4}/`,
		title: "nothing to see", want: false,
	}, {
		name: "case-insensitive flag", spec: "title=/cve/i",
		title: "CVE roundup", want: true,
	}, {
		name: "case-sensitive by default", spec: "title=/cve/",
		title: "CVE roundup", want: false,
	}, {
		// A literal space needs a metacharacter OR the whole /pattern/ quoted —
		// the token is split on whitespace before parameters are parsed.
		name: `content regex hits via \s`, spec: `content=/price\s+drop/`,
		title: "weekly", content: "<p>a price drop today</p>", want: true,
	}, {
		name: "content regex hits via a quoted pattern", spec: `content="/price drop/"`,
		content: "<p>a price drop today</p>", want: true,
	}, {
		name:  "any matches on the title alone",
		spec:  "any=/tracked/",
		title: "tracked name", content: "unrelated", want: true,
	}, {
		name:  "any matches on the content alone",
		spec:  "any=/tracked/",
		title: "headline", content: "a tracked name", want: true,
	}, {
		name:  "any misses both",
		spec:  "any=/tracked/",
		title: "headline", content: "body", want: false,
	}, {
		// The AND is the whole difference from #filter: every condition must
		// hold, so a rule can describe one thing precisely.
		name: "every condition must hold — one fails", spec: "title=/cve/i lang=en",
		title: "CVE roundup", lang: "es", want: false,
	}, {
		name: "every condition must hold — all pass", spec: "title=/cve/i lang=en",
		title: "CVE roundup", lang: "en", want: true,
	}, {
		name: "language tags fold like keep_lang's", spec: "lang=en",
		lang: "EN-us", want: true,
	}, {
		// FAIL-CLOSED. #filter's keep_lang keeps an unstamped item (never lose an
		// article); a watch must not CLAIM one on no evidence.
		name: "an unstamped language never matches a lang rule", spec: "lang=en",
		title: "anything", lang: "", want: false,
	}, {
		name: "a macrolanguage admits its varieties", spec: "lang=no",
		lang: "nn", want: true,
	}, {
		name: "min_words counts the content", spec: "min_words=3",
		content: "one two three", want: true,
	}, {
		name: "min_words below the floor", spec: "min_words=3",
		content: "one two", want: false,
	}, {
		name: "min_words=0 admits an empty body", spec: "min_words=0",
		content: "", want: true,
	}, {
		// Quoting spans the WHOLE value, delimiters included — a bare quoted
		// phrase is not a regex and is rejected (covered above).
		name: "a quoted /pattern/ keeps its spaces", spec: `any="/breaking news/"`,
		title: "breaking news at ten", want: true,
	}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, err := ParseMatch(tc.spec)
			if err != nil {
				t.Fatalf("ParseMatch(%q): %v", tc.spec, err)
			}
			if got := m.Match(tc.title, tc.content, tc.lang); got != tc.want {
				t.Fatalf("Match(%q, %q, %q) with %q = %v, want %v", tc.title, tc.content, tc.lang, tc.spec, got, tc.want)
			}
		})
	}
}

// TestMatchNilNeverClaims: a nil predicate is what a caller holds when a rule
// failed to compile, and it must never claim an article.
func TestMatchNilNeverClaims(t *testing.T) {
	var m *Match
	if m.Match("anything", "at all", "en") {
		t.Fatal("a nil Match claimed an article")
	}
}
