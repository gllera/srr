package ingest

import "testing"

func TestSelectPrecedence(t *testing.T) {
	tests := []struct {
		name          string
		chanFetcher   string
		globalFetcher string
		want          string
	}{
		{"channel-wins", "chan", "glob", "chan"},
		{"global-when-channel-empty", "", "glob", "glob"},
		{"default-when-all-empty", "", "", "#rss"},
		{"channel-overrides-default", "#custom", "", "#custom"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Select(tt.chanFetcher, tt.globalFetcher); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuiltinsRegistered(t *testing.T) {
	f := New()
	for _, name := range []string{"#rss"} {
		if _, ok := f.fetchers[name]; !ok {
			t.Errorf("built-in %q is not registered", name)
		}
	}
}
