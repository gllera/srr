package mod

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Params are the key=value parameters parsed from a pipeline module token.
// In a pipe entry like "#readability timeout=30s maxbody=8MiB", the name is
// "#readability" and the Params are {"timeout": "30s", "maxbody": "8MiB"}.
// They let a single built-in be tuned per pipeline position without new tokens.
type Params map[string]string

// splitParamFields splits the post-name portion of a built-in token into
// key=value fields. Whitespace separates fields, but a double-quoted span
// keeps its whitespace literally and the quotes are dropped, so values that
// contain spaces (e.g. a browser User-Agent in `ua="Mozilla/5.0 (X11)"`) stay
// one field. An unterminated quote is a configuration error; there is no
// escape syntax for a literal '"' inside a quoted span.
func splitParamFields(s string) ([]string, error) {
	var fields []string
	rest := s
	for {
		rest = strings.TrimLeftFunc(rest, unicode.IsSpace)
		if rest == "" {
			return fields, nil
		}
		var b strings.Builder
		inQuote := false
		i := 0
		for ; i < len(rest); i++ {
			switch c := rest[i]; {
			case c == '"':
				inQuote = !inQuote
			case !inQuote && unicode.IsSpace(rune(c)):
				// Field boundary. Multi-byte whitespace runes never appear
				// mid-UTF-8 sequence, so byte-wise scanning is UTF-8 safe;
				// any non-ASCII whitespace is caught by the outer TrimLeft.
				goto done
			default:
				b.WriteByte(c)
			}
		}
	done:
		if inQuote {
			return nil, fmt.Errorf("unterminated quote in parameters %q", s)
		}
		fields = append(fields, b.String())
		rest = rest[i:]
	}
}

// String returns the raw value for key, or def when key is absent. The value
// must be non-empty — quote it when it contains spaces (see splitParamFields).
func (p Params) String(key, def string) (string, error) {
	v, ok := p[key]
	if !ok {
		return def, nil
	}
	if v == "" {
		return "", fmt.Errorf("parameter %s must not be empty", key)
	}
	return v, nil
}

// parseParams turns the post-name fields of a built-in token into a Params map.
// Each field must be key=value; a bare token (no '='), an empty key, or a
// repeated key is a configuration error reported to the caller (no silent drops).
func parseParams(fields []string) (Params, error) {
	if len(fields) == 0 {
		return nil, nil
	}
	p := make(Params, len(fields))
	for _, f := range fields {
		k, v, ok := strings.Cut(f, "=")
		if k == "" || !ok {
			return nil, fmt.Errorf("malformed parameter %q, want key=value", f)
		}
		if _, dup := p[k]; dup {
			return nil, fmt.Errorf("duplicate parameter %q", k)
		}
		p[k] = v
	}
	return p, nil
}

// only reports an error if Params holds any key outside allowed. Built-ins call
// it so a typo (e.g. "timout=30s") fails loudly instead of being silently
// ignored, which would otherwise look like the parameter had no effect.
func (p Params) only(allowed ...string) error {
	for k := range p {
		if !slices.Contains(allowed, k) {
			return fmt.Errorf("unknown parameter %q", k)
		}
	}
	return nil
}

// Duration returns the parsed duration for key, or def when key is absent.
// The value uses Go duration syntax (e.g. "30s", "1m30s") and must be positive.
func (p Params) Duration(key string, def time.Duration) (time.Duration, error) {
	v, ok := p[key]
	if !ok {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("parameter %s=%q: %w", key, v, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("parameter %s=%q must be positive", key, v)
	}
	return d, nil
}

// Bytes returns the parsed byte size for key, or def when key is absent.
// The value is an integer with an optional unit suffix: decimal KB/MB/GB
// (1000-based) or binary KiB/MiB/GiB (1024-based); a bare number or B is bytes.
func (p Params) Bytes(key string, def int64) (int64, error) {
	v, ok := p[key]
	if !ok {
		return def, nil
	}
	n, err := parseBytes(v)
	if err != nil {
		return 0, fmt.Errorf("parameter %s=%q: %w", key, v, err)
	}
	if n <= 0 {
		return 0, fmt.Errorf("parameter %s=%q must be positive", key, v)
	}
	return n, nil
}

// byteUnits maps a (lower-cased) size suffix to its multiplier.
var byteUnits = map[string]int64{
	"": 1, "b": 1,
	"kb": 1e3, "mb": 1e6, "gb": 1e9,
	"kib": 1 << 10, "mib": 1 << 20, "gib": 1 << 30,
}

// parseBytes parses "16", "16B", "8MiB", "500kb" into a byte count. It guards
// against multiplier overflow so an absurd size is rejected, not silently wrapped.
func parseBytes(s string) (int64, error) {
	s = strings.TrimSpace(s)
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	num, unit := s[:i], strings.TrimSpace(s[i:])
	if num == "" {
		return 0, fmt.Errorf("missing number in %q", s)
	}
	n, err := strconv.ParseInt(num, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid number in %q: %w", s, err)
	}
	mult, ok := byteUnits[strings.ToLower(unit)]
	if !ok {
		return 0, fmt.Errorf("unknown size unit %q", unit)
	}
	if n != 0 && n > math.MaxInt64/mult {
		return 0, fmt.Errorf("size %q overflows", s)
	}
	return n * mult, nil
}
