package mod

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// stubAssets maps source URLs to keys; an entry mapped to "" returns an error
// so tests can exercise the graceful-degrade path.
type stubAssets struct {
	keys  map[string]string
	calls []string
}

func (s *stubAssets) Fetch(_ context.Context, srcURL string) (string, error) {
	s.calls = append(s.calls, srcURL)
	key, ok := s.keys[srcURL]
	if !ok || key == "" {
		return "", fmt.Errorf("stub: no key for %q", srcURL)
	}
	return key, nil
}

func TestRewriteMediaRewritesImgVideoPoster(t *testing.T) {
	assets := &stubAssets{keys: map[string]string{
		"https://cdn.example.com/a.jpg":     "assets/aa/1111.jpg",
		"https://cdn.example.com/v.mp4":     "assets/bb/2222.mp4",
		"https://cdn.example.com/thumb.jpg": "assets/cc/3333.jpg",
	}}
	in := `<p><img src="https://cdn.example.com/a.jpg" alt="x"></p>` +
		`<video src="https://cdn.example.com/v.mp4" poster="https://cdn.example.com/thumb.jpg" controls></video>`

	out, err := RewriteMedia(context.Background(), assets, in)
	if err != nil {
		t.Fatalf("RewriteMedia: %v", err)
	}
	for _, want := range []string{"assets/aa/1111.jpg", "assets/bb/2222.mp4", "assets/cc/3333.jpg"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n%s", want, out)
		}
	}
	if strings.Contains(out, "cdn.example.com") {
		t.Errorf("original CDN URL not rewritten:\n%s", out)
	}
	if !strings.Contains(out, `alt="x"`) {
		t.Errorf("non-media attribute dropped:\n%s", out)
	}
}

func TestRewriteMediaLeavesNonMediaUntouched(t *testing.T) {
	assets := &stubAssets{keys: map[string]string{}}
	in := `<p>hello <a href="https://example.com/page">link</a></p>`

	out, err := RewriteMedia(context.Background(), assets, in)
	if err != nil {
		t.Fatalf("RewriteMedia: %v", err)
	}
	if !strings.Contains(out, `href="https://example.com/page"`) {
		t.Errorf("anchor href altered:\n%s", out)
	}
	if len(assets.calls) != 0 {
		t.Errorf("Fetch called for non-media URL: %v", assets.calls)
	}
}

func TestRewriteMediaKeepsOriginalOnFetchError(t *testing.T) {
	// Mapped to "" → stub returns an error.
	assets := &stubAssets{keys: map[string]string{"https://cdn.example.com/a.jpg": ""}}
	in := `<img src="https://cdn.example.com/a.jpg">`

	out, err := RewriteMedia(context.Background(), assets, in)
	if err != nil {
		t.Fatalf("RewriteMedia: %v", err)
	}
	if !strings.Contains(out, "https://cdn.example.com/a.jpg") {
		t.Errorf("original URL not preserved on Fetch error:\n%s", out)
	}
}

func TestRewriteMediaNilAssetsNoOp(t *testing.T) {
	in := `<img src="https://cdn.example.com/a.jpg">`
	out, err := RewriteMedia(context.Background(), nil, in)
	if err != nil {
		t.Fatalf("RewriteMedia: %v", err)
	}
	if out != in {
		t.Errorf("nil assets should be a no-op: got %q want %q", out, in)
	}
}

func TestRewriteMediaSkipsRelativeAndDataURLs(t *testing.T) {
	assets := &stubAssets{keys: map[string]string{}}
	in := `<img src="assets/aa/1111.jpg"><img src="data:image/png;base64,AAAA">`
	out, err := RewriteMedia(context.Background(), assets, in)
	if err != nil {
		t.Fatalf("RewriteMedia: %v", err)
	}
	if len(assets.calls) != 0 {
		t.Errorf("Fetch called for non-http URL: %v", assets.calls)
	}
	if !strings.Contains(out, "assets/aa/1111.jpg") || !strings.Contains(out, "data:image/png") {
		t.Errorf("non-http src altered:\n%s", out)
	}
}
