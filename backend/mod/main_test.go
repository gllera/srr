package mod

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestModuleBuiltinSanitize(t *testing.T) {
	m := New(nil)

	now := time.Now()
	item := &RawItem{
		GUID:      12345,
		Title:     "Test",
		Content:   `<p>Safe</p><script>alert("xss")</script>`,
		Link:      "http://example.com",
		Published: &now,
	}

	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("Process: %v", err)
	}

	if item.Content == `<p>Safe</p><script>alert("xss")</script>` {
		t.Error("script tag should have been removed")
	}
	// <p>Safe</p> should remain
	if item.Content != "<p>Safe</p>" {
		t.Errorf("content = %q, want %q", item.Content, "<p>Safe</p>")
	}
}

func TestModuleBuiltinSanitizePreservesVideo(t *testing.T) {
	m := New(nil)
	now := time.Now()
	item := &RawItem{
		GUID:  1,
		Title: "T",
		Content: `<p><video src="https://x/v.mp4" poster="https://x/p.jpg" controls preload="metadata" playsinline></video></p>` +
			`<video onerror="x()" src="javascript:alert(1)"></video>`,
		Link:      "http://example.com",
		Published: &now,
	}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	for _, want := range []string{
		"<video ",
		`src="https://x/v.mp4"`,
		`poster="https://x/p.jpg"`,
		"controls",
		`preload="metadata"`,
		"playsinline",
	} {
		if !strings.Contains(item.Content, want) {
			t.Errorf("sanitized output missing %q: %q", want, item.Content)
		}
	}
	for _, banned := range []string{"onerror", "javascript:"} {
		if strings.Contains(item.Content, banned) {
			t.Errorf("sanitizer let through %q: %q", banned, item.Content)
		}
	}
}

func TestModuleBuiltinSanitizeStripsClass(t *testing.T) {
	m := New(nil)

	now := time.Now()
	item := &RawItem{
		GUID:      1,
		Title:     "T",
		Content:   `<p class="x">a</p><div class="y z">b</div><span class="c">c</span>`,
		Link:      "http://example.com",
		Published: &now,
	}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if want := `<p>a</p><div>b</div><span>c</span>`; item.Content != want {
		t.Errorf("content = %q, want %q", item.Content, want)
	}
}

func TestModuleBuiltinMinify(t *testing.T) {
	m := New(nil)

	now := time.Now()
	item := &RawItem{
		GUID:      12345,
		Title:     "Test",
		Content:   "<p>  Hello   World  </p>",
		Link:      "http://example.com",
		Published: &now,
	}

	if err := m.Process(context.Background(), "#minify", item); err != nil {
		t.Fatalf("Process: %v", err)
	}

	// Minified HTML should have reduced whitespace
	if item.Content == "<p>  Hello   World  </p>" {
		t.Error("content should have been minified")
	}
}

func TestModuleExternalProcessor(t *testing.T) {
	m := New(nil)

	now := time.Now()
	item := &RawItem{
		GUID:      99999,
		Title:     "Original",
		Content:   "original content",
		Link:      "http://example.com",
		Published: &now,
	}

	// Use jq to modify the title field while keeping GUID intact
	err := m.Process(context.Background(), `jq -c '.title = "Modified"'`, item)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}

	if item.Title != "Modified" {
		t.Errorf("title = %q, want %q", item.Title, "Modified")
	}
	if item.GUID != 99999 {
		t.Errorf("GUID = %d, want 99999", item.GUID)
	}
}

func TestModuleExternalProcessorFailure(t *testing.T) {
	m := New(nil)

	now := time.Now()
	item := &RawItem{
		GUID:      12345,
		Title:     "Test",
		Content:   "content",
		Link:      "http://example.com",
		Published: &now,
	}

	err := m.Process(context.Background(), "false", item)
	if err == nil {
		t.Error("expected error from failing command")
	}
}

func TestModuleExternalInvalidJSON(t *testing.T) {
	m := New(nil)

	now := time.Now()
	item := &RawItem{
		GUID:      12345,
		Title:     "Test",
		Content:   "content",
		Link:      "http://example.com",
		Published: &now,
	}

	err := m.Process(context.Background(), "echo not-json", item)
	if err == nil {
		t.Error("expected error for invalid JSON output")
	}
}

func TestRegisterBuiltins(t *testing.T) {
	m := New(nil)

	// Verify built-in processors are registered
	builtins := []string{"#sanitize", "#minify", "#youtube", "#readability"}
	for _, name := range builtins {
		if _, ok := m.processors[name]; !ok {
			t.Errorf("built-in %q not registered", name)
		}
	}
}

// Built-ins that take no parameters reject any, so a stray option surfaces as
// a config error instead of being silently ignored.
func TestModuleBuiltinRejectsUnexpectedParam(t *testing.T) {
	m := New(nil)
	now := time.Now()
	for _, token := range []string{"#sanitize x=1", "#minify foo=bar"} {
		item := &RawItem{GUID: 1, Title: "T", Content: "<p>a</p>", Link: "http://example.com", Published: &now}
		if err := m.Process(context.Background(), token, item); err == nil {
			t.Errorf("token %q: expected unknown-parameter error", token)
		}
	}
}

// A name-with-params token must dispatch to the built-in, while a shell command
// whose first word is not a built-in still runs verbatim through /bin/sh.
func TestModuleProcessSplitsNameFromParams(t *testing.T) {
	m := New(nil)
	now := time.Now()

	// "#sanitize" with no params behaves exactly as before.
	item := &RawItem{GUID: 1, Title: "T", Content: `<p>ok</p><script>x</script>`, Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Content != "<p>ok</p>" {
		t.Errorf("sanitize without params: got %q", item.Content)
	}

	// A shell command containing '=' is not mistaken for a built-in param token.
	item = &RawItem{GUID: 2, Title: "Orig", Content: "c", Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), `jq -c '.title = "Shell"'`, item); err != nil {
		t.Fatalf("shell Process: %v", err)
	}
	if item.Title != "Shell" {
		t.Errorf("shell command should run verbatim, got title %q", item.Title)
	}
}
