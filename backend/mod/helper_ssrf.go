package mod

import (
	"fmt"
	"net"
	"net/http"
	"syscall"
	"time"
)

// AllowPrivateFetch disables the SSRF guard when true. Self-hosters who
// legitimately fetch feeds/media from LAN or loopback addresses opt out via the
// --allow-private-fetch flag / SRR_ALLOW_PRIVATE_FETCH env; main sets this from
// the resolved global after parsing. Defaults false (guard on).
var AllowPrivateFetch bool

// blockedIP reports whether ip is a private, loopback, link-local, unique-local
// (covered by IsPrivate for fc00::/7), unspecified, or multicast address — the
// ranges an SSRF probe would target (internal services, cloud metadata at
// 169.254.169.254, localhost-bound admin ports).
func blockedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast()
}

// guardDialControl is a net.Dialer.Control hook: it runs after DNS resolution
// with the concrete address about to be dialed, so it blocks SSRF without a
// rebinding TOCTOU and re-checks every hop of a redirect (each hop dials
// afresh). Disabled when SRR_ALLOW_PRIVATE_FETCH is set.
func guardDialControl(_, address string, _ syscall.RawConn) error {
	if AllowPrivateFetch {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("ssrf guard: refusing to dial non-IP address %q", address)
	}
	if blockedIP(ip) {
		return fmt.Errorf("ssrf guard: refusing to dial private/loopback address %s (set SRR_ALLOW_PRIVATE_FETCH=1 to override)", ip)
	}
	return nil
}

// SafeTransport returns an *http.Transport whose dials are screened by the
// SSRF guard. Built-ins that fetch attacker-controlled URLs from feed content
// (#readability) use it so a malicious feed can't pivot the
// server onto the internal network. Callers may set pooling fields on the
// returned transport.
func SafeTransport() *http.Transport {
	d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second, Control: guardDialControl}
	return &http.Transport{
		DialContext:           d.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}
