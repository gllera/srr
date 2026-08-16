package mod

import (
	"strings"
	"testing"
)

func TestSanitizeAllowsAudio(t *testing.T) {
	got := runMod(t, "#sanitize", `<audio src="https://cdn.example/a.mp3" controls preload="none"></audio>`)
	for _, want := range []string{"<audio", `src="https://cdn.example/a.mp3"`, "controls", `preload="none"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
}

// A pipe step that self-hosts audio (srr-tts's TTS narration) writes a
// "#"-upload marker into <audio src> and relies on #sanitize keeping it until
// the end-of-pipeline upload rewrites it. The marker is a relative URL with an
// empty scheme, so it survives only because the policy allows relative URLs —
// a regression there leaves a player element with no source, silently.
func TestSanitizeKeepsAudioUploadMarker(t *testing.T) {
	got := runMod(t, "#sanitize", `<audio controls preload="none" src="#/tts/abc123.wav"></audio>`)
	if !strings.Contains(got, `src="#/tts/abc123.wav"`) {
		t.Errorf("upload marker stripped from audio src: %q", got)
	}
}

func TestSanitizeURLSchemes(t *testing.T) {
	got := runMod(t, "#sanitize", `<a href="tel:+15551234">c</a><a href="geo:37.78,-122.39">m</a>`+
		`<a href="magnet:?xt=urn:btih:abc">t</a><a href="mailto:a@b.com">e</a>`+
		`<a href="https://example.com/x">h</a><a href="ftp://host/f">f</a>`+
		`<a href="javascript:alert(1)">j</a>`)
	// Kept in lockstep with fmt.ts ANCHOR_ABS_OK: allowlisted schemes survive.
	for _, want := range []string{`href="tel:+15551234"`, `href="geo:37.78,-122.39"`, `href="magnet:?xt=urn:btih:abc"`, `href="mailto:a@b.com"`, `href="https://example.com/x"`} {
		if !strings.Contains(got, want) {
			t.Errorf("allowlisted scheme dropped: missing %q in %q", want, got)
		}
	}
	// Schemes outside the allowlist lose their href.
	for _, bad := range []string{"ftp://host/f", "javascript:alert"} {
		if strings.Contains(got, bad) {
			t.Errorf("non-allowlisted scheme survived: %q in %q", bad, got)
		}
	}
}

func TestSanitizeStripsAudioBadAttrsAndSource(t *testing.T) {
	got := runMod(t, "#sanitize", `<audio src="https://cdn.example/a.mp3" onplay="x()" preload="evil">`+
		`<source src="https://cdn.example/a.ogg"></audio>`)
	if strings.Contains(got, "onplay") {
		t.Errorf("onplay survived: %q", got)
	}
	if strings.Contains(got, `preload="evil"`) {
		t.Errorf("bad preload value survived: %q", got)
	}
	if strings.Contains(got, "<source") {
		t.Errorf("<source> survived (not allowlisted): %q", got)
	}
}

// FEB1's writer half: `id` is the LANDING of an in-page fragment link, so a
// footnote's target has to survive sanitization — but only in the conservative
// shape feeds actually emit. The reader mirrors this allowlist (fmt.ts
// ID_TOKEN) and adds one rule of its own (no "srr-" prefix, its chrome
// namespace), so keep the two in step.
func TestSanitizeIDAllowlist(t *testing.T) {
	keep := []string{"fn1", "fnref:3", "footnote-12", "note_4", "a"}
	drop := []string{"has space", "9leading", "-dash", "", strings.Repeat("x", 80)}

	for _, id := range keep {
		if got := runMod(t, "#sanitize", `<p id="`+id+`">note</p>`); !strings.Contains(got, `id="`+id+`"`) {
			t.Errorf("id %q was stripped: %q", id, got)
		}
	}
	for _, id := range drop {
		if got := runMod(t, "#sanitize", `<p id="`+id+`">note</p>`); strings.Contains(got, "id=") {
			t.Errorf("exotic id %q survived: %q", id, got)
		}
	}
}

// The round trip the two halves exist for: the marker link and its target both
// come out of the writer intact, so the reader has something to wire up.
func TestSanitizeKeepsFootnoteRoundTrip(t *testing.T) {
	got := runMod(t, "#sanitize", `<p>text<a href="#fn1" id="fnref1">1</a></p>`+
		`<ol><li id="fn1">the note <a href="#fnref1">&#8617;</a></li></ol>`)
	for _, want := range []string{`href="#fn1"`, `id="fnref1"`, `id="fn1"`, `href="#fnref1"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %q", want, got)
		}
	}
}

// srr-tts's narration sync: data-tts stamps a narrated block with its
// segment index, data-tts-t on the narration <audio> carries the segment
// start-time table. Both are display hints the reader consumes; the value
// regexes are what keeps them from ever smuggling markup — anything but a
// bounded digit run / a comma-joined decimal list is stripped.
func TestSanitizeKeepsTTSSyncAttrs(t *testing.T) {
	got := runMod(t, "#sanitize", `<audio controls preload="none" data-tts-t="0,4.2,11.8" src="#/tts/abc.wav"></audio>`+
		`<p data-tts="1">a</p><h2 data-tts="2">b</h2><li data-tts="3">c</li>`+
		`<div DATA-TTS="7">u</div>`)
	for _, want := range []string{`data-tts-t="0,4.2,11.8"`, `<p data-tts="1">`, `<h2 data-tts="2">`, `data-tts="3"`, `data-tts="7"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
}

func TestSanitizeRejectsMalformedTTSSyncAttrs(t *testing.T) {
	// The `&#10;`-embedded-newline cases below pin two subtle properties: entity
	// decoding happens BEFORE policy matching (so a literal newline reaches the
	// regex, not the four raw characters "&#10;"), and Go's regexp `$` — unlike
	// PCRE's — does not match just before a trailing/embedded newline, so it
	// can't be used to smuggle extra content after one.
	got := runMod(t, "#sanitize", `<audio controls data-tts-t="1,evil()" src="https://e.com/a.mp3"></audio>`+
		`<p data-tts="x">a</p><p data-tts="12345">b</p><span data-tts="1">inline</span>`+
		`<audio data-tts-t="1,2&#10;x" src="https://e.com/b.mp3"></audio>`+
		`<p data-tts="12&#10;">a</p>`+
		`<audio data-tts="1" src="https://e.com/c.mp3"></audio>`+
		`<p data-tts-t="1,2">x</p>`)
	if strings.Contains(got, "data-tts") {
		t.Errorf("malformed/misplaced tts attr survived: %q", got)
	}
}
