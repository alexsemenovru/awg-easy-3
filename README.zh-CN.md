# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

一个面向 **AmneziaWG 3.x** 的轻量 Docker 管理面板。本项目是 [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy) 的独立、非商业分支，专为全新安装 AWG 3.x 而重新构建。

> 当前版本：**0.1.3**。新增各客户端独立 IPv4/IPv6 权限及可折叠的“访问设置”。除之前的 Ubuntu/systemd 测试外，现已在真实 VPS 上验证 Alpine/OpenRC 的安装、迁移和重启。最后的界面修改是在 VPS 删除后于本地浏览器中验证的。请参阅[发行说明](docs/releases/v0.1.3.md)和[Alpine 实测报告（俄语）](docs/VPS_TEST_2026-08-31.ru.md)。

> AWG 3.1、Docker 部署、AmneziaVPN Android 导入、IPv4/IPv6、Home/Guest 隔离以及已删除配置的撤销均已在独立 VPS 上验证。服务器端 Home 发现转发和 SSDP 地址重写也已在两个真实 peer 之间验证；最终可见性取决于客户端应用是否通过 VPN 接口支持组播。

## 功能

- 通过 `vpn://` 链接导入 AWG 3.1 配置，也可下载 `.conf` 文件。
- Home 客户端可访问面板及其他 Home 客户端；Guest 只能访问互联网。
- 在“访问设置”中独立控制 IPv4/IPv6，无需重新导入配置。
- 显示近期握手状态、采样间隔内的平均收发速率、握手和端点信息，不保存流量历史。
- 默认 AdGuard DNS：`94.140.14.14`、`94.140.15.15`、`2a10:50c0::ad1:ff`、`2a10:50c0::ad2:ff`。
- VPS 支持 IPv6 时自动配置 ULA 和限定范围的 NAT66。
- 仅为 Home 提供 mDNS 和 UPnP/SSDP 服务发现。明确不支持 UPnP IGD、NAT-PMP、PCP 以及任何自动开放或映射端口的功能。应用能否发现服务取决于客户端是否在 VPN 接口上支持组播。
- 面板仅可在 VPN 内通过 `http://10.8.0.1:51821` 及其可用的内部 IPv6 地址访问。
- 使用独立 nftables 表和范围严格的 `awg0` 规则，不清除其他服务的规则。
- 不提供 2.x 迁移、备份恢复、用户角色或旧版 WireGuard 后端。
- GeoIP 选择性路由推迟到具备合适的服务端设计之后。

## 客户端访问设置

展开**访问设置**可分别允许 IPv4 和 IPv6；两项均关闭即停用客户端，折叠后仍显示当前模式。Home/Guest 独立于这些权限。限制仅作用于 VPN 内的双向流量，包括已有连接；密钥、配置、地址、DNS 和路由保持不变。面板会保护当前管理连接及最后一个获准访问的 Home 客户端。内部 IPv4/IPv6 面板链接位于“VPN 流量权限”中。

**仅 IPv6 模式可能无法解析域名：**即使配置包含 IPv6 DNS，AmneziaVPN 也可能只应用其 IPv4 DNS 字段。直接访问 IPv6 地址仍可能正常；开启 IPv4 会恢复对 IPv4 DNS 的访问。本项目不添加 DNS 例外、NAT64、WARP 或直连回退。面板不能控制客户端分流规则排除在 VPN 外的流量；基础测试时请关闭这些过滤规则。服务发现转发使用 IPv4，不包含禁止 IPv4 的客户端。

请使用 `sudo awg-easy-3 update` 更新，而非 `reinstall`：客户端、密钥、密码和端口保留，已停用客户端不会被启用。手动降级可能完全停用受部分限制的客户端，以防重新开放被禁止的地址族。详见[发行说明](docs/releases/v0.1.3.md)。

## 连接诊断

“近期连接”表示过去 150 秒内有握手，不保证设备当前仍在线。速率是采样间隔内的平均值，单位为比特/秒：↓ 发送至客户端，↑ 从客户端接收。计数可能包含控制流量；发送不代表已送达。首次采样显示正在测量；读取失败或超时时显示数据不可用，而不是保留旧速率。展开诊断详情可查看实际采样间隔。

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

未指定 `--port` 或 `AWG_PORT` 时，全新安装会在 **20000–60000** 中随机选择一个空闲 UDP 端口，排除旧默认值 `51820`。安装程序检查系统套接字及 Docker 发布的端口，显示所选端口并将其写入客户端配置。请在 VPS/提供商防火墙中允许该 UDP 端口。普通更新保留已保存的端口；从零重新安装会重新选择，除非明确指定。随机端口不能保证避开 VPN 检测或 IP 封锁。

可选参数包括 `--port`、`--panel-port` 和 `--lang en|ru|fa|es|zh-cn`。面板的默认 TCP 端口被占用时，交互式运行会建议下一个可用端口；明确指定的占用端口会报错，不会被静默替换。支持 APT、DNF、YUM、Zypper、Pacman 和 APK。在 NixOS 上，安装程序会输出声明式模块和限制为单任务的 `nixos-rebuild` 命令，不会自动编辑 `configuration.nix`。即使修改面板端口，它仍不会公开到互联网。安装程序只显示一次面板密码和首个 Home 配置链接。将链接导入 AmneziaVPN，然后打开 `http://10.8.0.1:51821`。

在交互式终端中再次运行时，安装程序会检测现有安装，并提供保留、完全卸载或从零重新安装三个选项。后两项需要确认，并会永久删除 AWG-Easy 3 的所有客户端、密钥、密码和设置。自动化环境可使用 `--uninstall` 或 `--reinstall`。卸载只停止本项目的 Compose 服务并删除其数据和专用 sysctl 文件；Docker、其他容器、镜像、网络、防火墙规则以及主机当前的转发值均不会被修改。

在 systemd 和 OpenRC 系统上，安装程序不会询问，而是默认启用“每次系统启动五分钟后检查一次稳定版本”。它不会安装 cron、额外容器或常驻守护进程。预发布版本会被忽略；当前版本已是最新或面板被有意停止时，不会执行替换。候选镜像会在替换前完整下载并验证，客户端、密钥、密码、端口和设置均会保留。网络失败不会改动工作版本，容器健康检查失败则会恢复上一版本。其他 init 系统仍可使用安全的手动更新。

## 本地管理

```bash
sudo awg-easy-3 help
sudo awg-easy-3 status
sudo awg-easy-3 update
sudo awg-easy-3 reset-password
sudo awg-easy-3 export-client "Home admin"
```

还可从任意目录使用 `start`、`stop`、`restart`、`settings`、`logs`、`diagnose`、`uninstall` 和 `reinstall`。使用 `sudo awg-easy-3 auto-update status|enable|disable|run` 管理启动后检查；若要关闭默认启用的功能，请运行 `sudo awg-easy-3 auto-update disable`。

继承并改编的材料按 **CC BY-NC-SA 4.0** 发布。请参阅 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。本项目与 AmneziaVPN 没有关联，也未获其官方认可。
