package ingest

import "testing"

func TestSelectPrecedence(t *testing.T) {
	tests := []struct {
		name          string
		feedFetcher   string
		globalFetcher string
		want          string
	}{
		{"feed-wins", "feed", "glob", "feed"},
		{"global-when-feed-empty", "", "glob", "glob"},
		{"default-when-all-empty", "", "", "#feed"},
		{"feed-overrides-default", "#custom", "", "#custom"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Select(tt.feedFetcher, tt.globalFetcher); got != tt.want {
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
