# AWG-Easy 3 architecture notes

This document records the initial technical direction. It is intentionally
small: the product should remain a single-purpose appliance, not a general VPN
or network-management platform.

## Baseline decision

Use the compact `upstream/master` codebase as the UI and API baseline. Do not
base AWG-Easy 3 on the upstream `feature/go-rewrite` branch: that branch has
grown into the substantially broader Cascade product and carries features that
conflict with this project's deliberately narrow scope.

The legacy implementation is not accepted unchanged. The following components
must be replaced before a release:

- floating AWG container tag and unverified protocol compatibility;
- `iptables-legacy` PostUp/PostDown scripts;
- environment-only bcrypt authentication;
- ephemeral session secret and in-memory-only session lifecycle;
- shell command construction involving key material;
- AWG 2.0 parameter generation and configuration rendering;
- public Web UI port in the example Compose file;
- backup/restore and unrelated optional features.

## Runtime components

The intended first release contains:

1. A small Node.js web/API process derived from AWG-Easy.
2. A pinned official AWG 3.x userspace engine and matching tools.
3. A state directory mounted from a Docker volume.
4. A narrowly scoped nftables manager.
5. A small discovery relay for home peers, covered by automated fan-out tests
   and validated with a packet capture between two real peers. Application-level
   visibility remains dependent on client multicast support over the VPN interface.
6. An installer/bootstrap command that creates the first peer and credentials.

The installer treats dependency installation and conflict handling as a
preflight phase. It can provision Docker Engine, Docker Compose v2, iproute2
and nftables through a supported distribution package manager. Default port
collisions are resolved interactively; explicit port arguments remain strict.
Existing containers, interfaces, routes and nftables objects are never removed
or renamed automatically.

The supported runtime platform is native Linux/amd64. BSD kernels, macOS and
WSL are rejected before dependency provisioning because the network policy
depends on native Linux TUN, forwarding, nftables and Docker integration.

NixOS is handled as a declarative exception. When runtime dependencies are
missing, the installer prints a standalone NixOS module enabling Docker,
Compose, iproute2, nftables and TUN, plus the import and `nixos-rebuild`
commands. The rebuild is limited to one job and one core for low-memory VPS
instances. The installer does not patch `configuration.nix` automatically.

The Web UI listens inside the container/network namespace but has no public
host port mapping. nftables permits it from home peer addresses only.

## AWG 3.x configuration surface

Official AWG 3.x tools currently expose the existing obfuscation fields plus:

- `HeaderProtectionKey` on the interface;
- AWG userspace peers are AWG-native and do not emit the kernel-only
  `AdvancedSecurity` compatibility flag;
- `ContentPaddingAddition`;
- `RekeyAfterTime`;
- `RekeyTimeout`;
- `RejectAfterTime`;
- `KeepaliveTimeout`;
- `MaxHandshakeAttempts`;
- `RandomTrailers` (3.1);
- `DisableCookies` (3.1).

Support must be capability-driven. At startup, the application verifies the
installed engine/tools and rejects an unsupported combination instead of
silently producing a partially applied configuration. Image versions must be
pinned and updated deliberately.

Protocol presets must be versioned data with validation. They must not be
described as secure or production-tested unless that claim is supported by an
upstream specification and interoperability tests.

## AmneziaVPN export compatibility

AmneziaVPN 5.0.0.5 has a known import-path defect: a native `.conf` can be
accepted while the AWG 3.x fields are omitted from the application's internal
model, preventing the protected handshake. The primary export format for
AmneziaVPN is therefore its `vpn://` share link.

The link contains a third-party `amnezia-awg` container object, an AWG
`last_config` object with the protocol fields stored separately, and the native
configuration for compatibility. The JSON is encoded with Qt's `qCompress`
framing (four-byte big-endian source length followed by zlib data), then
unpadded base64url. Native `.conf` remains an additional export for dedicated
clients and diagnostics, not the primary AmneziaVPN onboarding path.

## Network policy

Use a dedicated nftables table named with the `awg_easy_3` prefix. Rules match
the AWG interface and the project's assigned prefixes. Updates should be
applied atomically. Deleting the application removes only objects owned by the
application.

When Docker's host `FORWARD` policy would otherwise drop VPN traffic, the
runtime adds only four marker-owned `awg0` accept/return rules to Docker's
supported `DOCKER-USER` chains. It does not flush, replace, or reorder rules
owned by Docker or other applications, and removes its marked rules on stop.

Peer addresses are maintained in sets:

- `home4` / `home6`;
- `guest4` / `guest6`.

Policy summary:

- home to home: accept;
- home to panel: accept;
- guest to AWG prefixes and panel: reject;
- both groups to WAN: accept with the required NAT/routing policy;
- unsolicited WAN to peers: reject;
- discovery relay input/output: home sets only.

The last active home peer cannot be demoted through the API. A local recovery
command can reset the password and recreate an administrative peer.

## Client routing

Profiles emit full IPv4 routes and full IPv6 routes when server IPv6 is
available. GeoIP-based selective routing is deferred: local ISP bypass cannot
be enforced by the VPS after traffic reaches it, and embedding the exact route
complement in every client profile is too large and client-dependent.

Automatic IPv6 uses a randomly generated RFC 4193 ULA `/64` inside the AWG
network and NAT66 on the detected WAN interface. This requires only a working
global IPv6 address and default route on the VPS; it does not assume that the
provider delegates its connected `/64` to VPN clients. NAT66 matches only the
project-owned ULA prefix and lives in the dedicated nftables table. An explicit
routed prefix remains supported for installations where the provider actually
delegates one.

## Discovery relay

WireGuard-style interfaces do not provide Ethernet broadcast or multicast
fan-out to every peer. Generic reflectors commonly operate between distinct
interfaces, while all AWG peers share `awg0`. The relay implements controlled
per-peer fan-out for:

- IPv4 mDNS (`224.0.0.251:5353`);
- IPv4 SSDP (`239.255.255.250:1900`).

Dual-stack Home clients use their internal IPv4 addresses for discovery; this
avoids relying on IPv6 multicast membership support on userspace TUN devices.

A two-peer field capture validated server-side packet fan-out and SSDP
`LOCATION` rewriting to the advertising peer's VPN address. Client applications
must still send and receive multicast on the VPN interface. Some Android
VPN/application combinations bind discovery only to the physical network; this
is a client compatibility limitation and does not disable the server relay.

The relay must not implement UPnP IGD, NAT-PMP or PCP and must never attach to
the VPS WAN/LAN interface.

## License

The inherited code is distributed under CC BY-NC-SA 4.0. The fork must retain
attribution, indicate modifications, remain non-commercial, and distribute
adapted material under compatible ShareAlike terms. Dependency and bundled
binary licenses are recorded separately in [third-party notices](../THIRD_PARTY_NOTICES.md).
