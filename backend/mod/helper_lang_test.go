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
