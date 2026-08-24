# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

An intentionally small Docker web panel for **AmneziaWG 3.x**. This is an independent, non-commercial fork of [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy), rebuilt around clean AWG 3.x installations.

> Status: prerelease candidate. The pinned AWG 3.1 engine, Docker deployment, AmneziaVPN Android import, IPv4/IPv6 connectivity, Home/Guest isolation and profile revocation have been validated on a dedicated VPS. Home discovery still needs a two-device field test.

Highlights:

- AWG 3.1 configuration and AmneziaVPN `vpn://` export, plus optional `.conf` download.
- Per-client Home/Guest isolation with compact full-tunnel profiles.
- Live online/offline state, current receive/transmit speed, handshake and endpoint diagnostics without traffic history.
- Requested AdGuard IPv4/IPv6 DNS defaults.
- Automatic IPv6 ULA + scoped NAT66 when VPS IPv6 is usable.
- Home-only mDNS and UPnP/SSDP discovery. UPnP IGD, NAT-PMP, PCP and every form of automatic port opening are intentionally unsupported.
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

The installer prints the first Home profile, panel password, and `vpn://` link once. Connect that profile and open `http://10.8.0.1:51821`. A missed client link can be regenerated locally without recreating the client:

```bash
docker compose run --rm --no-deps awg-easy export-client "Home admin"
```

Optional `--port`, `--panel-port`, and `--lang en|ru|fa|es|zh-cn` arguments select the AWG UDP port, VPN-only panel TCP port, and interface language. English is the default; Persian uses an RTL layout. Russian, Spanish, and Simplified Chinese are also included.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design notes and [NOTICE](NOTICE) for attribution.

Inherited adapted material is licensed under CC BY-NC-SA 4.0. This project is not affiliated with or endorsed by AmneziaVPN.
