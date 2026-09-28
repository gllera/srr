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

// fireNotify runs the notify command for every feed that crossed the threshold
// or recovered during this cycle, comparing each fan-out feed's streak with the
// one its guard record captured before the fan-out (priorState). A no-op when no
// notify command is configured, so the whole feature costs one check on the
// default path. Warn-only: a broken notify command must never affect the fetch
// outcome — the articles are already durable by now.
func fireNotify(ctx context.Context, fetched []fetchedFeed) {
	if globals.Notify == "" {
		return
	}
	threshold := max(globals.NotifyAfter, 1)
	for _, rec := range fetched {
		ch, was := rec.feed, rec.priorState.FailStreak
		switch {
		case ch.FailStreak == threshold && was < threshold:
			// The crossing itself, exactly once per outage.
			runNotify(ctx, ch, notifyFail)
		case ch.FailStreak == 0 && was >= threshold:
			// Recovered from an outage we alerted about.
			runNotify(ctx, ch, notifyRecover)
		}
	}
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
