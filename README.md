# AWG-Easy 3

An intentionally small Docker web panel for **AmneziaWG 3.x**. This is an independent, non-commercial fork of [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy), rebuilt around clean AWG 3.x installations.

> Status: prerelease candidate. Local tests pass; the pinned engine, AmneziaVPN Android interoperability and Home discovery still require validation on a dedicated VPS before the first release.

Highlights:

- AWG 3.1 configuration and AmneziaVPN `vpn://`/QR export.
- Per-client Home/Guest isolation with compact full-tunnel profiles.
- Requested AdGuard IPv4/IPv6 DNS defaults.
- Automatic IPv6 ULA + scoped NAT66 when VPS IPv6 is usable.
- Home-only mDNS/SSDP discovery; no UPnP IGD or port mapping.
- VPN-only panel at `http://10.8.0.1:51821` with one password.
- Dedicated nftables table, narrowly tagged `awg0` rules in Docker's
  `DOCKER-USER` chain when required, and no public Web UI port.
- Pinned `linux/amd64` base images and official AWG source revisions.
- No migrations, backup/restore, roles, or legacy WireGuard backend.
- GeoIP-based selective routing is intentionally deferred pending a server-side design.

## Install

Requirements: an amd64 Linux VPS, Docker Engine, Docker Compose v2, `/dev/net/tun`, root access, and inbound UDP 51820.

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --host PUBLIC_IP_OR_DOMAIN --lang en
```

The installer prints the first Home profile, terminal QR code, panel password, and `vpn://` link once. Connect that profile and open `http://10.8.0.1:51821`.

Optional `--port`, `--panel-port`, and `--lang en|ru|fa|es|zh-cn` arguments select the AWG UDP port, VPN-only panel TCP port, and interface language. English is the default; Persian uses an RTL layout. Russian, Spanish, and Simplified Chinese are also included.

See [README.ru.md](README.ru.md) for detailed commands, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design notes, and [NOTICE](NOTICE) for attribution.

Inherited adapted material is licensed under CC BY-NC-SA 4.0. This project is not affiliated with or endorsed by AmneziaVPN.
