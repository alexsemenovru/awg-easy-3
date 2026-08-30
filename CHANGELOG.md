# Changelog

## v0.1.2-rc.2 — 2026-08-30

Test candidate; field validation continues.

- Fixed a firewall rule-ordering defect found with two actual AWG tunnels on the test VPS: the shared inter-peer drop shadowed the IPv6 Home permit. Both IPv4 and IPv6 Home permits now precede the common isolation rule; Guest traffic remains blocked in both families.
- Added a regression test for permit/drop ordering. The fix does not add the planned per-client IPv4/IPv6 switches.
- Includes the diagnostics, installer, branding and boot-update changes from rc.1. Stable `0.1.1` and `latest` are unchanged.

## v0.1.2-rc.1 — 2026-08-30

Test candidate, not a stable release. VPS validation is still required.

- Clarified recent-handshake status: it is not proof that a device is connected now.
- Serialized diagnostic samples, monotonic rate timing, and reset handling for stale, failed or reset-counter samples.
- Added first-sample and unavailable states, sample intervals and explanations in all five languages. Hidden tabs stop polling; late responses cannot repaint stale data.
- Clean installs select a free random UDP port in 20000-60000, excluding 51820. Explicit and saved ports stay unchanged. Checks include Docker-published ports without a listening proxy.
- The settings command reads saved non-secret parameters instead of stale container environment values, without starting the VPN.
- Added a discreet GitHub credit link for alexsemenovru, without external resources or referrer disclosure.
- Added a default-on stable update check after each OS boot on systemd and OpenRC, with explicit `auto-update enable|disable|status|run` controls. Updates stage and validate the complete release, preserve state, skip deliberately stopped panels, serialize against removal/reinstall, and roll back after a failed health check.
- Hardened updater interruption handling, immutable-image rollback, release validation and lock ownership. Existing locks are never stolen; an orphaned `/run` lock is cleared by reboot. An explicitly installed RC can later move to its matching or newer stable release, but never downgrades to an older stable release.
- **Protection against devils** («Защита от чертей» / «Protección contra demonios» / «محافظت در برابر شیاطین» / «抵御恶魔»): added the approved original SVG mark and static Pride-colour background. The header mark is inline SVG; favicon and platform icons use standards-compatible files. This is a visual statement, not a technical access-control mechanism.

The candidate pins `0.1.2-rc.1` consistently in the installer checkout, package and image. Tag publishing runs tests first and never moves `latest` for an RC. Stable `0.1.1` remains unchanged. See the [VPS test checklist](docs/RELEASE_TEST.ru.md).

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
