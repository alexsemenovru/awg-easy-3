//go:build linux && !android

package conn

import (
	"net"
	"testing"
	"time"
)

// An inbound packet addressed to a secondary local IPv4 must be answered
// from that address even when UDP GRO is enabled.
func TestMultiIPReplySource(t *testing.T) {
	bind := NewStdNetBind()
	receive, port, err := bind.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	defer bind.Close()
	client, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 3)},
		&net.UDPAddr{IP: net.IPv4(127, 0, 0, 2), Port: int(port)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	bufs := make([][]byte, IdealBatchSize)
	sizes := make([]int, IdealBatchSize)
	eps := make([]Endpoint, IdealBatchSize)
	for i := range bufs {
		bufs[i] = make([]byte, 2048)
	}
	n, err := receive[0](bufs, sizes, eps)
	if err != nil || n < 1 {
		t.Fatalf("receive: %d %v", n, err)
	}
	if got := eps[0].SrcIP().String(); got != "127.0.0.2" {
		t.Fatalf("received destination %s, want 127.0.0.2", got)
	}
	if err := bind.Send([][]byte{[]byte("pong")}, eps[0]); err != nil {
		t.Fatal(err)
	}
	if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_, addr, err := client.ReadFromUDP(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 2)) {
		t.Fatalf("reply source %s, want 127.0.0.2", addr.IP)
	}
}
