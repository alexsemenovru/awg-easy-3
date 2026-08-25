# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

一个面向 **AmneziaWG 3.x** 的轻量 Docker 管理面板。本项目是 [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy) 的独立、非商业分支，专为全新安装 AWG 3.x 而重新构建。

> 状态：首个 v0.1.0 版本。AWG 3.1、Docker 部署、AmneziaVPN Android 导入、IPv4/IPv6、Home/Guest 隔离以及已删除配置的撤销均已在独立 VPS 上验证。服务器端 Home 发现转发和 SSDP 地址重写也已在两个真实 peer 之间验证；最终可见性取决于客户端应用是否通过 VPN 接口支持组播。

## 功能

- 通过 `vpn://` 链接导入 AWG 3.1 配置，也可下载 `.conf` 文件。
- Home 客户端可访问面板及其他 Home 客户端；Guest 只能访问互联网。
- 实时显示在线状态、当前收发速率、握手和端点信息，不保存流量历史。
- 默认 AdGuard DNS：`94.140.14.14`、`94.140.15.15`、`2a10:50c0::ad1:ff`、`2a10:50c0::ad2:ff`。
- VPS 支持 IPv6 时自动配置 ULA 和限定范围的 NAT66。
- 仅为 Home 提供 mDNS 和 UPnP/SSDP 服务发现。明确不支持 UPnP IGD、NAT-PMP、PCP 以及任何自动开放或映射端口的功能。应用能否发现服务取决于客户端是否在 VPN 接口上支持组播。
- 面板仅可在 VPN 内通过 `http://10.8.0.1:51821` 访问。
- 使用独立 nftables 表和范围严格的 `awg0` 规则，不清除其他服务的规则。
- 不提供 2.x 迁移、备份恢复、用户角色或旧版 WireGuard 后端。
- GeoIP 选择性路由推迟到具备合适的服务端设计之后。

## 客户端应用

请使用 **[AmneziaVPN 5.0.0.5 或更高版本](https://github.com/amnezia-vpn/amnezia-client/releases)** 导入 AWG-Easy 3 生成的配置。在 Android 上，请从 [Google Play 安装最新版 AmneziaVPN](https://play.google.com/store/apps/details?id=org.amnezia.vpn)。导入安装程序或面板显示的 `vpn://` 链接；需要时也可下载 `.conf` 文件。

AWG 3.x 不向后兼容 AWG 2.x。普通 WireGuard 客户端以及独立的 AmneziaWG 应用目前不支持这些配置。AWG-Easy 3 与 AmneziaVPN 相互独立；此处仅将其列为已经验证的兼容客户端。

## 要求与安装

需要原生 `amd64` Linux VPS、`/dev/net/tun`、root 权限、受支持的软件包管理器以及一个可用的入站 UDP 端口。FreeBSD、OpenBSD、NetBSD、macOS 和 WSL 会在安装软件包之前被拒绝。安装程序可按需从系统仓库安装 Docker Engine、Docker Compose v2、iproute2 和 nftables。

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --host 公网IP或域名 --lang zh-cn
```

可选参数包括 `--port`、`--panel-port` 和 `--lang en|ru|fa|es|zh-cn`。默认端口被占用时，交互式运行会建议下一个可用端口；明确指定的占用端口会报错，不会被静默替换。支持 APT、DNF、YUM、Zypper、Pacman 和 APK。在 NixOS 上，安装程序会输出声明式模块和限制为单任务的 `nixos-rebuild` 命令，不会自动编辑 `configuration.nix`。即使修改面板端口，它仍不会公开到互联网。安装程序只显示一次面板密码和首个 Home 配置链接。将链接导入 AmneziaVPN，然后打开 `http://10.8.0.1:51821`。

在交互式终端中再次运行时，安装程序会检测现有安装，并提供保留、完全卸载或从零重新安装三个选项。后两项需要确认，并会永久删除 AWG-Easy 3 的所有客户端、密钥、密码和设置。自动化环境可使用 `--uninstall` 或 `--reinstall`。卸载只停止本项目的 Compose 服务并删除其数据和专用 sysctl 文件；Docker、其他容器、镜像、网络、防火墙规则以及主机当前的转发值均不会被修改。

## 本地管理

```bash
sudo awg-easy-3 help
sudo awg-easy-3 status
sudo awg-easy-3 update
sudo awg-easy-3 reset-password
sudo awg-easy-3 export-client "Home admin"
```

还可从任意目录使用 `start`、`stop`、`restart`、`settings`、`logs`、`diagnose`、`uninstall` 和 `reinstall`。

继承并改编的材料按 **CC BY-NC-SA 4.0** 发布。请参阅 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。本项目与 AmneziaVPN 没有关联，也未获其官方认可。
