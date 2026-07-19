package mod

import (
	"context"
	"strings"
	"testing"
)

func TestSanitizeAllowsAudio(t *testing.T) {
	m := New()
	item := &RawItem{Content: `<audio src="https://cdn.example/a.mp3" controls preload="none"></audio>`}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	for _, want := range []string{"<audio", `src="https://cdn.example/a.mp3"`, "controls", `preload="none"`} {
		if !strings.Contains(item.Content, want) {
			t.Errorf("missing %q in %q", want, item.Content)
		}
	}
}

// A pipe step that self-hosts audio (srr-tts's TTS narration) writes a
// "#"-upload marker into <audio src> and relies on #sanitize keeping it until
// the end-of-pipeline upload rewrites it. The marker is a relative URL with an
// empty scheme, so it survives only because the policy allows relative URLs —
// a regression there leaves a player element with no source, silently.
func TestSanitizeKeepsAudioUploadMarker(t *testing.T) {
	m := New()
	item := &RawItem{Content: `<audio controls preload="none" src="#/tts/abc123.wav"></audio>`}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	if !strings.Contains(item.Content, `src="#/tts/abc123.wav"`) {
		t.Errorf("upload marker stripped from audio src: %q", item.Content)
	}
}

func TestSanitizeURLSchemes(t *testing.T) {
	m := New()
	item := &RawItem{Content: `<a href="tel:+15551234">c</a><a href="geo:37.78,-122.39">m</a>` +
		`<a href="magnet:?xt=urn:btih:abc">t</a><a href="mailto:a@b.com">e</a>` +
		`<a href="https://example.com/x">h</a><a href="ftp://host/f">f</a>` +
		`<a href="javascript:alert(1)">j</a>`}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	// Kept in lockstep with fmt.ts ANCHOR_ABS_OK: allowlisted schemes survive.
	for _, want := range []string{`href="tel:+15551234"`, `href="geo:37.78,-122.39"`, `href="magnet:?xt=urn:btih:abc"`, `href="mailto:a@b.com"`, `href="https://example.com/x"`} {
		if !strings.Contains(item.Content, want) {
			t.Errorf("allowlisted scheme dropped: missing %q in %q", want, item.Content)
		}
	}
	// Schemes outside the allowlist lose their href.
	for _, bad := range []string{"ftp://host/f", "javascript:alert"} {
		if strings.Contains(item.Content, bad) {
			t.Errorf("non-allowlisted scheme survived: %q in %q", bad, item.Content)
		}
	}
}

func TestSanitizeStripsAudioBadAttrsAndSource(t *testing.T) {
	m := New()
	item := &RawItem{Content: `<audio src="https://cdn.example/a.mp3" onplay="x()" preload="evil">` +
		`<source src="https://cdn.example/a.ogg"></audio>`}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	if strings.Contains(item.Content, "onplay") {
		t.Errorf("onplay survived: %q", item.Content)
	}
	if strings.Contains(item.Content, `preload="evil"`) {
		t.Errorf("bad preload value survived: %q", item.Content)
	}
	if strings.Contains(item.Content, "<source") {
		t.Errorf("<source> survived (not allowlisted): %q", item.Content)
	}
}
