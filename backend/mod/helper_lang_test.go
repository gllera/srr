package mod

import "testing"

// Language fixtures, probe-verified against whatlanggo v1.0.1:
//
//	langTextEN → eng 0.714 (below the 0.8 gate — English prose commonly
//	             scores under it, so many English articles go unstamped)
//	langTextES → spa 1.000
//	langTextDE → deu 1.000 (Latin script)
//	langTextRU → rus 1.000 (distinct script)
//	langTextJA → jpn 1.000 (distinct script)
//	langTextPT → por 0.412 (Latin-script sibling — under the gate)
const (
	langTextEN = "The quick brown fox jumps over the lazy dog while the morning sun rises slowly over the quiet English countryside."
	langTextES = "El rápido zorro marrón salta sobre el perro perezoso mientras el sol de la mañana se eleva lentamente sobre el tranquilo campo español."
	langTextDE = "Der schnelle braune Fuchs springt über den faulen Hund, während die Morgensonne langsam über der ruhigen deutschen Landschaft aufgeht."
	langTextRU = "Быстрая коричневая лиса перепрыгивает через ленивую собаку, пока утреннее солнце медленно поднимается над тихой русской деревней."
	langTextJA = "素早い茶色の狐が怠け者の犬を飛び越え、朝日が静かな田園風景の上にゆっくりと昇っていきます。"
	langTextPT = "A rápida raposa marrom salta sobre o cão preguiçoso enquanto o sol da manhã nasce lentamente sobre o campo português tranquilo."
)

// DetectLang is the always-on stamp processItem applies: the ISO 639-1 code
// on a confident detection, "" on the fail-open path.
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
		{"confident Japanese", "", langTextJA, "ja"},
		{"English under the confidence gate fails open", "", langTextEN, ""},
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

// TestISO6391CodesAcceptsRealCodes: whatlanggo's own Lang→639-1 table maps
// Western Persian and Eastern Yiddish to "" ("No iso639-1"), but those
// languages DO carry fa/yi. Uncorrected, `#filter keep_lang=fa` was rejected
// as an unknown code — which fails Module.Validate and takes the whole feed
// down (Feed.Fetch sets ferr and skips it), and a Persian article could never
// be stamped in the first place. Norwegian is the alias case: whatlanggo only
// ever classifies the nb/nn varieties, never the "no" macrolanguage.
func TestISO6391CodesAcceptsRealCodes(t *testing.T) {
	for _, code := range []string{"fa", "yi", "en", "es", "de", "ru", "ja", "nb", "nn"} {
		if !iso6391Codes[code] {
			t.Errorf("iso6391Codes[%q] = false, want a valid ISO 639-1 code accepted", code)
		}
	}
	// Languages that genuinely have no 639-1 code stay rejected — the
	// allowlist's job is still catching typos.
	for _, code := range []string{"ceb", "ilo", "mai", "skr", "xx", "english"} {
		if iso6391Codes[code] {
			t.Errorf("iso6391Codes[%q] = true, want rejected (no ISO 639-1 code)", code)
		}
	}
	// "no" is a valid config code: the Norwegian macrolanguage.
	if !validLangCode("no") {
		t.Error("validLangCode(\"no\") = false, want the macrolanguage accepted")
	}
}

// A macrolanguage in the allowlist must admit every variety detection can
// report under it. whatlanggo only ever classifies nb (Bokmål) and nn
// (Nynorsk), never "no" — so folding "no" to a single variety made a Norwegian
// feed configured the obvious way silently discard its Nynorsk half, forever.
func TestKeepLangMacrolanguageAdmitsBothVarieties(t *testing.T) {
	set, err := parseKeepLangs("no")
	if err != nil {
		t.Fatalf("parseKeepLangs(\"no\"): %v", err)
	}
	for _, code := range []string{"no", "nb", "nn"} {
		if !set[code] {
			t.Errorf("keep_lang=no does not admit %q", code)
		}
	}
	if set["de"] {
		t.Error("keep_lang=no admits an unrelated language")
	}
	// Naming a specific variety still means only that variety.
	set, err = parseKeepLangs("nb")
	if err != nil {
		t.Fatalf("parseKeepLangs(\"nb\"): %v", err)
	}
	if set["nn"] || !set["nb"] {
		t.Errorf("keep_lang=nb = %v, want only nb", set)
	}
}

// TestNormalizeLang pins the folding applied to both the keep_lang allowlist
// and an item's declared Lang.
func TestNormalizeLang(t *testing.T) {
	// normalizeLang folds case and region subtags only — it never rewrites one
	// language to another. Macrolanguage expansion is a config-side concern
	// (langMacro), so "no" stays "no" here.
	for in, want := range map[string]string{
		"en": "en", "EN": "en", " En ": "en",
		"en-US": "en", "en_us": "en", "pt-BR": "pt",
		"no": "no", "NO-nb": "no", "nn": "nn",
		"": "", "english": "english", "xx": "xx",
	} {
		if got := normalizeLang(in); got != want {
			t.Errorf("normalizeLang(%q) = %q, want %q", in, got, want)
		}
	}
}
