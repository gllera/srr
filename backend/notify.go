package main

import (
	"context"
	"log/slog"
	"strconv"
	"sync"

	"srr/mod"
)

// Feed-failure alerting. Each feed already carries a FailStreak vital, but
// nothing watched it — the 16 nitter feeds died silently for days. This is the
// missing last mile: an operator-supplied shell command (config `notify:`) run
// when a feed CROSSES the failure threshold and again when it recovers.
//
// Crossing semantics (streak == threshold exactly, not >=) make it stateless:
// one alert per outage, no "already alerted" bookkeeping to persist or get out
// of sync. A process restart mid-outage re-fires only if the streak crosses the
// threshold again, which is an acceptable duplicate for a much simpler model.
//
// Context rides the ENVIRONMENT, never string interpolation — a feed title or
// error message is attacker-influenced content, and splicing it into a shell
// command line is a command-injection hole.

// notifyEvent is the SRR_NOTIFY_EVENT value.
type notifyEvent string

const (
	notifyFail    notifyEvent = "fail"
	notifyRecover notifyEvent = "recover"
)

// notifyAlert is one alert a cycle owes: the feed and the edge it crossed.
type notifyAlert struct {
	feed  *Feed
	event notifyEvent
}

// notifyAlerts lists the alerts a cycle owes: every fan-out feed that crossed
// the threshold or recovered, comparing each one's streak with the one its
// guard record captured before the fan-out (priorState). Nil when no notify
// command is configured, so the whole feature costs one check on the default
// path.
func notifyAlerts(fetched []fetchedFeed) []notifyAlert {
	if globals.Notify == "" {
		return nil
	}
	threshold := max(globals.NotifyAfter, 1)
	var alerts []notifyAlert
	for _, rec := range fetched {
		ch, was := rec.feed, rec.priorState.FailStreak
		switch {
		case ch.FailStreak == threshold && was < threshold:
			// The crossing itself, exactly once per outage.
			alerts = append(alerts, notifyAlert{ch, notifyFail})
		case ch.FailStreak == 0 && was >= threshold:
			// Recovered from an outage we alerted about.
			alerts = append(alerts, notifyAlert{ch, notifyRecover})
		}
	}
	return alerts
}

// fireNotify runs the notify command for each alert, in order. Warn-only: a
// broken notify command must never affect the fetch outcome — the articles
// are already durable by now.
func fireNotify(ctx context.Context, alerts []notifyAlert) {
	for _, a := range alerts {
		runNotify(ctx, a.feed, a.event)
	}
}

// Alerts are delivered in COMMIT order. The hook runs after the store lock is
// released (runFetch), so the next writer can commit while an earlier cycle is
// still working through its alerts — one subprocess per feed, no timeout by
// default. Sent as each cycle got to them, a recovery the later cycle
// committed would overtake the earlier cycle's "fail" for the same feed, and
// crossing semantics are stateless: nothing would ever correct an operator
// whose last alert says a healthy feed is down.
//
// So a cycle that owes alerts takes a turn while it still holds the store
// writer, right after its Commit — the writer gate already serializes commits,
// so turn order IS commit order — and, outside the lock, waits for every
// earlier turn before delivering. Nothing is held across anyone's alerts: a
// slow hook delays only the alerts queued behind it, never a commit, and a
// cycle owing no alerts takes no turn and waits for nobody.
//
// In-process only. The turns order the writers of THIS process (serve's loop,
// the admin page's fetch, srr_fetch); a separate `srr fetch` process writing
// the same store keeps its own, so alerts across processes stay unordered.
var notifyTurns struct {
	sync.Mutex
	last chan struct{} // the newest turn's next; nil before the first turn
}

// notifyTurn is one cycle's place in the alert order: prev closes when the
// turn before it is passed on (nil when there was none), next when this one
// is. A nil *notifyTurn is the cycle that owes no alerts: both methods no-op.
type notifyTurn struct{ prev, next chan struct{} }

// takeNotifyTurn hands out the next place in the alert order. The caller must
// hold the store writer and have committed, and must pass the turn on (done)
// on every path from here, or each later cycle's alerts wait on it forever.
func takeNotifyTurn() *notifyTurn {
	notifyTurns.Lock()
	defer notifyTurns.Unlock()
	t := &notifyTurn{prev: notifyTurns.last, next: make(chan struct{})}
	notifyTurns.last = t.next
	return t
}

// wait blocks until every earlier turn has been passed on, logging once when
// it has to, so a fetch held up by a slow hook says why. Deliberately not
// cancellable: like the hook itself (WithoutCancel), a cycle shutting down
// still delivers the alerts it already decided to send — in their place.
func (t *notifyTurn) wait() {
	if t == nil || t.prev == nil {
		return
	}
	select {
	case <-t.prev:
	default:
		slog.Info("notify waiting for an earlier fetch cycle's alerts")
		<-t.prev
	}
}

// done passes the turn on, waiting for it first if the cycle never did: one
// that panicked between its commit and its alerts must neither strand every
// later turn nor let one overtake an earlier cycle still sending.
func (t *notifyTurn) done() {
	if t == nil {
		return
	}
	t.wait()
	close(t.next)
}

func runNotify(ctx context.Context, ch *Feed, event notifyEvent) {
	// The notify hook is operator-global config (--notify), trusted like the
	// srr.yaml that declares it — it gets EVERY secret scope, unlike per-feed
	// pipe/ingest commands, whose grant is the feed's `secrets` axis.
	env := append(mod.SubprocessEnv(mod.WithSecretScopes(ctx, mod.AllScopes())),
		"SRR_NOTIFY_EVENT="+string(event),
		"SRR_NOTIFY_FEED="+ch.Title,
		"SRR_NOTIFY_FEED_ID="+strconv.Itoa(ch.id),
		"SRR_NOTIFY_URL="+ch.URL,
		"SRR_NOTIFY_ERROR="+ch.FetchError,
		"SRR_NOTIFY_STREAK="+strconv.Itoa(ch.FailStreak),
	)
	slog.Info("feed notify", "event", event, "feed", ch, "streak", ch.FailStreak)
	if _, err := mod.RunSubprocess(ctx, globals.Notify, env, "", nil); err != nil {
		slog.Warn("notify command failed", "event", event, "feed", ch, "err", err)
	}
}
