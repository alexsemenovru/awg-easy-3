# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

Un panel Docker sencillo para **AmneziaWG 3.x**. Es un fork independiente y no comercial de [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy), reconstruido para instalaciones limpias de AWG 3.x.

> Versión actual: **0.1.2**. Consulte las [notas de la versión](docs/releases/v0.1.2.md) y el [informe de campo (en ruso)](docs/VPS_TEST_2026-08-30.ru.md). Las pruebas reales cubrieron Ubuntu/systemd, incluido el cambio de perfil en el teléfono y una prueba controlada de tráfico residual. Los últimos cambios de interfaz se probaron localmente en navegadores; OpenRC aún requiere pruebas en un servidor real.

> AWG 3.1, Docker, la importación en AmneziaVPN para Android, IPv4/IPv6, el aislamiento Home/Guest y la revocación de perfiles ya se validaron en un VPS. La retransmisión Home del servidor y la reescritura de direcciones SSDP también se validaron entre dos peers reales; la visibilidad final depende del soporte multicast de la aplicación cliente sobre la interfaz VPN.

## Funciones

- Perfiles AWG 3.1 importados mediante enlaces `vpn://` y descarga opcional `.conf`.
- Modo Home con acceso al panel y a otros clientes Home; modo Guest con acceso únicamente a Internet.
- Estado de handshake reciente, velocidades medias por intervalo, handshake y endpoint, sin historial de tráfico.
- DNS AdGuard predeterminado: `94.140.14.14`, `94.140.15.15`, `2a10:50c0::ad1:ff` y `2a10:50c0::ad2:ff`.
- IPv6 automático mediante ULA y NAT66 limitado cuando el VPS dispone de IPv6.
- Descubrimiento mDNS y UPnP/SSDP solo para Home. UPnP IGD, NAT-PMP, PCP y cualquier apertura automática de puertos no se admiten de forma intencionada. La visibilidad depende de que la aplicación cliente admita multicast en la interfaz VPN.
- Panel disponible únicamente dentro de la VPN en `http://10.8.0.1:51821`.
- Tabla nftables dedicada y reglas `awg0` limitadas; no se limpia la configuración ajena.
- Sin migración desde 2.x, copias de seguridad, roles ni backend WireGuard heredado.
- El enrutamiento selectivo GeoIP queda aplazado hasta contar con un diseño del lado del servidor.

## Diagnóstico de conexión

«Conexión reciente» indica un handshake en los últimos 150 segundos, no garantiza que el dispositivo siga conectado. Las velocidades son promedios por intervalo en bits/s: ↓ enviado al cliente, ↑ recibido del cliente. Los contadores pueden incluir tráfico de control; enviar no confirma la entrega. La primera muestra indica «Midiendo…»; un error o timeout muestra datos no disponibles, no velocidades antiguas. El intervalo real se muestra en los detalles de diagnóstico.

## Aplicación cliente

Use **[AmneziaVPN 5.0.0.5 o posterior](https://github.com/amnezia-vpn/amnezia-client/releases)** para importar los perfiles creados por AWG-Easy 3. En Android, instale la versión actual de [AmneziaVPN desde Google Play](https://play.google.com/store/apps/details?id=org.amnezia.vpn). Importe el enlace `vpn://` mostrado por el instalador o el panel; también puede descargar un archivo `.conf` cuando sea necesario.

AWG 3.x no es compatible con AWG 2.x. Los clientes WireGuard convencionales y la aplicación AmneziaWG independiente no admiten actualmente estos perfiles. AWG-Easy 3 es independiente de AmneziaVPN; se menciona únicamente como cliente compatible verificado.

## Requisitos e instalación

Se requiere un VPS Linux nativo `amd64`, `/dev/net/tun`, acceso root, un gestor de paquetes compatible y un puerto UDP entrante disponible. FreeBSD, OpenBSD, NetBSD, macOS y WSL se rechazan antes de instalar paquetes. El instalador puede instalar Docker Engine, Docker Compose v2, iproute2 y nftables desde los repositorios del sistema.

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --host IP_PUBLICA_O_DOMINIO --lang es
```

Sin `--port` ni `AWG_PORT`, una instalación limpia elige un puerto UDP libre y aleatorio entre **20000–60000**, excluyendo el antiguo `51820`. Comprueba sockets del sistema y puertos publicados por Docker, muestra el puerto elegido y lo incluye en los perfiles. Autorícelo en el firewall del VPS/proveedor. Las actualizaciones conservan el puerto guardado; una reinstalación limpia vuelve a elegirlo salvo que se indique explícitamente. Esto no garantiza evitar la detección de VPN o el bloqueo de IP.

También puede usar `--port`, `--panel-port` y `--lang en|ru|fa|es|zh-cn`. Si el puerto TCP predeterminado del panel está ocupado, el modo interactivo propone el siguiente libre; un puerto indicado explícitamente produce un error y nunca se cambia en silencio. Se admiten APT, DNF, YUM, Zypper, Pacman y APK. En NixOS, el instalador muestra un módulo declarativo y una orden `nixos-rebuild` limitada a un solo trabajo, sin editar automáticamente `configuration.nix`. El puerto del panel permanece privado aunque se cambie. El instalador muestra una vez la contraseña y el primer enlace Home. Importe el enlace en AmneziaVPN y abra `http://10.8.0.1:51821`.

Al volver a ejecutarlo de forma interactiva, el instalador detecta la instalación existente y permite conservarla, desinstalarla o reinstalarla desde cero. Las dos últimas opciones requieren confirmación y eliminan permanentemente todos los clientes, claves, contraseñas y ajustes de AWG-Easy 3. Para automatización existen `--uninstall` y `--reinstall`. Solo se eliminan el servicio Compose del proyecto, sus datos y su archivo sysctl; Docker, contenedores, imágenes, redes y reglas ajenas, así como los valores actuales de forwarding, no se modifican.

En systemd y OpenRC, el instalador activa sin preguntar una comprobación de versiones estables cinco minutos después de cada arranque. No instala cron ni un demonio permanente adicional. Ignora versiones preliminares y no cambia nada si la versión es actual o el panel se detuvo deliberadamente. Descarga y valida por completo la imagen candidata antes de sustituirla, conserva clientes, claves, contraseña, puertos y ajustes, y restaura la versión anterior si falla el healthcheck. Un fallo de red deja intacta la instalación activa. En otros sistemas init permanece disponible la actualización manual segura.

## Administración local

```bash
sudo awg-easy-3 help
sudo awg-easy-3 status
sudo awg-easy-3 update
sudo awg-easy-3 reset-password
sudo awg-easy-3 export-client "Home admin"
```

También están disponibles `start`, `stop`, `restart`, `settings`, `logs`, `diagnose`, `uninstall` y `reinstall` desde cualquier directorio. Gestione la comprobación al arrancar con `sudo awg-easy-3 auto-update status|enable|disable|run`; para desactivar la función predeterminada use `sudo awg-easy-3 auto-update disable`.

El material adaptado heredado se distribuye bajo **CC BY-NC-SA 4.0**. Consulte [LICENSE](LICENSE), [NOTICE](NOTICE) y [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Este proyecto no está afiliado ni respaldado por AmneziaVPN.
