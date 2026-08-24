# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

一个面向 **AmneziaWG 3.x** 的轻量 Docker 管理面板。本项目是 [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy) 的独立、非商业分支，专为全新安装 AWG 3.x 而重新构建。

> 状态：预发布候选版。AWG 3.1、Docker 部署、AmneziaVPN Android 导入、IPv4/IPv6、Home/Guest 隔离以及已删除配置的撤销均已在独立 VPS 上验证。Home 发现功能仍需使用两台真实设备测试。

## 功能

- 通过 `vpn://` 链接导入 AWG 3.1 配置，也可下载 `.conf` 文件。
- Home 客户端可访问面板及其他 Home 客户端；Guest 只能访问互联网。
- 默认 AdGuard DNS：`94.140.14.14`、`94.140.15.15`、`2a10:50c0::ad1:ff`、`2a10:50c0::ad2:ff`。
- VPS 支持 IPv6 时自动配置 ULA 和限定范围的 NAT66。
- 仅为 Home 提供 mDNS 和 UPnP/SSDP 服务发现。明确不支持 UPnP IGD、NAT-PMP、PCP 以及任何自动开放或映射端口的功能。
- 面板仅可在 VPN 内通过 `http://10.8.0.1:51821` 访问。
- 使用独立 nftables 表和范围严格的 `awg0` 规则，不清除其他服务的规则。
- 不提供 2.x 迁移、备份恢复、用户角色或旧版 WireGuard 后端。
- GeoIP 选择性路由推迟到具备合适的服务端设计之后。

## 要求与安装

需要 `amd64` Linux VPS、Docker Engine、Docker Compose v2、`/dev/net/tun`、root 权限以及开放入站 UDP 51820。

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --host 公网IP或域名 --lang zh-cn
```

可选参数包括 `--port`、`--panel-port` 和 `--lang en|ru|fa|es|zh-cn`。即使修改面板端口，它仍不会公开到互联网。安装程序只显示一次面板密码和首个 Home 配置链接。将链接导入 AmneziaVPN，然后打开 `http://10.8.0.1:51821`。

## 本地管理

```bash
docker compose run --rm --no-deps awg-easy reset-password
docker compose logs -f awg-easy
docker compose exec awg-easy awg show awg0
```

继承并改编的材料按 **CC BY-NC-SA 4.0** 发布。请参阅 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。本项目与 AmneziaVPN 没有关联，也未获其官方认可。
