package mod

import (
	"strings"
	"testing"
	"unicode/utf8"
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

// TestExtractTextHonorsByteCap: max is a HARD cap, never overshot.
func TestExtractTextHonorsByteCap(t *testing.T) {
	long := strings.Repeat("word ", 100)
	got := extractText("", "<p>"+long+"</p>", 32)
	if len(got) > 32 {
		t.Errorf("len(extractText) = %d, want <= 32", len(got))
	}
	if !strings.HasPrefix(got, "word word") {
		t.Errorf("extractText = %q, want word-prefixed", got)
	}
}

// TestExtractTextCapsWhitespaceFreeText is the regression guard for the cap:
// the byte budget is checked before each word is written, so a single
// whitespace-free token used to be written IN FULL — the cap bounded nothing
// and a 2 MB run of one "word" cost ~375ms of detection per article, twice.
// Scripts without spaces (Japanese, Chinese) hit this structurally, not just
// adversarially, so the fix truncates rather than drops: the text must still
// be there, just bounded.
func TestExtractTextCapsWhitespaceFreeText(t *testing.T) {
	got := extractText("", "<p>"+strings.Repeat("a", 100_000)+"</p>", 4096)
	if len(got) != 4096 {
		t.Errorf("len(extractText) = %d, want exactly 4096", len(got))
	}

	// A no-space CJK paragraph is one token too: it must survive truncated,
	// under the cap, and as valid UTF-8 — a split rune is garbage to the
	// detector.
	ja := strings.Repeat("素早い茶色の狐が怠け者の犬を飛び越える。", 500)
	got = extractText("", "<p>"+ja+"</p>", 4096)
	if len(got) > 4096 {
		t.Errorf("len(extractText) = %d, want <= 4096", len(got))
	}
	if len(got) < 4000 {
		t.Errorf("len(extractText) = %d, want the text truncated, not dropped", len(got))
	}
	if !utf8.ValidString(got) {
		t.Error("extractText split a rune; want valid UTF-8")
	}
	if !strings.HasPrefix(got, "素早い") {
		t.Errorf("extractText = %.30q…, want the CJK prefix", got)
	}
}

// The whole document is parsed, never a byte-truncated prefix of it. A byte
// cut on markup is not a cut on text: text-sparse markup pushes the real text
// past any byte budget, and the extract then either comes back empty or — far
// worse — holds only a short foreign boilerplate line that survived the cut and
// gets classified CONFIDENTLY. A wrong-but-confident stamp makes #filter
// keep_lang drop the article for good (its GUID is already in the dedup
// boundary), which is the one outcome the fail-open design must never produce.
func TestExtractTextParsesPastSparseMarkup(t *testing.T) {
	const spanish = "El rápido zorro marrón salta sobre el perro perezoso mientras el sol de la mañana se eleva lentamente."

	// A huge inline data: URI ahead of the text.
	sparse := `<img src="data:image/png;base64,` + strings.Repeat("A", 300_000) + `">` + "<p>" + spanish + "</p>"
	if got := extractText("", sparse, langMaxTextLen); !strings.Contains(got, "rápido") {
		t.Errorf("text behind a sparse data: URI was lost: %.60q…", got)
	}

	// A long run of empty tags ahead of the text.
	padded := strings.Repeat(`<span class="pad"></span>`, 12_000) + "<p>" + spanish + "</p>"
	if got := extractText("", padded, langMaxTextLen); !strings.Contains(got, "rápido") {
		t.Errorf("text behind a tag-only run was lost: %.60q…", got)
	}

	// The dangerous shape: foreign boilerplate, then sparse markup, then the
	// real body. Truncating would classify the boilerplate alone.
	fr := "Cet article est aussi disponible en version imprimee chez notre partenaire local."
	mixed := "<p>" + fr + "</p>" + strings.Repeat(`<span class="pad"></span>`, 12_000) +
		"<p>" + strings.Repeat(spanish, 40) + "</p>"
	if got := DetectLang("", mixed); got == "fr" {
		t.Errorf("DetectLang = %q: a truncated parse classified the boilerplate, not the article", got)
	}
}

// TestExtractTextCapCountsSeparators: the cap holds across many small words
// too — the separating spaces are part of the budget.
func TestExtractTextCapCountsSeparators(t *testing.T) {
	for _, max := range []int{1, 2, 5, 17, 64} {
		got := extractText("title words here", strings.Repeat("<p>x y z</p>", 50), max)
		if len(got) > max {
			t.Errorf("max=%d: len(extractText) = %d, want <= %d (%q)", max, len(got), max, got)
		}
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
