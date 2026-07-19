package mod

import "testing"

// DetectLang is the store-ready wrapper the end-of-pipeline stamp uses: the
// ISO 639-1 code on a confident detection, "" on the fail-open path. Fixture
// confidences are probe-verified in filter_test.go's langText comment block.
func TestDetectLang(t *testing.T) {
	tests := []struct {
		name    string
		title   string
		content string
		want    string
	}{
		{"confident Spanish", "", langTextES, "es"},
		{"confident German", "", langTextDE, "de"},
		{"confident Russian", "", langTextRU, "ru"},
		{"short text fails open", "Hi", "Too short", ""},
		{"low confidence fails open", "", langTextPT, ""},
		{"empty item fails open", "", "", ""},
		{"HTML is stripped before detection", "", "<p>" + langTextES + "</p><script>var x = 1;</script>", "es"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DetectLang(tt.title, tt.content); got != tt.want {
				t.Errorf("DetectLang() = %q, want %q", got, tt.want)
			}
		})
	}
}
