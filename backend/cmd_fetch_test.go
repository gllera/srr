package main

import (
	"net/http"
	"testing"
	"time"
)

// TestNewFetchClientIdleConnTimeout verifies that the HTTP client/transport
// built for fetch cycles carries a finite IdleConnTimeout.  A zero timeout
// means the transport never closes idle connections on the client side, so
// in --interval mode each cycle would orphan a Transport whose readLoop
// goroutines keep sockets/FDs alive until the remote server closes them.
// 90 s matches the SSRF-guarded transport in mod/helper_ssrf.go.
func TestNewFetchClientIdleConnTimeout(t *testing.T) {
	c := newFetchClient(4)
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport is %T, want *http.Transport", c.Transport)
	}
	if tr.IdleConnTimeout == 0 {
		t.Error("IdleConnTimeout is 0 (no client-side expiry); want a finite value (e.g. 90s)")
	}
	const want = 90 * time.Second
	if tr.IdleConnTimeout != want {
		t.Errorf("IdleConnTimeout = %v, want %v", tr.IdleConnTimeout, want)
	}
}

// TestNewFetchClientPoolingMatchesWorkers verifies that the connection-pool
// limits on the transport are set to the supplied workers value.
func TestNewFetchClientPoolingMatchesWorkers(t *testing.T) {
	const workers = 8
	c := newFetchClient(workers)
	tr := c.Transport.(*http.Transport)
	if tr.MaxIdleConnsPerHost != workers {
		t.Errorf("MaxIdleConnsPerHost = %d, want %d", tr.MaxIdleConnsPerHost, workers)
	}
	if tr.MaxConnsPerHost != workers {
		t.Errorf("MaxConnsPerHost = %d, want %d", tr.MaxConnsPerHost, workers)
	}
}
