package ingest

import "testing"

func TestSelectPrecedence(t *testing.T) {
	tests := []struct {
		name  string
		names []string
		want  string
	}{
		{"feed-wins", []string{"feed", "glob"}, "feed"},
		{"global-when-feed-empty", []string{"", "glob"}, "glob"},
		{"default-when-all-empty", []string{"", ""}, "#feed"},
		{"feed-overrides-default", []string{"#custom", ""}, "#custom"},
		{"no-names", nil, "#feed"},
		// The three-level chain of Feed.Fetch: feed override > recipe > default recipe.
		{"feed-override-wins", []string{"ovr", "recipe", "def"}, "ovr"},
		{"recipe-when-override-empty", []string{"", "recipe", "def"}, "recipe"},
		{"default-recipe-last", []string{"", "", "def"}, "def"},
		{"builtin-when-chain-empty", []string{"", "", ""}, "#feed"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Select(tt.names...); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuiltinsRegistered(t *testing.T) {
	f := New()
	for _, name := range []string{"#feed"} {
		if _, ok := f.fetchers[name]; !ok {
			t.Errorf("built-in %q is not registered", name)
		}
	}
}
