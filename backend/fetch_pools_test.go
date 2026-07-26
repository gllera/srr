package main

import (
	"context"
	"testing"

	"srr/ingest"
)

// The fan-out's worker pools and ingest engine are built once per COMMAND, not
// once per cycle: the --interval loop runs thousands of cycles through one
// FetchCmd and must not rebuild them every five minutes (FET14).
func TestWorkerPoolsBuiltOncePerCommand(t *testing.T) {
	o := &FetchCmd{}
	first := o.workerPools()
	if first == nil || first.engine == nil {
		t.Fatal("workerPools returned no pools/engine")
	}
	if second := o.workerPools(); second != first || second.engine != first.engine {
		t.Error("workerPools rebuilt the pools on a second call")
	}
}

// Two cycles of one command share the pools; a separate command gets its own
// (serve and the MCP tool construct a FetchCmd per request).
func TestWorkerPoolsSurviveCycles(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: rssServer(t)})

	o := &FetchCmd{}
	client := newFetchClient(1)
	if err := o.runFetch(ctx, client, nil); err != nil {
		t.Fatalf("cycle 1: %v", err)
	}
	pools := o.pools
	if pools == nil {
		t.Fatal("a cycle did not build the pools")
	}
	if err := o.runFetch(ctx, client, nil); err != nil {
		t.Fatalf("cycle 2: %v", err)
	}
	if o.pools != pools || o.pools.engine != pools.engine {
		t.Error("the second cycle rebuilt the pools")
	}
	if other := (&FetchCmd{}).workerPools(); other == pools {
		t.Error("a separate command shares another's pools")
	}

	// The pooled buffer is the one the fan-out reads a feed into: it must be
	// sized off --max-feed-size (cap-1 is the real limit), not left at zero.
	buf := pools.buf.Get().(*[]byte)
	defer pools.buf.Put(buf)
	if want := globals.MaxFeedSize*(1<<10) + 1; len(*buf) != want {
		t.Errorf("pooled feed buffer = %d bytes, want %d", len(*buf), want)
	}
}

// ProbeBuf hands out a correctly sized buffer whether it allocates or reuses —
// a pooled buffer is re-sliced to THIS call's limit, so readBody's oversize
// check and its error message stay exact.
func TestProbeBufSizing(t *testing.T) {
	buf, release := ingest.ProbeBuf(4096)
	if len(buf) != 4097 {
		t.Fatalf("len = %d, want 4097", len(buf))
	}
	release()

	// A smaller request reuses the bigger buffer, re-sliced down.
	small, release2 := ingest.ProbeBuf(8)
	defer release2()
	if len(small) != 9 {
		t.Errorf("reused buffer len = %d, want 9", len(small))
	}
}

// Every subscribe-time probe goes through ONE client, so an import's parallel
// probes share its connection pool instead of leaking a transport each.
func TestResolveClientShared(t *testing.T) {
	c := resolveClient()
	if c == nil {
		t.Fatal("resolveClient returned nil")
	}
	if resolveClient() != c {
		t.Error("resolveClient built a second client")
	}
	if _, err := previewFetch(context.Background(), nil, "", "", "://bad"); err == nil {
		t.Error("previewFetch on a bad URL should error")
	}
}
