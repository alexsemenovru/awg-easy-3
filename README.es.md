# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

Un panel Docker sencillo para **AmneziaWG 3.x**. Es un fork independiente y no comercial de [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy), reconstruido para instalaciones limpias de AWG 3.x.

> Estado: candidato a prerelease. AWG 3.1, Docker, la importación en AmneziaVPN para Android, IPv4/IPv6, el aislamiento Home/Guest y la revocación de perfiles ya se validaron en un VPS. La retransmisión Home del servidor y la reescritura de direcciones SSDP también se validaron entre dos peers reales; la visibilidad final depende del soporte multicast de la aplicación cliente sobre la interfaz VPN.

## Funciones

- Perfiles AWG 3.1 importados mediante enlaces `vpn://` y descarga opcional `.conf`.
- Modo Home con acceso al panel y a otros clientes Home; modo Guest con acceso únicamente a Internet.
- Estado en línea, velocidad actual de recepción/transmisión, handshake y endpoint, sin historial de tráfico.
- DNS AdGuard predeterminado: `94.140.14.14`, `94.140.15.15`, `2a10:50c0::ad1:ff` y `2a10:50c0::ad2:ff`.
- IPv6 automático mediante ULA y NAT66 limitado cuando el VPS dispone de IPv6.
- Descubrimiento mDNS y UPnP/SSDP solo para Home. UPnP IGD, NAT-PMP, PCP y cualquier apertura automática de puertos no se admiten de forma intencionada. La visibilidad depende de que la aplicación cliente admita multicast en la interfaz VPN.
- Panel disponible únicamente dentro de la VPN en `http://10.8.0.1:51821`.
- Tabla nftables dedicada y reglas `awg0` limitadas; no se limpia la configuración ajena.
- Sin migración desde 2.x, copias de seguridad, roles ni backend WireGuard heredado.
- El enrutamiento selectivo GeoIP queda aplazado hasta contar con un diseño del lado del servidor.

## Requisitos e instalación

Se requiere un VPS Linux `amd64`, `/dev/net/tun`, acceso root, un gestor de paquetes compatible y un puerto UDP entrante disponible. El instalador puede instalar Docker Engine, Docker Compose v2, iproute2 y nftables desde los repositorios del sistema.

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --host IP_PUBLICA_O_DOMINIO --lang es
```

También puede usar `--port`, `--panel-port` y `--lang en|ru|fa|es|zh-cn`. Si un puerto predeterminado está ocupado, el modo interactivo propone el siguiente libre; un puerto indicado explícitamente produce un error y nunca se cambia en silencio. Se admiten APT, DNF, YUM, Zypper, Pacman y APK. En NixOS, el instalador muestra un módulo declarativo y una orden `nixos-rebuild` limitada a un solo trabajo, sin editar automáticamente `configuration.nix`. El puerto del panel permanece privado aunque se cambie. El instalador muestra una vez la contraseña y el primer enlace Home. Importe el enlace en AmneziaVPN y abra `http://10.8.0.1:51821`.

## Administración local

```bash
docker compose run --rm --no-deps awg-easy reset-password
docker compose run --rm --no-deps awg-easy export-client "Home admin"
docker compose logs -f awg-easy
docker compose exec awg-easy awg show awg0
```

El material adaptado heredado se distribuye bajo **CC BY-NC-SA 4.0**. Consulte [LICENSE](LICENSE), [NOTICE](NOTICE) y [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Este proyecto no está afiliado ni respaldado por AmneziaVPN.
