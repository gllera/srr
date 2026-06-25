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
