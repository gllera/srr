package mod

import (
	"context"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

// probe installs a DOM step under name that records the body it was handed and
// optionally mutates it, so a test can observe how many parses a pipeline ran.
func probe(m *Module, name string, seen *[]*html.Node, mutate func(*html.Node) bool) {
	m.domProcessors[name] = func(_ context.Context, _ Params, _ *RawItem, body *html.Node) (bool, error) {
		*seen = append(*seen, body)
		if mutate == nil {
			return false, nil
		}
		return mutate(body), nil
	}
}

// The point of the session: a contiguous run of DOM steps shares ONE parse.
func TestSessionSharesOneParse(t *testing.T) {
	m := New()
	var seen []*html.Node
	probe(m, "#p1", &seen, nil)
	probe(m, "#p2", &seen, nil)

	i := &RawItem{Content: `<p>a</p>`}
	s := m.NewSession(i)
	defer s.Close()
	for _, step := range []string{"#p1", "#p2"} {
		if err := s.Process(context.Background(), step); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
	}
	if len(seen) != 2 {
		t.Fatalf("steps run = %d, want 2", len(seen))
	}
	if seen[0] != seen[1] {
		t.Error("DOM steps got different parses; the session did not share one")
	}
}

// A DOM step sees what the previous DOM step changed, without a materialization
// in between — the shared body IS the handoff.
func TestSessionDOMStepsSeeEachOthersChanges(t *testing.T) {
	m := New()
	var seen []*html.Node
	probe(m, "#add", &seen, func(body *html.Node) bool {
		body.AppendChild(&html.Node{Type: html.ElementNode, Data: "hr"})
		return true
	})
	var found int
	probe(m, "#count", &seen, func(body *html.Node) bool {
		for c := body.FirstChild; c != nil; c = c.NextSibling {
			if c.Data == "hr" {
				found++
			}
		}
		return false
	})

	i := &RawItem{Content: `<p>a</p>`}
	s := m.NewSession(i)
	for _, step := range []string{"#add", "#count"} {
		if err := s.Process(context.Background(), step); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
	}
	if found != 1 {
		t.Errorf("second step saw %d added nodes, want 1", found)
	}
	if i.Content != `<p>a</p>` {
		t.Errorf("content materialized early: %q", i.Content)
	}
	s.Close()
	if i.Content != `<p>a</p><hr/>` {
		t.Errorf("Close did not materialize the DOM: %q", i.Content)
	}
}

// A string step is a boundary: the DOM is materialized before it runs, and the
// content it leaves is re-parsed for the next DOM step.
func TestSessionStringStepIsABoundary(t *testing.T) {
	m := New()
	var seen []*html.Node
	probe(m, "#add", &seen, func(body *html.Node) bool {
		body.AppendChild(&html.Node{Type: html.ElementNode, Data: "hr"})
		return true
	})
	m.processors["#tag"] = func(_ context.Context, _ Params, i *RawItem) error {
		if !strings.Contains(i.Content, "<hr/>") {
			t.Errorf("string step ran before the DOM was materialized: %q", i.Content)
		}
		i.Content += "<p>b</p>"
		return nil
	}
	probe(m, "#after", &seen, nil)

	i := &RawItem{Content: `<p>a</p>`}
	s := m.NewSession(i)
	defer s.Close()
	for _, step := range []string{"#add", "#tag", "#after"} {
		if err := s.Process(context.Background(), step); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
	}
	if len(seen) != 2 || seen[0] == seen[1] {
		t.Error("the step after a string boundary should get a fresh parse")
	}
	if !strings.Contains(i.Content, "<p>b</p>") {
		t.Errorf("string step's rewrite lost: %q", i.Content)
	}
}

// Nothing changed, nothing re-rendered: a no-op run leaves the content string
// byte-identical, quirky quoting and all. This is the contract each HTML step
// used to enforce for itself with a verbatim return.
func TestSessionNoOpKeepsContentVerbatim(t *testing.T) {
	const content = `<p CLASS='x' >a &amp; b<br></p >`
	m := New()
	var seen []*html.Node
	probe(m, "#noop", &seen, nil)

	i := &RawItem{Content: content}
	s := m.NewSession(i)
	if err := s.Process(context.Background(), "#noop"); err != nil {
		t.Fatalf("Process: %v", err)
	}
	s.Close()
	if i.Content != content {
		t.Errorf("no-op run re-rendered the content: %q", i.Content)
	}
	if s.Rev() != 0 {
		t.Errorf("Rev = %d after a no-op run, want 0", s.Rev())
	}
}

// Rev counts content mutations from both step forms, so a caller can ask "did
// anything rewrite the content?" without holding a before-image.
func TestSessionRevCountsBothStepForms(t *testing.T) {
	m := New()
	var seen []*html.Node
	probe(m, "#touch", &seen, func(body *html.Node) bool {
		body.AppendChild(&html.Node{Type: html.ElementNode, Data: "hr"})
		return true
	})
	m.processors["#rewrite"] = func(_ context.Context, _ Params, i *RawItem) error {
		i.Content += "!"
		return nil
	}
	m.processors["#readonly"] = func(_ context.Context, _ Params, _ *RawItem) error { return nil }

	i := &RawItem{Content: `<p>a</p>`}
	s := m.NewSession(i)
	defer s.Close()
	for _, tc := range []struct {
		step string
		want int
	}{{"#readonly", 0}, {"#touch", 1}, {"#rewrite", 2}} {
		if err := s.Process(context.Background(), tc.step); err != nil {
			t.Fatalf("%s: %v", tc.step, err)
		}
		if s.Rev() != tc.want {
			t.Errorf("after %s: Rev = %d, want %d", tc.step, s.Rev(), tc.want)
		}
	}
}

// The real DOM built-ins compose across one parse: #unlazy promotes the real
// URL, and #dedupmedia then sees the promoted src as a duplicate of the plain
// <img> — a handoff that only works if they share the body.
func TestSessionRealBuiltinsCompose(t *testing.T) {
	m := New()
	i := &RawItem{Content: `<p><img src="https://x.org/a.jpg"></p>` +
		`<p><img src="https://x.org/spacer.gif" data-src="https://x.org/a.jpg"></p>`}
	s := m.NewSession(i)
	for _, step := range []string{"#unlazy", "#dedupmedia"} {
		if err := s.Process(context.Background(), step); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
	}
	s.Close()
	if n := strings.Count(i.Content, "<img"); n != 1 {
		t.Errorf("promoted duplicate not deduped (%d images left): %q", n, i.Content)
	}
}
