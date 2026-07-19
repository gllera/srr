package mod

import (
	"strings"
	"testing"
)

// TestExtractTextStripsMarkup: tags are dropped, text nodes joined by spaces.
func TestExtractTextStripsMarkup(t *testing.T) {
	got := extractText("Title here", `<p>Hello <b>world</b></p><div>again</div>`, 4096)
	want := "Title here Hello world again"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}

// TestExtractTextSkipsScriptAndStyle: script/style subtrees contribute nothing
// (#filter may run before #sanitize, so they can still be present).
func TestExtractTextSkipsScriptAndStyle(t *testing.T) {
	content := `<p>visible</p><script>var hidden = "nope";</script><style>.x{color:red}</style><p>tail</p>`
	got := extractText("", content, 4096)
	want := "visible tail"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}

// TestExtractTextCollapsesWhitespace: runs of whitespace in title and content
// collapse to single spaces, edges trimmed.
func TestExtractTextCollapsesWhitespace(t *testing.T) {
	got := extractText("  a \n b ", "<p>  c\t\td  </p>", 4096)
	want := "a b c d"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}

// TestExtractTextDecodesEntities: the HTML parser decodes entities, so the
// detector sees real letters (café, not caf&eacute;).
func TestExtractTextDecodesEntities(t *testing.T) {
	got := extractText("", "<p>caf&eacute;</p>", 4096)
	want := "café"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}

// TestExtractTextHonorsByteCap: collection stops once max bytes are gathered
// (the last word may overshoot by its own length — that is fine).
func TestExtractTextHonorsByteCap(t *testing.T) {
	long := strings.Repeat("word ", 100)
	got := extractText("", "<p>"+long+"</p>", 32)
	if len(got) < 32 || len(got) > 40 {
		t.Errorf("len(extractText) = %d, want 32..40", len(got))
	}
	if !strings.HasPrefix(got, "word word") {
		t.Errorf("extractText = %q, want word-prefixed", got)
	}
}

// TestExtractTextPlainTextContent: content without any tags passes through.
func TestExtractTextPlainTextContent(t *testing.T) {
	got := extractText("", "just plain words", 4096)
	want := "just plain words"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}
