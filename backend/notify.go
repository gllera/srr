package main

import (
	"context"
	"log/slog"
	"strconv"

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

// notifyState is the pre-fetch snapshot a cycle needs to detect transitions:
// the failure streak each selected feed carried BEFORE this cycle ran.
type notifyState struct {
	prev map[int]int
}

// snapshotNotify records the pre-fetch streaks. Returns nil (and every method
// no-ops) when no notify command is configured, so the whole feature costs one
// nil check on the default path.
func snapshotNotify(feeds []*Feed) *notifyState {
	if globals.Notify == "" {
		return nil
	}
	prev := make(map[int]int, len(feeds))
	for _, ch := range feeds {
		prev[ch.id] = ch.FailStreak
	}
	return &notifyState{prev: prev}
}

// fire runs the notify command for every feed that crossed the threshold or
// recovered during this cycle. Warn-only: a broken notify command must never
// affect the fetch outcome — the articles are already durable by now.
func (n *notifyState) fire(ctx context.Context, feeds []*Feed) {
	if n == nil {
		return
	}
	threshold := max(globals.NotifyAfter, 1)
	for _, ch := range feeds {
		was, ok := n.prev[ch.id]
		if !ok {
			continue // added mid-cycle; nothing to compare against
		}
		switch {
		case ch.FailStreak == threshold && was < threshold:
			// The crossing itself, exactly once per outage.
			n.run(ctx, ch, notifyFail)
		case ch.FailStreak == 0 && was >= threshold:
			// Recovered from an outage we alerted about.
			n.run(ctx, ch, notifyRecover)
		}
	}
}

func (n *notifyState) run(ctx context.Context, ch *Feed, event notifyEvent) {
	env := append(mod.SubprocessEnv(),
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
