package mod

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// A page with real article structure wrapped in nav/footer chrome so the
// extractor has something to distinguish: the <article> body should survive,
// the menu/footer should not.
var readabilityArticleHTML = `<!DOCTYPE html>
<html><head><title>Full Article</title></head>
<body>
<header><nav>HOME ABOUT navigation chrome that is not article content</nav></header>
<article>
<h1>The Real Headline</h1>
<p>` + strings.Repeat("This is the first substantial paragraph of the genuine article body that the extractor should retain in full. ", 6) + `</p>
<p>` + strings.Repeat("A second meaty paragraph continues the story with plenty of additional sentences to keep readability confident. ", 6) + `</p>
<p>` + strings.Repeat("And a closing paragraph wraps things up with even more words for good measure and density. ", 6) + `</p>
</article>
<footer>site-wide copyright boilerplate footer junk</footer>
</body></html>`

func TestReadabilityReplacesTruncatedContent(t *testing.T) {
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(readabilityArticleHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{
		GUID:      1,
		Title:     "Truncated",
		Content:   "<p>Teaser only. Read more&hellip;</p>",
		Link:      srv.URL + "/post/1",
		Published: &now,
	}
	if err := m.Process(context.Background(), "#readability", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !strings.Contains(item.Content, "substantial paragraph") {
		t.Errorf("expected extracted article body, got %q", item.Content)
	}
	if strings.Contains(item.Content, "navigation chrome") || strings.Contains(item.Content, "copyright boilerplate") {
		t.Errorf("readability should have dropped nav/footer, got %q", item.Content)
	}
}

// modRoundTripFunc adapts a function to http.RoundTripper for tests.
type modRoundTripFunc func(*http.Request) (*http.Response, error)

func (f modRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// TestFetchReadableNonHTTPLinkFailOpen pins the non-http(s) Link fail-open:
// fetchReadable returns ("", nil) before building any request, so #readability
// keeps the original content and issues NO network call.
func TestFetchReadableNonHTTPLinkFailOpen(t *testing.T) {
	client := &http.Client{Transport: modRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		t.Fatalf("no request should be issued for a non-http link, got %s", r.URL)
		return nil, nil
	})}
	for _, link := range []string{"ftp://x/y", "mailto:a@b.c", "://nohost", ""} {
		got, err := fetchReadable(context.Background(), client, link, 1<<20, "ua", nil)
		if err != nil {
			t.Errorf("fetchReadable(%q) err = %v, want nil (fail-open)", link, err)
		}
		if got != "" {
			t.Errorf("fetchReadable(%q) = %q, want empty (nothing to extract)", link, got)
		}
	}
}

func TestReadabilityEmptyLinkIsNoop(t *testing.T) {
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 2, Title: "T", Content: "<p>original</p>", Link: "", Published: &now}
	if err := m.Process(context.Background(), "#readability", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Content != "<p>original</p>" {
		t.Errorf("empty link should be a no-op, got %q", item.Content)
	}
}

func TestReadabilityFailsOpenOnHTTPError(t *testing.T) {
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 3, Title: "T", Content: "<p>keep me</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), "#readability", item); err != nil {
		t.Fatalf("Process should fail open, got err: %v", err)
	}
	if item.Content != "<p>keep me</p>" {
		t.Errorf("content should be preserved on fetch error, got %q", item.Content)
	}
}

func TestReadabilityTimeoutParamFailsOpen(t *testing.T) {
	// Handler stalls well past the configured timeout so the request context
	// deadline trips first; the module must keep the original content.
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte(readabilityArticleHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T", Content: "<p>keep me</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), "#readability timeout=1ms", item); err != nil {
		t.Fatalf("Process should fail open on timeout, got err: %v", err)
	}
	if item.Content != "<p>keep me</p>" {
		t.Errorf("content should be preserved when the fetch times out, got %q", item.Content)
	}
}

func TestReadabilityMaxBodyParamTruncates(t *testing.T) {
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(readabilityArticleHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T", Content: "<p>teaser</p>", Link: srv.URL, Published: &now}
	// A 10-byte cap truncates the document before the <article> body, so there
	// is nothing to extract and the original content survives — proving maxbody
	// is wired (the default cap replaces it, see TestReadabilityReplaces...).
	if err := m.Process(context.Background(), "#readability maxbody=10", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if strings.Contains(item.Content, "substantial paragraph") {
		t.Errorf("maxbody=10 should have prevented extraction, got %q", item.Content)
	}
}

func TestReadabilityUAParam(t *testing.T) {
	// Some WAFs 406 on UA keywords (blogdechollos.com blocks "extractor"), so
	// ua= overrides the request User-Agent per pipeline position. The value is
	// quoted because real UAs contain spaces — this also exercises the
	// quote-aware param tokenizer end-to-end through Module.Process.
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	var mu sync.Mutex
	var agents []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		agents = append(agents, r.Header.Get("User-Agent"))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(readabilityArticleHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()

	item := &RawItem{GUID: 1, Title: "T", Content: "<p>teaser</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), `#readability ua="Custom Agent/2.0 (Test)"`, item); err != nil {
		t.Fatalf("Process with ua=: %v", err)
	}
	if !strings.Contains(item.Content, "substantial paragraph") {
		t.Errorf("quoted ua= token should still extract, got %q", item.Content)
	}

	item2 := &RawItem{GUID: 2, Title: "T", Content: "<p>teaser</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), "#readability", item2); err != nil {
		t.Fatalf("Process without ua=: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(agents) != 2 {
		t.Fatalf("expected 2 requests, got %d", len(agents))
	}
	if agents[0] != "Custom Agent/2.0 (Test)" {
		t.Errorf("ua= override not sent: got %q", agents[0])
	}
	if agents[1] != readabilityUserAgent {
		t.Errorf("absent ua= should keep the default identity: got %q", agents[1])
	}
}

// A page whose genuine article body is short while sidebar/widget chrome is
// text-dense — the readability heuristic picks the wrong block on such pages
// (deal blogs), which is what selector= exists to override.
var readabilityShortBodyHTML = `<!DOCTYPE html>
<html><head><title>Deal</title></head>
<body>
<div class="widget"><h3>MOST VIEWED</h3>
<p>` + strings.Repeat("Dense sidebar widget text that out-scores a two-sentence deal body in the readability candidate ranking. ", 12) + `</p>
</div>
<div class="pic"><img src="x.jpg"></div>
<div class="entry-content"><div class="inner"><p>The gadget drops to 1,89&euro; on Amazon, 21% off its usual price.</p><p>Deal body second sentence.</p></div></div>
<footer>copyright</footer>
</body></html>`

func TestReadabilitySelectorParam(t *testing.T) {
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(readabilityShortBodyHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T", Content: "<p>teaser</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), "#readability selector=div.entry-content", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !strings.Contains(item.Content, "drops to 1,89") || !strings.Contains(item.Content, "second sentence") {
		t.Errorf("selector should extract the entry-content body, got %q", item.Content)
	}
	if strings.Contains(item.Content, "Dense sidebar widget") {
		t.Errorf("selector must bypass the heuristic entirely, got %q", item.Content)
	}
}

func TestReadabilitySelectorUnionConcatenatesMatches(t *testing.T) {
	// selector= concatenates EVERY match in document order — how disjoint
	// blocks (hero image + article body) become one article. blogdechollos
	// keeps its product image outside the articleBody block, which is the
	// real-world case behind this.
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(readabilityShortBodyHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T", Content: "<p>teaser</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), "#readability selector=div.pic,div.entry-content", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	img := strings.Index(item.Content, `img src="x.jpg"`)
	body := strings.Index(item.Content, "drops to 1,89")
	if img < 0 || body < 0 {
		t.Fatalf("expected image and body, got %q", item.Content)
	}
	if img > body {
		t.Errorf("blocks must keep document order (image first), got %q", item.Content)
	}
	if strings.Contains(item.Content, "Dense sidebar widget") {
		t.Errorf("union must not pull unselected blocks, got %q", item.Content)
	}
}

func TestReadabilitySelectorNestedMatchFoldsIntoAncestor(t *testing.T) {
	// A match inside an already-matched block is that block's content — it
	// must not render a second copy.
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(readabilityShortBodyHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T", Content: "<p>teaser</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), "#readability selector=div.entry-content,div.inner", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if got := strings.Count(item.Content, "second sentence"); got != 1 {
		t.Errorf("nested match duplicated content %d times: %q", got, item.Content)
	}
}

func TestReadabilitySelectorChildlessMatchRendersElement(t *testing.T) {
	// A matched void/childless element (<img>) has no inner HTML — the
	// element itself is the content.
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(readabilityShortBodyHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T", Content: "<p>teaser</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), "#readability selector=img", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !strings.Contains(item.Content, `img src="x.jpg"`) {
		t.Errorf("childless match should render the element itself, got %q", item.Content)
	}
}

func TestReadabilitySelectorNoMatchKeepsOriginal(t *testing.T) {
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(readabilityShortBodyHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T", Content: "<p>keep me</p>", Link: srv.URL, Published: &now}
	// No fallback to the heuristic on a selector miss: a typo'd selector must
	// surface as "content never changes" (plus a WARN), not as silently
	// different extraction behavior.
	if err := m.Process(context.Background(), "#readability selector=div.nope", item); err != nil {
		t.Fatalf("Process should fail open on selector miss, got err: %v", err)
	}
	if item.Content != "<p>keep me</p>" {
		t.Errorf("selector miss should keep original content, got %q", item.Content)
	}
}

func TestReadabilityDefaultUAAvoidsScraperKeywords(t *testing.T) {
	// Keyword-scanning WAFs block scraper-sounding UA tokens with a 406
	// (blogdechollos.com rejects any UA containing "extractor"), so the
	// default identity must stay keyword-free while still honestly naming
	// SRR. TestReadabilityUAParam pins that this constant is what actually
	// rides the wire when ua= is absent.
	for _, kw := range []string{"extractor", "scraper", "crawler", "spider"} {
		if strings.Contains(strings.ToLower(readabilityUserAgent), kw) {
			t.Errorf("default UA contains WAF-trigger keyword %q: %q", kw, readabilityUserAgent)
		}
	}
	if !strings.Contains(readabilityUserAgent, "SRR/") {
		t.Errorf("default UA should still identify SRR: %q", readabilityUserAgent)
	}
}

func TestReadabilityRejectsBadParams(t *testing.T) {
	m := New()
	now := time.Now()
	for _, token := range []string{
		"#readability foo=bar",      // unknown key
		"#readability timeout=abc",  // unparseable duration
		"#readability maxbody=12xb", // unparseable size
		"#readability timeout",      // bare flag where a duration is required
		"#readability ua=",          // explicitly empty UA
		`#readability ua="x`,        // unterminated quote
		"#readability selector=[",   // unparseable CSS selector
	} {
		item := &RawItem{GUID: 1, Title: "T", Content: "<p>x</p>", Link: "http://example.com", Published: &now}
		if err := m.Process(context.Background(), token, item); err == nil {
			t.Errorf("token %q: expected a configuration error", token)
		}
	}
}

func TestReadabilityPreservesGUIDAndPublished(t *testing.T) {
	allowPrivateForTest(t) // test server is on loopback; opt out of the SSRF guard
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(readabilityArticleHTML))
	}))
	defer srv.Close()

	m := New()
	now := time.Now()
	item := &RawItem{GUID: 42, Title: "T", Content: "<p>teaser</p>", Link: srv.URL, Published: &now}
	if err := m.Process(context.Background(), "#readability", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.GUID != 42 {
		t.Errorf("GUID changed: got %d", item.GUID)
	}
	if item.Published == nil || !item.Published.Equal(now) {
		t.Errorf("Published changed: got %v", item.Published)
	}
}
