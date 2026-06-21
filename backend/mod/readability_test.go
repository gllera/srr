package mod

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestReadabilityRejectsBadParams(t *testing.T) {
	m := New()
	now := time.Now()
	for _, token := range []string{
		"#readability foo=bar",      // unknown key
		"#readability timeout=abc",  // unparseable duration
		"#readability maxbody=12xb", // unparseable size
		"#readability timeout",      // bare flag where a duration is required
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
