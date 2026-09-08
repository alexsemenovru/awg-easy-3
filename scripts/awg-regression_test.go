// Mounted into the pinned upstream device package by CI; not shipped at runtime.
package device

import (
	"testing"
	"time"
)

// A busy receiver must still accept a handshake when cookies are disabled.
// Before b5928ef, it required MAC2 but suppressed the cookie response.
func TestEasyDisableCookiesUnderLoad(t *testing.T) {
	pair := genTestPair(t, true)
	for _, endpoint := range pair {
		endpoint.dev.disableCookies.Store(true)
		endpoint.dev.rate.underLoadUntil.Store(time.Now().Add(time.Minute).UnixNano())
	}
	pair.Send(t, Ping, nil)
	pair.Send(t, Pong, nil)
}

// RandomPaddingAddition must fit the learned UDP window, including the case
// where the encrypted packet (headers and S4 included) already fills it.
func TestEasyPaddingRespectsUDPWindow(t *testing.T) {
	pair := genTestPair(t, true)
	dev := pair[0].dev
	if err := dev.IpcSet("content_padding_addition=100-100\n"); err != nil {
		t.Fatal(err)
	}
	peer := &Peer{device: dev}
	for _, tc := range []struct{ window, packet, want int }{
		{0, 1200, 0}, {1100, 1200, 0}, {1200, 1200, 0},
		{1201, 1200, 1}, {1250, 1200, 50}, {1300, 1200, 100}, {1400, 1200, 100},
	} {
		peer.udpWindow.Store(uint32(tc.window))
		for attempt := 0; attempt < 100; attempt++ {
			if got := peer.randomPaddingAddition(tc.packet); got != tc.want {
				t.Fatalf("window=%d packet=%d: got %d, want %d", tc.window, tc.packet, got, tc.want)
			}
		}
	}
}
