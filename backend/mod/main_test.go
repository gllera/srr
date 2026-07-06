package mod

import (
	"context"
	"io"
	"os"
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
		Content: `<p><video src="https://x/v.mp4" poster="https://x/p.jpg" controls preload="metadata" playsinline autoplay muted loop></video></p>` +
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
		// GIF-style playback (srr-x rebuilds GIF tweets as muted looping
		// video): these must survive or GIFs render click-to-play.
		"autoplay",
		"muted",
		"loop",
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
	builtins := []string{"#filter", "#sanitize", "#minify", "#readability", "#dedupmedia",
		"#unlazy", "#embed", "#enclosure", "#untrack"}
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
	for _, token := range []string{"#sanitize x=1", "#minify foo=bar", "#dedupmedia foo=bar",
		"#unlazy x=1", "#embed x=1", "#enclosure x=1", "#untrack x=1"} {
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

// TestModuleExternalDropSignal verifies the drop protocol: an external mod
// emitting {"drop":true} sets i.Drop=true and leaves Title/Content untouched;
// a normal transform (no "drop" field) keeps Drop=false; empty stdout (no-op)
// also keeps Drop=false.
func TestModuleExternalDropSignal(t *testing.T) {
	m := New()
	now := time.Now()

	// {"drop":true} sets Drop and leaves other fields intact.
	item := &RawItem{GUID: 1, Title: "Original", Content: "original content", Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), `echo '{"drop":true}'`, item); err != nil {
		t.Fatalf("drop signal: Process error: %v", err)
	}
	if !item.Drop {
		t.Error("drop signal: expected i.Drop=true after {\"drop\":true}")
	}
	if item.Title != "Original" {
		t.Errorf("drop signal: Title mutated to %q, want %q", item.Title, "Original")
	}
	if item.Content != "original content" {
		t.Errorf("drop signal: Content mutated to %q, want %q", item.Content, "original content")
	}

	// A normal transform sets title but NOT Drop.
	item2 := &RawItem{GUID: 2, Title: "Orig2", Content: "c2", Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), `jq -c '.title = "Modified"'`, item2); err != nil {
		t.Fatalf("normal transform: Process error: %v", err)
	}
	if item2.Drop {
		t.Error("normal transform: Drop should be false when stdout has no 'drop' field")
	}
	if item2.Title != "Modified" {
		t.Errorf("normal transform: Title = %q, want %q", item2.Title, "Modified")
	}

	// Empty stdout (no-op) must not set Drop.
	item3 := &RawItem{GUID: 3, Title: "Untouched", Content: "c3", Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), "true", item3); err != nil {
		t.Fatalf("no-op: Process error: %v", err)
	}
	if item3.Drop {
		t.Error("no-op: Drop should be false on empty stdout")
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
		{"#default"},                  // resolvePipe expands #default earlier; a leftover is invalid
		{""},                          // empty step
	} {
		if err := m.Validate(ctx, bad); err == nil {
			t.Errorf("Validate accepted invalid pipeline %v", bad)
		}
	}
}

// TestTailBufferKeepsRecentBytes pins the never-failing stderr capture: writes
// beyond the limit drop the OLDEST bytes (error text clusters at the end).
func TestTailBufferKeepsRecentBytes(t *testing.T) {
	b := &tailBuffer{limit: 8}
	for _, s := range []string{"aaaa", "bbbb", "cccc"} {
		if _, err := b.Write([]byte(s)); err != nil {
			t.Fatalf("Write(%q): %v", s, err)
		}
	}
	if got := string(b.buf); got != "bbbbcccc" {
		t.Errorf("buf = %q; want most recent 8 bytes %q", got, "bbbbcccc")
	}
}

// TestTailBufferTailRendering pins the error-message rendering: CR progress
// rewrites break lines, blanks drop, and only the trailing lines survive.
func TestTailBufferTailRendering(t *testing.T) {
	b := &tailBuffer{limit: stderrTailBytes}
	b.Write([]byte("progress 10%\rprogress 50%\rprogress 90%\n\n  error: bad input  \nexiting\n"))
	got := b.Tail()
	if !strings.Contains(got, "error: bad input") || !strings.Contains(got, "exiting") {
		t.Errorf("Tail() = %q; want the trailing error lines", got)
	}
	if strings.ContainsAny(got, "\r\n") {
		t.Errorf("Tail() = %q; want a single line", got)
	}
}

// TestRunCommandTimeoutStderrNotLeaked is the regression test for the asset
// stderr leak: a chatty asset command (a transcoder narrating progress) must
// not write to the process stderr; on success the capture is discarded.
func TestRunCommandTimeoutStderrNotLeaked(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stderr
	os.Stderr = w
	out, runErr := RunCommandTimeout(context.Background(), time.Minute, "/bin/sh", "-c", "echo noisy progress >&2; printf result")
	os.Stderr = saved
	w.Close()

	if runErr != nil {
		t.Fatalf("RunCommandTimeout: %v", runErr)
	}
	if string(out) != "result" {
		t.Errorf("stdout = %q; want %q", out, "result")
	}
	leaked, _ := io.ReadAll(r)
	r.Close()
	if len(leaked) != 0 {
		t.Errorf("stderr leaked to os.Stderr: %q", leaked)
	}
}

// TestRunCommandTimeoutStderrInFailure verifies a failing asset command's
// stderr tail rides the returned error so the caller's warn line carries the
// diagnostic.
func TestRunCommandTimeoutStderrInFailure(t *testing.T) {
	_, err := RunCommandTimeout(context.Background(), time.Minute, "/bin/sh", "-c", "printf 'p1\rp2\r' >&2; echo 'error: kaput' >&2; exit 3")
	if err == nil {
		t.Fatal("expected error from exit 3")
	}
	if !strings.Contains(err.Error(), "error: kaput") {
		t.Errorf("err = %q; want it to carry the stderr tail", err)
	}
}

// TestRunSubprocessStderrStillPassesThrough pins the OTHER side of the
// contract: external ingest/mod commands keep stderr passthrough (their
// documented log channel) — only the asset path captures.
func TestRunSubprocessStderrStillPassesThrough(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stderr
	os.Stderr = w
	_, runErr := RunSubprocess(context.Background(), "echo mod log >&2", nil, "", nil)
	os.Stderr = saved
	w.Close()

	if runErr != nil {
		t.Fatalf("RunSubprocess: %v", runErr)
	}
	got, _ := io.ReadAll(r)
	r.Close()
	if !strings.Contains(string(got), "mod log") {
		t.Errorf("stderr passthrough broken: captured %q", got)
	}
}
