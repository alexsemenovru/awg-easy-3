# Changelog

## v0.1.3 — 2026-08-31

- Replace the client enable switch with independent IPv4/IPv6 permissions. Both off removes the peer; profiles, keys, addresses, DNS and routes remain unchanged. Home/Guest stays independent.
- Put the IPv4/IPv6 switches in a collapsed-by-default Access settings section, separate from read-only Diagnostics. Keep the permission mode and Home/Guest group visible, retain open sections and control focus after updates, and translate the new section into all five languages.
- Enforce permissions in both directions in the owned nftables table, including existing connections and local server traffic. Do not change foreign interfaces/rules or create direct fallback, WARP, NAT64 or DNS bypass exceptions.
- Bind the panel to its internal IPv6 address as well as IPv4. Protect the current administration path and the last permitted Home client; translate controls, errors and DNS caveats into all five languages.
- Read legacy clients without regenerating profiles or enabling disabled peers. Persist conservative legacy `enabled` values so manual downgrade cannot silently reopen a blocked family.
- Make installation work on minimal Alpine hosts: apply only the owned sysctl file with BusyBox-compatible options, create the management-command directory, and persist TUN loading across OS boots. Uninstall removes only the owned modules-load file and does not unload modules used by other services.
- Finish the OpenRC one-shot worker without leaving a false crashed-service status; preserve its exit result and avoid clearing a replacement worker's state.
- Add regression and field coverage: 203 local tests, complete Dockerfile build, legacy migration, real AWG family/peer isolation tests and native OpenRC reboot checks on Alpine. User tests confirmed IPv6 blocking/restoration and direct IPv6 with IPv4 blocked; DNS then failed and recovered when IPv4 was restored. This does not establish universal AmneziaVPN DNS compatibility. Final UI changes were tested locally after the test VPS was deleted. See the [release notes](docs/releases/v0.1.3.md), [field report](docs/VPS_TEST_2026-08-31.ru.md) and [implementation/test plan](docs/IP_FAMILIES.ru.md).

## v0.1.2 — 2026-08-30

Includes the diagnostics, installer, boot-time stable updates, credits and original Pride branding from rc.1, and the VPS-tested IPv6 Home forwarding fix from rc.2. Existing ports, profiles and state format are preserved on update. Per-client IPv4/IPv6 switches are not part of this release.

- Hide rates from the main client status line when there is no recent handshake. Preserve measured server send/receive rates in Diagnostics, with an explicit unconfirmed-delivery warning. Disabled peers and unavailable samples do not retain stale rates or invented zero measurements.
- Clarify manual profile-link copying in all five languages while keeping the button labelled “Show link”. Refresh the changed asset URLs to avoid stale browser caches.
- Add regression coverage and synthetic browser previews for residual sending, missing samples, disabled clients and API failures. This is a presentation change; AWG counters and the 150-second recent-handshake criterion are unchanged.
- Replace the invalid Dependabot template with weekly GitHub Actions and Docker base-image PRs. No automatic merging. pnpm 11 dependency updates remain manual pending upstream support; the application image in Compose continues to follow release metadata.
- Publish stable release notes only after the tagged image build succeeds, as already done for RC notes.

Real VPS validation covered Ubuntu/systemd; OpenRC boot integration still needs a real-host field test. The final display-only changes were tested locally in browsers on synthetic data, not redeployed to the destroyed VPS. See the [field report](docs/VPS_TEST_2026-08-30.ru.md) and [release notes](docs/releases/v0.1.2.md).

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
