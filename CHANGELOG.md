# Changelog

## v0.1.1 — 2026-08-25

- Replaced inherited Amnezia artwork with an original AWG-Easy 3 emblem.
- Updated the panel header, favicon, Apple touch icon, web manifest and project screenshot.
- Renamed the installed web application in the manifest from AmneziaWG to AWG-Easy 3.

## v0.1.0 — 2026-08-25

Initial public release of AWG-Easy 3:

- Pinned AmneziaWG 3.1 engine and `linux/amd64` Docker image.
- Clean installer with dependency provisioning, port conflict handling, uninstall and clean reinstall.
- Global `awg-easy-3` management command.
- VPN-only multilingual panel in English, Russian, Persian, Spanish and Simplified Chinese.
- Home/Guest client isolation, profile revocation and live connection diagnostics.
- IPv4 plus automatic IPv6 ULA/NAT66 when the VPS supports IPv6.
- AdGuard DNS defaults and Home-only mDNS/SSDP discovery relay.
- AmneziaVPN `vpn://` profile display and `.conf` download.

Known limitation: multicast discovery visibility depends on the client application using the VPN interface. GeoIP selective routing remains deferred until a safe server-side design is available.
