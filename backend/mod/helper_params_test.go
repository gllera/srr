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

	bad := []string{"", "abc", "MiB", "16XB", "12 34", "9999999999GiB"}
	for _, in := range bad {
		if _, err := parseBytes(in); err == nil {
			t.Errorf("parseBytes(%q) expected error", in)
		}
	}
}
