package main

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// status is the process-wide terminal status line: a single in-place stderr
// line carrying live fetch stats, active only when stderr is a terminal. All
// slog output is routed through it (log.SetOutput in main), so a log record
// erases the line, prints normally, and the line is redrawn beneath it — logs
// and the status never garble each other. On a non-terminal stderr (service
// logs, pipes, tests) Set/Clear are no-ops and Write is a pure passthrough.
var status = newStatusLine(os.Stderr)

type statusLine struct {
	mu   sync.Mutex
	out  *os.File
	tty  bool
	text string // currently drawn line ("" = none)
}

func newStatusLine(f *os.File) *statusLine {
	fi, err := f.Stat()
	return &statusLine{
		out: f,
		tty: err == nil && fi.Mode()&os.ModeCharDevice != 0,
	}
}

// Set draws text as the status line, replacing the previous one in place.
// Plain "\r" + space padding (no ANSI escapes, so dumb terminals work);
// padding uses the previous text's byte length, which can only over-erase.
func (s *statusLine) Set(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.tty || text == s.text {
		return
	}
	pad := ""
	if n := len(s.text) - len(text); n > 0 {
		pad = strings.Repeat(" ", n) + strings.Repeat("\b", n)
	}
	fmt.Fprintf(s.out, "\r%s%s", text, pad)
	s.text = text
}

// Clear erases the status line, leaving the cursor at column 0.
func (s *statusLine) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.erase()
}

// erase blanks the drawn line (caller holds mu).
func (s *statusLine) erase() {
	if !s.tty || s.text == "" {
		return
	}
	fmt.Fprintf(s.out, "\r%s\r", strings.Repeat(" ", len(s.text)))
	s.text = ""
}

// Write is the log sink (log.SetOutput in main): it lifts the status line out
// of the way, writes the record, and redraws the line after it.
func (s *statusLine) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	redraw := s.text
	s.erase()
	n, err := s.out.Write(p)
	if redraw != "" {
		_, _ = s.out.WriteString(redraw) // best-effort redraw; the contract reports the record write
		s.text = redraw
	}
	return n, err
}

// fetchProgress accumulates one fetch cycle's live stats for the status line.
// Feed workers and the asset fetcher bump the counters concurrently; a ticker
// goroutine renders them until finish() is called. Everything degrades to
// no-ops on a non-terminal stderr (status.Set does nothing).
type fetchProgress struct {
	feedsTotal int64
	feedsDone  atomic.Int64
	feedsFail  atomic.Int64
	articles   atomic.Int64
	saving     atomic.Bool
	assets     *assetFetcher
	stopCh     chan struct{}
	stopOnce   sync.Once
	wg         sync.WaitGroup
}

// startFetchProgress begins rendering the fetch status line for a cycle over
// total feeds; the caller must finish() it (typically deferred).
func startFetchProgress(total int, assets *assetFetcher) *fetchProgress {
	p := &fetchProgress{
		feedsTotal: int64(total),
		assets:     assets,
		stopCh:     make(chan struct{}),
	}
	if !status.tty {
		return p
	}
	p.wg.Go(func() {
		tick := time.NewTicker(200 * time.Millisecond)
		defer tick.Stop()
		for {
			status.Set(p.line())
			select {
			case <-p.stopCh:
				return
			case <-tick.C:
			}
		}
	})
	return p
}

// feedDone records one finished feed (failed when its FetchError is set,
// otherwise contributing newArticles).
func (p *fetchProgress) feedDone(failed bool, newArticles int) {
	p.feedsDone.Add(1)
	if failed {
		p.feedsFail.Add(1)
	}
	p.articles.Add(int64(newArticles))
}

// setSaving flips the line's verb once the feed fan-out is done and the cycle
// moves on to writing packs/summaries (zopfli finalization can take a while).
func (p *fetchProgress) setSaving() {
	p.saving.Store(true)
	status.Set(p.line())
}

// finish stops the renderer and clears the line. Idempotent: runFetch calls
// it before the cycle-summary log (so the line doesn't flash a redraw beneath
// it) AND defers it for the error returns. Safe on a non-terminal stderr (no
// goroutine was started; Clear is a no-op).
func (p *fetchProgress) finish() {
	p.stopOnce.Do(func() {
		if status.tty {
			close(p.stopCh)
			p.wg.Wait()
		}
		status.Clear()
	})
}

func (p *fetchProgress) line() string {
	verb := "fetching"
	if p.saving.Load() {
		verb = "saving"
	}
	l := fmt.Sprintf("%s · feeds %d/%d", verb, p.feedsDone.Load(), p.feedsTotal)
	if n := p.articles.Load(); n > 0 {
		l += fmt.Sprintf(" · new articles %d", n)
	}
	if n := p.feedsFail.Load(); n > 0 {
		l += fmt.Sprintf(" · failed %d", n)
	}
	if active, done := p.assets.active.Load(), p.assets.done.Load(); active > 0 || done > 0 {
		l += fmt.Sprintf(" · assets %d", done)
		if active > 0 {
			l += fmt.Sprintf(" (%d active)", active)
		}
	}
	return l
}
