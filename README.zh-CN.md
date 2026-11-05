# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

## AWG-Easy 3 是什么

一个面向 **AmneziaWG 3.x** 的轻量 Docker 管理面板。本项目是 [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy) 的独立、非商业分支，专为全新安装 AWG 3.x 而重新构建。

> 当前版本：**0.1.6**，使用 AWG **v3.1.20260828** 引擎。现有配置继续有效。请参阅[发行说明](docs/releases/v0.1.6.md)。

## 功能概览

- 在浏览器中创建和导出 VPN 配置；面板本身仅能在 VPN 内访问。
- 通过 Home 客户端组成私有网络，或为 Guest 客户端仅提供互联网访问。
- 按客户端控制 IPv4/IPv6、查看连接诊断，并通过简单命令安装或更新。

## 安装与首次登录

需要原生 `amd64` Linux VPS、`/dev/net/tun`、root 权限、受支持的软件包管理器以及一个可用的入站 UDP 端口。FreeBSD、OpenBSD、NetBSD、macOS 和 WSL 会在安装软件包之前被拒绝。安装程序可按需从系统仓库安装 Docker Engine、Docker Compose v2、iproute2 和 nftables。

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --lang zh-cn
```

`--lang` 设置安装程序语言及面板初始语言：`en`、`ru`、`fa`、`es` 或 `zh-cn`。Docker 和系统包管理器的输出可能仍使用这些程序自身的语言。

交互式安装可选择检测到的公网 IPv4（推荐）、其他 IPv4 或域名。无人值守安装请使用 `--host 公网IP或域名`；如果无法检测公网 IP，则必须明确指定此参数。

导入 `vpn://` 链接可使用 **[AmneziaVPN 5.0.0.5 或更高版本](https://github.com/amnezia-vpn/amnezia-client/releases)**，Android 版也可从 [Google Play](https://play.google.com/store/apps/details?id=org.amnezia.vpn) 获取。也可以将下载的 `.conf` 文件导入 **AmneziaWG 3.1**。下方兼容性章节列出了经过测试的 Android 版本、IPv6 面板访问情况及其他客户端。

安装程序会显示面板密码和首个 Home `vpn://` 链接。导入并连接后，打开 `http://10.8.0.1:51821`，或安装程序显示的内部地址。请在提供商防火墙中允许所选 UDP 端口。若未保存链接，可重新导出同一配置：

```bash
sudo awg-easy-3 export-client "Home admin"
```

### 将面板添加为应用

连接 Home VPN 配置并打开面板，然后在浏览器菜单中选择**安装应用**、**添加到主屏幕**或**创建快捷方式**。面板包含 web-app manifest 和图标，支持时可在独立窗口中打开。这不会安装或启动 VPN；仍需 Home 连接并登录面板。IPv4 和 IPv6 地址属于不同来源，可能创建不同的应用入口和会话。

自动提示安装 PWA 通常要求 **HTTPS**；默认的 VPN 内部 HTTP 地址不满足该条件。部分浏览器仍允许将其添加为网站应用或快捷方式，具体取决于浏览器和操作系统。不会添加 service worker、离线配置缓存或公共端口。参阅[浏览器安装要求](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)。

## 更新与管理

```bash
sudo awg-easy-3 update
```

请使用 `sudo awg-easy-3 update` 更新，而非 `reinstall`：客户端、密钥、密码和端口保留，已停用客户端不会被启用。手动降级可能完全停用受部分限制的客户端，以防重新开放被禁止的地址族。详见[发行说明](docs/releases/v0.1.3.md)。

无需重新导入配置。替换容器时，VPN 连接可能短暂中断。

在交互式终端中再次运行时，安装程序会检测现有安装，并提供保留、完全卸载或从零重新安装三个选项。后两项需要确认，并会永久删除 AWG-Easy 3 的所有客户端、密钥、密码和设置。自动化环境可使用 `--uninstall` 或 `--reinstall`。卸载只停止本项目的 Compose 服务并删除其数据和专用 sysctl 文件；Docker、其他容器、镜像、网络、防火墙规则以及主机当前的转发值均不会被修改。

在 systemd 和 OpenRC 系统上，默认在启动五分钟后检查稳定版本，之后每 24 小时检查一次。systemd 使用定时器，OpenRC 使用休眠等待的服务进程；不安装 cron 或额外容器。预发布版本会被忽略；版本已是最新或面板被有意停止时，不会执行替换。候选镜像会在替换前下载并验证，客户端、密钥、密码、端口和设置均保留。网络失败不会改动工作版本，健康检查失败会恢复上一版本。其他 init 系统仍可手动更新。在此开发分支中，主节点与单元的协调更新尚未完成，仍受保护性限制。

```bash
sudo awg-easy-3 help
sudo awg-easy-3 status
sudo awg-easy-3 update
sudo awg-easy-3 reset-password
sudo awg-easy-3 export-client "Home admin"
```

还可从任意目录使用 `start`、`stop`、`restart`、`settings`、`logs`、`diagnose`、`uninstall` 和 `reinstall`。使用 `sudo awg-easy-3 auto-update status|enable|disable|run` 管理启动后检查；若要关闭默认启用的功能，请运行 `sudo awg-easy-3 auto-update disable`。

## 技术功能

- 通过 `vpn://` 链接导入 AWG 3.1 配置，也可下载 `.conf` 文件。
- Home 客户端可访问面板及其他 Home 客户端；Guest 只能访问互联网。
- 在“访问设置”中独立控制 IPv4/IPv6，无需重新导入配置。
- 显示近期握手状态、采样间隔内的平均收发速率、握手和端点信息，不保存流量历史。
- 默认 AdGuard DNS：`94.140.14.14`、`94.140.15.15`、`2a10:50c0::ad1:ff`、`2a10:50c0::ad2:ff`。
- VPS 支持 IPv6 时自动配置 ULA 和限定范围的 NAT66。
- 仅为 Home 提供 mDNS 和 UPnP/SSDP 服务发现。明确不支持 UPnP IGD、NAT-PMP、PCP 以及任何自动开放或映射端口的功能。应用能否发现服务取决于客户端是否在 VPN 接口上支持组播。
- 面板仅可在 VPN 内通过 `http://10.8.0.1:51821` 及其可用的内部 IPv6 地址访问。可选验证器 TOTP 动态码，支持仅密码（默认）、密码加动态码或仅动态码；仅动态码本身并不是双因素认证。通过 SSH 执行 `reset-password` 会关闭动态码并结束全部会话。
- 使用独立 nftables 表和范围严格的 `awg0` 规则，不清除其他服务的规则。
- 不提供 2.x 迁移、备份恢复、用户角色或旧版 WireGuard 后端。
- GeoIP 选择性路由推迟到具备合适的服务端设计之后。

### 客户端访问设置

展开**访问设置**可分别允许 IPv4 和 IPv6；两项均关闭即停用客户端，折叠后仍显示当前模式。Home/Guest 独立于这些权限。限制仅作用于 VPN 内的双向流量，包括已有连接；密钥、配置、地址、DNS 和路由保持不变。面板会保护当前管理连接及最后一个获准访问的 Home 客户端。内部 IPv4/IPv6 面板链接位于“VPN 流量权限”中。

**仅 IPv6 模式可能无法解析域名：**即使配置包含 IPv6 DNS，AmneziaVPN 也可能只应用其 IPv4 DNS 字段。直接访问 IPv6 地址仍可能正常；开启 IPv4 会恢复对 IPv4 DNS 的访问。本项目不添加 DNS 例外、NAT64、WARP 或直连回退。面板不能控制客户端分流规则排除在 VPN 外的流量；基础测试时请关闭这些过滤规则。服务发现转发使用 IPv4，不包含禁止 IPv4 的客户端。

### GeoIP 过滤

在每个客户端的访问设置中，可以关闭过滤、阻止所选国家或仅允许所选国家。输入面板语言的国家名称或两字母代码，以逗号分隔，然后保存。无需重新导入 VPN 配置。

这是 IP 地址范围过滤，不是域名过滤：nftables 对 VPN ↔ 互联网两个方向的 IPv4 和 IPv6 流量进行检查，包括已建立的连接。Home 客户端访问面板及其他 Home 客户端不受影响。排除在 VPN 之外的应用不受此过滤控制，也不会自动切换为直连。IP 所属国家不代表服务所属国家，也不保证准确性或避免 VPN 检测。访问外部 DNS 解析器的请求也可能被阻止。

[DB-IP Country Lite](https://db-ip.com/db/download/ip-to-country-lite) 数据库自动下载和更新。更新失败时保留原数据库；没有可用数据库时，已启用的过滤器会拒绝互联网访问。面板显示数据库状态。参见[实现与测试报告](docs/GEOIP_DATABASE.md)。

**降级注意：**首次启用 GeoIP 后，数据格式变为 v2，即使随后关闭过滤器也不会恢复。0.1.5 无法读取此格式。启用前请妥善备份数据；启用后不支持仅通过切换回旧镜像来降级。

### 连接诊断

“近期连接”表示过去 150 秒内有握手，不保证设备当前仍在线。速率是采样间隔内的平均值，单位为比特/秒：↓ 发送至客户端，↑ 从客户端接收。计数可能包含控制流量；发送不代表已送达。首次采样显示正在测量；读取失败或超时时显示数据不可用，而不是保留旧速率。展开诊断详情可查看实际采样间隔。

## 安装选项与冲突处理

未指定 `--port` 或 `AWG_PORT` 时，全新安装会在 **20000–60000** 中随机选择一个空闲 UDP 端口，排除旧默认值 `51820`。安装程序检查系统套接字及 Docker 发布的端口，显示所选端口并将其写入客户端配置。请在 VPS/提供商防火墙中允许该 UDP 端口。普通更新保留已保存的端口；从零重新安装会重新选择，除非明确指定。随机端口不能保证避开 VPN 检测或 IP 封锁。

可选参数包括 `--port`、`--panel-port` 和 `--lang en|ru|fa|es|zh-cn`。面板的默认 TCP 端口被占用时，交互式运行会建议下一个可用端口；明确指定的占用端口会报错，不会被静默替换。支持 APT、DNF、YUM、Zypper、Pacman 和 APK。在 NixOS 上，安装程序会输出声明式模块和限制为单任务的 `nixos-rebuild` 命令，不会自动编辑 `configuration.nix`。即使修改面板端口，它仍不会公开到互联网。安装程序只显示一次面板密码和首个 Home 配置链接。将链接导入 AmneziaVPN，然后打开 `http://10.8.0.1:51821`。

## 兼容性与实测

**多公网 IP 主机。** 随附的 `amneziawg-go` 构建会在拆分 UDP GRO 数据包时保留
入站目标地址，使回复使用相同的源 IP。若数据包已到达服务器但握手始终失败，
请比较入站与出站 UDP 地址。带有 `src <入口IP>` 的默认路由只能作为临时方案，
因为它会改变整台主机的首选源地址。空闲客户端没有近期握手，不代表服务故障，
不应仅凭此重启容器。

这些配置需要支持 AWG 3.x 的客户端；普通 WireGuard 和旧版 AWG 客户端不兼容。AWG-Easy 3 独立于各客户端项目。

- **Android，已实测的替代客户端：**[AmneziaWG v3.1.20260814](https://github.com/amnezia-vpn/amneziawg-android/releases/tag/v3.1.20260814)。关于页面显示应用版本 **3.1.20260813**、内核版本 **3.1.20260814**。2026-09-09，用户在 Honor 50 上确认我们的 `.conf` 可导入、隧道可连接，面板可通过 IPv4 和 IPv6 打开。请导入文件，不是 `vpn://`；**2.0.1 不兼容**。下载文件采用简短 ASCII 名称，例如 `Honor_50.conf`，不会修改面板中的客户端名称或配置内容。完全由非 ASCII 字符组成的名称使用 `AWG-client.conf`。
- **桌面端，待测候选：**[Throne 1.3.0-beta.2](https://github.com/throneproj/Throne/releases/tag/1.3.0-beta.2) 已实现 AWG 3.x 字段，包括 `RandomTrailers` 和 `DisableCookies`。可尝试导入 `.conf`。这是测试版；**尚未实测其与 AWG-Easy 3 的 IPv6 面板访问及 Home 网络兼容性**。
- **高级选项：**[Mihomo 1.19.30](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.30) 已实现 AWG 3.0/3.1。需要包含 `amnezia-wg-option.version: 3` 的正确 YAML 配置；并非所有图形客户端都内置此内核。这里尚未验证其导入、IPv6 面板及 Home 网络。

**Android 上的 AmneziaVPN 5.0.2.1：**Honor 50 对比测试中，IPv6 面板连接超时，但同一配置在独立 AmneziaWG 应用中正常。[Android 路由处理代码](https://github.com/amnezia-vpn/amnezia-client/blob/5.0.2.1/client/android/protocolApi/src/main/kotlin/ProtocolConfig.kt) 将 `::/0` 替换为 `2000::/3`，即使在“所有网站”模式下也不包含面板的内部 ULA 地址。请使用 IPv4 面板或已实测的 Android 替代客户端。此结论不泛指所有版本或平台。互联网、DNS、Home 客户端服务和服务发现仍需分别测试。

此前截至 **0.1.3** 的实测。新增各客户端独立 IPv4/IPv6 权限及可折叠的“访问设置”。除之前的 Ubuntu/systemd 测试外，现已在真实 VPS 上验证 Alpine/OpenRC 的安装、迁移和重启。最后的界面修改是在 VPS 删除后于本地浏览器中验证的。请参阅[发行说明](docs/releases/v0.1.3.md)和[Alpine 实测报告（俄语）](docs/VPS_TEST_2026-08-31.ru.md)。

AWG 3.1、Docker 部署、AmneziaVPN Android 导入、IPv4/IPv6、Home/Guest 隔离以及已删除配置的撤销均已在独立 VPS 上验证。服务器端 Home 发现转发和 SSDP 地址重写也已在两个真实 peer 之间验证；最终可见性取决于客户端应用是否通过 VPN 接口支持组播。

## 设计理念

**抵制威权主义的虚伪**（俄语原名 «Защита от чертей»）是作者为 LGBTQ+/Pride 主题取的名字，刻意带有挑衅、讽刺和不恭的意味。它批评的是这样一种虚伪：公开支持威权政权及其互联网审查，私下却寻找工具绕过同样的限制。

Pride 彩虹色与 LGBTQ+ 视觉符号表达开发者的价值观和项目的文化身份。彩虹不会撤下：威权主义的拥护者和反 LGBTQ+ 的偏执者，可以自行决定是否愿意使用这样的面板。这种不适感和自愿选择正是设计意图，绝非单纯装饰。

软件在技术上仍向所有人开放。主题不审查信念，也不是身份认证、流量过滤或访问控制机制。已获认可的 Pride 背景将在即将发布的版本及后续 Fluent/Aero 设计中保留。

## 许可与署名

未发布的开发成果及后续计划见 [DEVELOPMENT.ru.md](DEVELOPMENT.ru.md)（俄语）；它们尚未包含在公开版本中。

继承并改编的材料按 **CC BY-NC-SA 4.0** 发布。请参阅 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。本项目与 AmneziaVPN 没有关联，也未获其官方认可。
