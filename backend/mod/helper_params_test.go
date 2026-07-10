package mod

import (
	"testing"
	"time"
)

func TestParseParams(t *testing.T) {
	p, err := parseParams([]string{"timeout=30s", "maxbody=8MiB"})
	if err != nil {
		t.Fatalf("parseParams: %v", err)
	}
	if p["timeout"] != "30s" || p["maxbody"] != "8MiB" {
		t.Errorf("unexpected params: %v", p)
	}

	// Empty input yields a nil map, not an error.
	if got, err := parseParams(nil); err != nil || got != nil {
		t.Errorf("parseParams(nil) = %v, %v; want nil, nil", got, err)
	}

	for _, bad := range [][]string{
		{"=value"},     // empty key
		{"verbose"},    // bare token (no '='); key=value is required
		{"k=v", "k=w"}, // duplicate key
	} {
		if _, err := parseParams(bad); err == nil {
			t.Errorf("parseParams(%v) expected error", bad)
		}
	}
}

func TestSplitParamFields(t *testing.T) {
	// Plain fields split on whitespace, as before quoting existed.
	got, err := splitParamFields("timeout=30s maxbody=8MiB")
	if err != nil {
		t.Fatalf("splitParamFields: %v", err)
	}
	if len(got) != 2 || got[0] != "timeout=30s" || got[1] != "maxbody=8MiB" {
		t.Errorf("plain fields: got %q", got)
	}

	// A double-quoted span keeps its spaces and drops the quotes, so a value
	// with spaces (a User-Agent) survives as one field.
	got, err = splitParamFields(`ua="Mozilla/5.0 (X11; Linux) Chrome" timeout=30s`)
	if err != nil {
		t.Fatalf("splitParamFields quoted: %v", err)
	}
	if len(got) != 2 || got[0] != "ua=Mozilla/5.0 (X11; Linux) Chrome" || got[1] != "timeout=30s" {
		t.Errorf("quoted value: got %q", got)
	}

	// Quote toggling mid-field: paired quotes anywhere glue the span together.
	got, err = splitParamFields(`k=a"b c"d`)
	if err != nil {
		t.Fatalf("splitParamFields mid-field: %v", err)
	}
	if len(got) != 1 || got[0] != "k=ab cd" {
		t.Errorf("mid-field quotes: got %q", got)
	}

	// Empty and whitespace-only input yield no fields.
	for _, in := range []string{"", "   ", "\t"} {
		if got, err := splitParamFields(in); err != nil || got != nil {
			t.Errorf("splitParamFields(%q) = %q, %v; want nil, nil", in, got, err)
		}
	}

	// An unterminated quote is a configuration error, not a silent guess.
	if _, err := splitParamFields(`ua="Mozilla/5.0`); err == nil {
		t.Errorf("unterminated quote should error")
	}
}

func TestParamsString(t *testing.T) {
	const def = "default-agent"

	// Absent → default.
	if s, err := Params(nil).String("ua", def); err != nil || s != def {
		t.Errorf("absent: got %q, %v; want %q, nil", s, err, def)
	}
	// Present → verbatim value.
	if s, err := (Params{"ua": "Custom Agent/2.0"}).String("ua", def); err != nil || s != "Custom Agent/2.0" {
		t.Errorf("present: got %q, %v", s, err)
	}
	// Explicitly empty is a configuration error (an empty UA is never intended).
	if _, err := (Params{"ua": ""}).String("ua", def); err == nil {
		t.Errorf("empty value should error")
	}
}

func TestParamsOnly(t *testing.T) {
	if err := Params(nil).only("a", "b"); err != nil {
		t.Errorf("nil params should pass only(): %v", err)
	}
	if err := (Params{"timeout": "1s"}).only("timeout", "maxbody"); err != nil {
		t.Errorf("allowed key rejected: %v", err)
	}
	if err := (Params{"nope": "1"}).only("timeout"); err == nil {
		t.Errorf("unknown key should be rejected")
	}
}

func TestParamsDuration(t *testing.T) {
	def := 20 * time.Second

	// Absent → default.
	if d, err := Params(nil).Duration("timeout", def); err != nil || d != def {
		t.Errorf("absent: got %v, %v; want %v, nil", d, err, def)
	}
	// Present and valid.
	if d, err := (Params{"timeout": "45s"}).Duration("timeout", def); err != nil || d != 45*time.Second {
		t.Errorf("valid: got %v, %v", d, err)
	}
	// Invalid syntax and non-positive both error.
	for _, v := range []string{"abc", "0s", "-5s"} {
		if _, err := (Params{"timeout": v}).Duration("timeout", def); err == nil {
			t.Errorf("Duration(%q) expected error", v)
		}
	}
}

func TestParamsBytes(t *testing.T) {
	const def int64 = 8 << 20

	if n, err := Params(nil).Bytes("maxbody", def); err != nil || n != def {
		t.Errorf("absent: got %v, %v; want %v, nil", n, err, def)
	}
	if n, err := (Params{"maxbody": "16MiB"}).Bytes("maxbody", def); err != nil || n != 16<<20 {
		t.Errorf("valid: got %v, %v", n, err)
	}
	for _, v := range []string{"0", "-1", "12xb"} {
		if _, err := (Params{"maxbody": v}).Bytes("maxbody", def); err == nil {
			t.Errorf("Bytes(%q) expected error", v)
		}
	}
}

func TestParseBytes(t *testing.T) {
	ok := map[string]int64{
		"16":    16,
		"16B":   16,
		"512b":  512,
		"8MiB":  8 << 20,
		"1KiB":  1 << 10,
		"1GiB":  1 << 30,
		"8MB":   8_000_000,
		"500kb": 500_000,
		"2gb":   2_000_000_000,
	}
	for in, want := range ok {
		got, err := parseBytes(in)
		if err != nil {
			t.Errorf("parseBytes(%q): unexpected error %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parseBytes(%q) = %d, want %d", in, got, want)
		}
	}

	bad := []string{"", "abc", "MiB", "16XB", "12 34", "9999999999GiB", "99999999999999999999"}
	for _, in := range bad {
		if _, err := parseBytes(in); err == nil {
			t.Errorf("parseBytes(%q) expected error", in)
		}
	}
}
