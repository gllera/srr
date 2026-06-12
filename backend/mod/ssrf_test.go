package mod

import (
	"net"
	"testing"
)

func TestBlockedIP(t *testing.T) {
	for _, s := range []string{
		"127.0.0.1", "::1", // loopback
		"10.0.0.1", "192.168.1.1", "172.16.0.1", // RFC1918
		"169.254.169.254", "fe80::1", // link-local (incl. cloud metadata)
		"0.0.0.0", "::", // unspecified
		"fc00::1", // unique-local
	} {
		if !blockedIP(net.ParseIP(s)) {
			t.Errorf("blockedIP(%s) = false, want true", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"} {
		if blockedIP(net.ParseIP(s)) {
			t.Errorf("blockedIP(%s) = true, want false", s)
		}
	}
}

func TestGuardDialControlBlocksPrivate(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:80", "169.254.169.254:80", "10.1.2.3:443"} {
		if err := guardDialControl("tcp", addr, nil); err == nil {
			t.Errorf("guardDialControl(%s) = nil, want blocked", addr)
		}
	}
	if err := guardDialControl("tcp", "8.8.8.8:443", nil); err != nil {
		t.Errorf("public IP should be allowed, got %v", err)
	}
}

func TestGuardDialControlOptOut(t *testing.T) {
	t.Setenv("SRR_ALLOW_PRIVATE_FETCH", "1")
	if err := guardDialControl("tcp", "127.0.0.1:80", nil); err != nil {
		t.Errorf("SRR_ALLOW_PRIVATE_FETCH should allow loopback, got %v", err)
	}
}
