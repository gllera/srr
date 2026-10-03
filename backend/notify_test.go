package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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
		rec := fetchedFeed{feed: ch, priorState: fetchState(ch)}
		ch.FailStreak, ch.FetchError = streak, ferr
		fireNotify(ctx, notifyAlerts([]fetchedFeed{rec}))
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

// With no notify command configured the whole feature is inert — no subprocess,
// no per-feed work, even on a crossing that would otherwise alert.
func TestNotifyDisabledByDefault(t *testing.T) {
	saved := globals
	globals = &Globals{Store: t.TempDir()}
	t.Cleanup(func() { globals = saved })
	// The hook is watched where it would run: runNotify logs every alert it
	// delivers, so a tap that stays silent is what shows nothing was sent. An
	// empty alert list alone says only that none was owed, and would keep
	// passing if delivery stopped depending on it.
	logs := make(chan string, 4)
	prevLog := slog.Default()
	slog.SetDefault(slog.New(notifyTap(logs)))
	t.Cleanup(func() { slog.SetDefault(prevLog) })

	ch := &Feed{Title: "X"}
	rec := fetchedFeed{feed: ch, priorState: fetchState(ch)}
	ch.FailStreak = 1
	alerts := notifyAlerts([]fetchedFeed{rec})
	if alerts != nil {
		t.Errorf("alerting is off, yet the cycle owes %v", alerts)
	}
	fireNotify(ctx, alerts)
	select {
	case l := <-logs:
		t.Errorf("alerting is off, yet the hook ran: %q", l)
	default: // fireNotify is synchronous, so anything it logged is here by now
	}
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
	rec := fetchedFeed{feed: ch, priorState: fetchState(ch)}
	ch.FailStreak = 1
	fireNotify(ctx, notifyAlerts([]fetchedFeed{rec}))

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

// notifyTap is a slog handler that forwards each notify-related log line (with
// its event, when it carries one) to a channel, so a test can follow which
// cycle reached which point of its alert delivery without sleeping.
type notifyTap chan<- string

func (notifyTap) Enabled(context.Context, slog.Level) bool { return true }

func (h notifyTap) Handle(_ context.Context, r slog.Record) error {
	if !strings.Contains(r.Message, "notify") {
		return nil
	}
	line := r.Message
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "event" {
			line += " " + a.Value.String()
		}
		return true
	})
	select {
	case h <- line:
	default: // never block the cycle being observed
	}
	return nil
}

func (h notifyTap) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h notifyTap) WithGroup(string) slog.Handler      { return h }

// The notify hook runs after the store lock is released, so a second cycle can
// commit while the first is still sending its alerts. Delivery must still
// follow commit order: a feed whose failure one cycle committed and whose
// recovery the next cycle committed must alert fail-then-recover, never leave
// the operator with a stale "fail" as the last word on a healthy feed.
func TestNotifyAlertsFollowCommitOrder(t *testing.T) {
	saved := globals
	t.Cleanup(func() { globals = saved })
	db, _, dir := setupTestDB(t)
	allowLoopback(t)
	alerts, gate := filepath.Join(dir, "notify.log"), filepath.Join(dir, "gate")
	// Every alert is recorded as "<feed id> <event>"; feed 0's fail alert —
	// cycle A's first — then holds A's notify loop until the test opens the gate.
	globals.Notify = `echo "$SRR_NOTIFY_FEED_ID $SRR_NOTIFY_EVENT" >> '` + alerts + `'
if [ "$SRR_NOTIFY_FEED_ID $SRR_NOTIFY_EVENT" = "0 fail" ]; then
	while [ ! -e '` + gate + `' ]; do sleep 0.01; done
fi`
	globals.NotifyAfter = 1

	var up atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if !up.Load() {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	seedFeed(t, db, &Feed{Title: "Zero", URL: srv.URL + "/0"})
	seedFeed(t, db, &Feed{Title: "One", URL: srv.URL + "/1"})

	logs := make(chan string, 16)
	prevLog := slog.Default()
	slog.SetDefault(slog.New(notifyTap(logs)))
	t.Cleanup(func() { slog.SetDefault(prevLog) })
	openGate := sync.OnceFunc(func() {
		if err := os.WriteFile(gate, nil, 0o600); err != nil {
			t.Errorf("open gate: %v", err)
		}
	})
	defer openGate() // a failed assertion must not leave cycle A's alerts held
	next := func() string {
		t.Helper()
		select {
		case l := <-logs:
			return l
		case <-time.After(30 * time.Second):
			t.Fatal("timed out waiting for a notify log line")
			return ""
		}
	}

	// Cycle A: both feeds fail and cross the threshold. Its alerts start once
	// it has committed and released the store, and feed 0's holds the rest.
	aDone := make(chan error, 1)
	go func() { aDone <- (&FetchCmd{}).runFetch(ctx, newFetchClient(1), nil) }()
	if l := next(); l != "feed notify fail" {
		t.Fatalf("cycle A's first notify line = %q, want feed 0's fail alert", l)
	}

	// A cycle that owes no alerts (feed 1 is still down, past the crossing)
	// commits and returns without waiting for A's.
	idle := make(chan error, 1)
	go func() { idle <- (&FetchCmd{only: []int{1}}).runFetch(ctx, newFetchClient(1), nil) }()
	select {
	case err := <-idle:
		if err != nil {
			t.Fatalf("alert-free cycle: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("a cycle owing no alerts waited for an earlier cycle's")
	}

	// Cycle B, while A is still alerting: feed 1 recovers. B commits — A holds
	// no lock — but its recovery must wait for A's pending fail for feed 1.
	up.Store(true)
	bDone := make(chan error, 1)
	go func() { bDone <- (&FetchCmd{only: []int{1}}).runFetch(ctx, newFetchClient(1), nil) }()
	if l := next(); l != "notify waiting for an earlier fetch cycle's alerts" {
		t.Errorf("cycle B logged %q while cycle A's alerts were still pending, want it to wait its turn", l)
	}

	openGate()
	for _, c := range []struct {
		name string
		done chan error
	}{{"A", aDone}, {"B", bDone}} {
		select {
		case err := <-c.done:
			if err != nil {
				t.Fatalf("cycle %s: %v", c.name, err)
			}
		case <-time.After(30 * time.Second):
			t.Fatalf("cycle %s never finished", c.name)
		}
	}

	data, err := os.ReadFile(alerts)
	if err != nil {
		t.Fatalf("read alerts: %v", err)
	}
	got := strings.Split(strings.TrimSpace(string(data)), "\n")
	if want := []string{"0 fail", "1 fail", "1 recover"}; !slices.Equal(got, want) {
		t.Errorf("alerts delivered as %q, want %q (commit order)", got, want)
	}
}
