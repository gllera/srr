package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// notifyProbe points globals.Notify at a command that appends its SRR_NOTIFY_*
// context to a log file, and returns a reader for it.
func notifyProbe(t *testing.T, after int) func() []string {
	t.Helper()
	log := filepath.Join(t.TempDir(), "notify.log")
	saved := globals
	globals = &Globals{
		Store:       t.TempDir(),
		Notify:      `printf '%s|%s|%s|%s\n' "$SRR_NOTIFY_EVENT" "$SRR_NOTIFY_FEED" "$SRR_NOTIFY_STREAK" "$SRR_NOTIFY_ERROR" >> ` + log,
		NotifyAfter: after,
	}
	t.Cleanup(func() { globals = saved })
	return func() []string {
		data, err := os.ReadFile(log)
		if err != nil {
			return nil
		}
		var out []string
		for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			if l != "" {
				out = append(out, l)
			}
		}
		return out
	}
}

// The alert fires on the CROSSING (streak == threshold) and once more on
// recovery — never on the failures in between, and never on a streak that was
// already past the threshold when the cycle started.
func TestNotifyFiresOnCrossingAndRecovery(t *testing.T) {
	read := notifyProbe(t, 3)
	ch := &Feed{Title: "Nitter", URL: "https://n.example/f"}

	step := func(streak int, ferr string) {
		t.Helper()
		state := snapshotNotify([]*Feed{ch})
		ch.FailStreak, ch.FetchError = streak, ferr
		state.fire(ctx, []*Feed{ch})
	}

	step(1, "boom") // below threshold — silent
	step(2, "boom") // below threshold — silent
	if got := read(); len(got) != 0 {
		t.Fatalf("alerted below the threshold: %v", got)
	}

	step(3, "boom") // the crossing
	got := read()
	if len(got) != 1 || !strings.HasPrefix(got[0], "fail|Nitter|3|boom") {
		t.Fatalf("crossing alert = %v, want one fail|Nitter|3|boom", got)
	}

	step(4, "boom") // still down — must NOT re-alert
	step(9, "boom")
	if got := read(); len(got) != 1 {
		t.Fatalf("re-alerted during a continuing outage: %v", got)
	}

	step(0, "") // recovery
	got = read()
	if len(got) != 2 || !strings.HasPrefix(got[1], "recover|Nitter|0|") {
		t.Fatalf("recovery alert = %v, want a trailing recover|Nitter|0", got)
	}

	// A feed that never crossed the threshold must not send a recovery.
	step(1, "boom")
	step(0, "")
	if got := read(); len(got) != 2 {
		t.Errorf("recovery fired for a feed that never alerted: %v", got)
	}
}

// With no notify command configured the whole feature is inert — no snapshot,
// no subprocess, no per-feed work.
func TestNotifyDisabledByDefault(t *testing.T) {
	saved := globals
	globals = &Globals{Store: t.TempDir()}
	t.Cleanup(func() { globals = saved })

	ch := &Feed{Title: "X", FailStreak: 5}
	state := snapshotNotify([]*Feed{ch})
	if state != nil {
		t.Fatal("snapshotNotify returned state with no notify command configured")
	}
	state.fire(ctx, []*Feed{ch}) // must not panic on the nil receiver
}

// Feed titles and error text are attacker-influenced: they must ride the
// environment, so shell metacharacters in them can never become code.
func TestNotifyDoesNotInterpolateFeedText(t *testing.T) {
	read := notifyProbe(t, 1)
	ch := &Feed{
		Title:      `"; touch /tmp/srr-pwned; echo "`,
		URL:        "https://evil.example/f",
		FetchError: "$(id)",
	}
	state := snapshotNotify([]*Feed{ch})
	ch.FailStreak = 1
	state.fire(ctx, []*Feed{ch})

	got := read()
	if len(got) != 1 {
		t.Fatalf("alerts = %v, want exactly 1", got)
	}
	// The metacharacters arrive as literal data, unexpanded.
	if !strings.Contains(got[0], `"; touch /tmp/srr-pwned; echo "`) || !strings.Contains(got[0], "$(id)") {
		t.Errorf("payload was not passed literally: %q", got[0])
	}
	if _, err := os.Stat("/tmp/srr-pwned"); err == nil {
		os.Remove("/tmp/srr-pwned")
		t.Fatal("the feed title was executed as shell code")
	}
}
