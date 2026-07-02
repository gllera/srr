package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// statusFile builds a tty-forced statusLine writing to a temp file and a
// reader for the bytes it emitted.
func statusFile(t *testing.T) (*statusLine, func() string) {
	t.Helper()
	f, err := os.Create(filepath.Join(t.TempDir(), "status"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return &statusLine{out: f, tty: true}, func() string {
		b, err := os.ReadFile(f.Name())
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
}

// TestStatusLineDrawLogInterleave pins the byte protocol of the in-place
// status line: draws replace each other via \r + space padding (no ANSI), a
// log record lifts the line out of the way and redraws after itself, Clear
// leaves a blank column-0 line.
func TestStatusLineDrawLogInterleave(t *testing.T) {
	s, read := statusFile(t)

	s.Set("abc")
	s.Set("abc") // identical text: no rewrite
	s.Set("x")   // shrink: pad the leftover, backspace onto the text end
	if _, err := s.Write([]byte("LOG\n")); err != nil {
		t.Fatal(err)
	}
	s.Clear()

	want := "\rabc" + "\rx  \b\b" + "\r \r" + "LOG\n" + "x" + "\r \r"
	if got := read(); got != want {
		t.Errorf("byte stream:\n got %q\nwant %q", got, want)
	}
}

// TestStatusLineNonTTYPassthrough: on a non-terminal stderr the status line
// draws nothing and the log sink is a byte-exact passthrough.
func TestStatusLineNonTTYPassthrough(t *testing.T) {
	s, read := statusFile(t)
	s.tty = false

	s.Set("never drawn")
	n, err := s.Write([]byte("LOG\n"))
	if err != nil || n != 4 {
		t.Fatalf("Write = (%d, %v); want (4, nil)", n, err)
	}
	s.Clear()

	if got := read(); got != "LOG\n" {
		t.Errorf("byte stream = %q; want the log record only", got)
	}
}

// TestFetchProgressLine pins the stats rendering: zero-valued segments are
// omitted, the verb flips once the cycle moves from fetching to saving.
func TestFetchProgressLine(t *testing.T) {
	p := &fetchProgress{feedsTotal: 45, assets: newAssetFetcher(nil, 0, "")}
	if got, want := p.line(), "fetching · feeds 0/45"; got != want {
		t.Errorf("line() = %q; want %q", got, want)
	}

	p.feedDone(false, 3)
	p.feedDone(true, 0)
	p.assets.done.Add(14)
	p.assets.active.Add(2)
	want := "fetching · feeds 2/45 · new articles 3 · failed 1 · assets 14 (2 active)"
	if got := p.line(); got != want {
		t.Errorf("line() = %q; want %q", got, want)
	}

	p.saving.Store(true)
	if got := p.line(); !strings.HasPrefix(got, "saving · ") {
		t.Errorf("line() = %q; want the saving verb", got)
	}
}
