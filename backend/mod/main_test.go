package mod

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestCappedBufferLimit pins the stdout cap that defends against a runaway
// subprocess OOMing the process (shared by the module and ingest exec paths).
func TestCappedBufferLimit(t *testing.T) {
	c := &cappedBuffer{limit: 8}
	if _, err := c.Write([]byte("1234")); err != nil {
		t.Fatalf("under limit: %v", err)
	}
	if _, err := c.Write([]byte("5678")); err != nil {
		t.Fatalf("at limit: %v", err)
	}
	if _, err := c.Write([]byte("9")); err == nil {
		t.Fatal("over limit: expected error, got nil")
	}
}

func TestModuleBuiltinSanitize(t *testing.T) {
	m := New()

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
	m := New()
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
	m := New()

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
	m := New()

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
	m := New()

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
	m := New()

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
	m := New()

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
	m := New()

	// Verify built-in processors are registered
	builtins := []string{"#sanitize", "#minify", "#readability"}
	for _, name := range builtins {
		if _, ok := m.processors[name]; !ok {
			t.Errorf("built-in %q not registered", name)
		}
	}
}

// Built-ins that take no parameters reject any, so a stray option surfaces as
// a config error instead of being silently ignored.
func TestModuleBuiltinRejectsUnexpectedParam(t *testing.T) {
	m := New()
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
	m := New()
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

func TestModuleSanitizeStripsDangerousPoster(t *testing.T) {
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T",
		Content: `<video poster="javascript:alert(1)" src="https://x/v.mp4"></video>` +
			`<video poster="https://x/ok.jpg"></video>` +
			`<video poster="assets/ab/cd.jpg"></video>`,
		Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if strings.Contains(item.Content, "javascript:") {
		t.Errorf("dangerous poster scheme survived: %q", item.Content)
	}
	if !strings.Contains(item.Content, `poster="https://x/ok.jpg"`) {
		t.Errorf("https poster dropped: %q", item.Content)
	}
	if !strings.Contains(item.Content, `poster="assets/ab/cd.jpg"`) {
		t.Errorf("relative assets/ poster dropped: %q", item.Content)
	}
}

func TestModuleEmptyShellOutputIsNoop(t *testing.T) {
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 7, Title: "Keep", Content: "<p>keep me</p>", Link: "http://e.com", Published: &now}
	// `true` exits 0 with empty stdout: must leave the item unchanged rather than
	// erroring on json.Unmarshal("") and (per feed.go) dropping the item.
	if err := m.Process(context.Background(), "true", item); err != nil {
		t.Fatalf("empty stdout should be a no-op, got: %v", err)
	}
	if item.Content != "<p>keep me</p>" || item.Title != "Keep" {
		t.Errorf("no-op shell mod mutated the item: %+v", item)
	}
}

// TestRunSubprocessWaitDelayBound verifies that a shell mod which backgrounds a
// child process that holds the inherited stdout pipe open does NOT block
// RunSubprocess for the grandchild's full lifetime. Before the WaitDelay fix,
// "sleep 8 & exit 0" kept the pipe open after /bin/sh exited, so cmd.Run()
// waited ~8 s and returned err=nil — a mislabelled SUCCESS that wedged the
// fetch worker. After the fix: cmd.WaitDelay force-closes the pipe after
// cancellation, so RunSubprocess returns well under the sleep duration AND with
// a non-nil error. The test overrides subprocessWaitDelay to 200 ms so it
// completes in well under 2 s (context timeout 1 s + 200 ms drain grace).
func TestRunSubprocessWaitDelayBound(t *testing.T) {
	orig := subprocessWaitDelay
	subprocessWaitDelay = 200 * time.Millisecond
	defer func() { subprocessWaitDelay = orig }()

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	start := time.Now()
	// /bin/sh exits immediately; the background sleep inherits stdout and keeps
	// the pipe open — without WaitDelay cmd.Run() blocks for 8 s with err=nil.
	_, err := RunSubprocess(ctx, "sleep 8 & exit 0", nil, "", nil)
	elapsed := time.Since(start)

	if elapsed >= 2*time.Second {
		t.Errorf("RunSubprocess took %v; want < 2s (background grandchild wedged the wait)", elapsed)
	}
	if err == nil {
		t.Error("RunSubprocess returned nil error; want non-nil (WaitDelay/timeout)")
	}
}

func TestModuleValidate(t *testing.T) {
	m := New()
	ctx := context.Background()
	if err := m.Validate(ctx, []string{"#sanitize", "#readability timeout=5s", "jq ."}); err != nil {
		t.Errorf("valid pipeline rejected: %v", err)
	}
	for _, bad := range [][]string{
		{"#sanitise"},                 // typo'd built-in
		{"#readability timeout=nope"}, // bad param value
		{"#sanitize x=1"},             // unknown param
		{"#base"},                     // resolvePipe expands #base earlier; a leftover is invalid
		{""},                          // empty step
	} {
		if err := m.Validate(ctx, bad); err == nil {
			t.Errorf("Validate accepted invalid pipeline %v", bad)
		}
	}
}
