# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

## Qué es AWG-Easy 3

Un panel Docker sencillo para **AmneziaWG 3.x**. Es un fork independiente y no comercial de [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy), reconstruido para instalaciones limpias de AWG 3.x.

> Versión actual: **0.1.6**, con el motor AWG **v3.1.20260828**. Los perfiles existentes siguen siendo válidos. Consulte las [notas de la versión](docs/releases/v0.1.6.md).

## Funciones principales

- Cree y exporte perfiles VPN desde el navegador; el panel solo es accesible dentro de la VPN.
- Forme una red privada con clientes Home o permita solo Internet a los clientes Guest.
- Controle IPv4/IPv6 por cliente, consulte diagnósticos e instale o actualice mediante comandos sencillos.

## Instalación y primer acceso

Se requiere un VPS Linux nativo `amd64`, `/dev/net/tun`, acceso root, un gestor de paquetes compatible y un puerto UDP entrante disponible. FreeBSD, OpenBSD, NetBSD, macOS y WSL se rechazan antes de instalar paquetes. El instalador puede instalar Docker Engine, Docker Compose v2, iproute2 y nftables desde los repositorios del sistema.

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --host IP_PUBLICA_O_DOMINIO --lang es
```

Para importar `vpn://`, use **[AmneziaVPN 5.0.0.5 o posterior](https://github.com/amnezia-vpn/amnezia-client/releases)**, también disponible para Android en [Google Play](https://play.google.com/store/apps/details?id=org.amnezia.vpn). Como alternativa, importe el archivo `.conf` descargado en **AmneziaWG 3.1**. La sección de compatibilidad detalla la versión Android probada, el acceso al panel por IPv6 y otros clientes.

El instalador muestra la contraseña del panel y el primer enlace Home `vpn://`. Impórtelo, conecte y abra `http://10.8.0.1:51821` (o la dirección interna indicada por el instalador). Autorice el puerto UDP elegido en el firewall del proveedor. Si perdió el enlace, exporte de nuevo el mismo perfil:

```bash
sudo awg-easy-3 export-client "Home admin"
```

### Añadir el panel como aplicación

Conecte un perfil VPN Home, abra el panel y use **Instalar aplicación**, **Añadir a la pantalla de inicio** o **Crear acceso directo** en el menú del navegador. El panel incluye un web-app manifest e iconos para una ventana independiente donde se admita. Esto no instala ni inicia la VPN: siguen siendo necesarios la conexión Home y el inicio de sesión. Las direcciones IPv4 e IPv6 son orígenes distintos y pueden crear aplicaciones y sesiones separadas.

La instalación automática de PWA suele requerir **HTTPS**; la dirección HTTP privada predeterminada no cumple ese requisito. Algunos navegadores permiten añadirla como aplicación de sitio o acceso directo; depende del navegador y del sistema. No se añade service worker, caché de perfiles sin conexión ni puerto público. Consulte los [requisitos de instalación](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

## Actualización y administración

```bash
sudo awg-easy-3 update
```

Actualice con `sudo awg-easy-3 update`, no con `reinstall`: se conservan clientes, claves, contraseña y puertos, y los clientes desactivados no se activan. Volver manualmente a una versión anterior puede desactivar por completo clientes parcialmente restringidos para no reabrir una familia prohibida. Consulte las [notas de la versión](docs/releases/v0.1.3.md).

No es necesario volver a importar los perfiles. La sustitución del contenedor puede interrumpir brevemente la conexión VPN.

Al volver a ejecutarlo de forma interactiva, el instalador detecta la instalación existente y permite conservarla, desinstalarla o reinstalarla desde cero. Las dos últimas opciones requieren confirmación y eliminan permanentemente todos los clientes, claves, contraseñas y ajustes de AWG-Easy 3. Para automatización existen `--uninstall` y `--reinstall`. Solo se eliminan el servicio Compose del proyecto, sus datos y su archivo sysctl; Docker, contenedores, imágenes, redes y reglas ajenas, así como los valores actuales de forwarding, no se modifican.

En systemd y OpenRC, el instalador activa sin preguntar una comprobación de versiones estables cinco minutos después de cada arranque. No instala cron ni un demonio permanente adicional. Ignora versiones preliminares y no cambia nada si la versión es actual o el panel se detuvo deliberadamente. Descarga y valida por completo la imagen candidata antes de sustituirla, conserva clientes, claves, contraseña, puertos y ajustes, y restaura la versión anterior si falla el healthcheck. Un fallo de red deja intacta la instalación activa. En otros sistemas init permanece disponible la actualización manual segura.

```bash
sudo awg-easy-3 help
sudo awg-easy-3 status
sudo awg-easy-3 update
sudo awg-easy-3 reset-password
sudo awg-easy-3 export-client "Home admin"
```

También están disponibles `start`, `stop`, `restart`, `settings`, `logs`, `diagnose`, `uninstall` y `reinstall` desde cualquier directorio. Gestione la comprobación al arrancar con `sudo awg-easy-3 auto-update status|enable|disable|run`; para desactivar la función predeterminada use `sudo awg-easy-3 auto-update disable`.

## Funciones técnicas

- Perfiles AWG 3.1 importados mediante enlaces `vpn://` y descarga opcional `.conf`.
- Modo Home con acceso al panel y a otros clientes Home; modo Guest con acceso únicamente a Internet.
- Permisos IPv4/IPv6 independientes en Ajustes de acceso, sin volver a importar el perfil.
- Estado de handshake reciente, velocidades medias por intervalo, handshake y endpoint, sin historial de tráfico.
- DNS AdGuard predeterminado: `94.140.14.14`, `94.140.15.15`, `2a10:50c0::ad1:ff` y `2a10:50c0::ad2:ff`.
- IPv6 automático mediante ULA y NAT66 limitado cuando el VPS dispone de IPv6.
- Descubrimiento mDNS y UPnP/SSDP solo para Home. UPnP IGD, NAT-PMP, PCP y cualquier apertura automática de puertos no se admiten de forma intencionada. La visibilidad depende de que la aplicación cliente admita multicast en la interfaz VPN.
- Panel disponible solo dentro de la VPN en `http://10.8.0.1:51821` y en su dirección IPv6 interna cuando esté disponible.
- Tabla nftables dedicada y reglas `awg0` limitadas; no se limpia la configuración ajena.
- Sin migración desde 2.x, copias de seguridad, roles ni backend WireGuard heredado.
- El enrutamiento selectivo GeoIP queda aplazado hasta contar con un diseño del lado del servidor.

### Ajustes de acceso del cliente

Abra **Ajustes de acceso** para permitir IPv4 e IPv6 por separado. Desactivar ambos desactiva al cliente; el modo sigue visible con la sección cerrada. Home/Guest es independiente. Los permisos se aplican en ambos sentidos dentro de la VPN, incluidas conexiones existentes, sin cambiar claves, perfiles, direcciones, DNS ni rutas. Se protegen la conexión actual al panel y el último cliente Home permitido; los enlaces internos IPv4/IPv6 están en Permisos de tráfico VPN.

**IPv6-only puede dejar de resolver nombres:** AmneziaVPN puede usar solo sus campos DNS IPv4 aunque el perfil incluya DNS IPv6. El acceso directo a una dirección IPv6 puede seguir funcionando; activar IPv4 restablece el acceso a DNS IPv4. No hay excepciones DNS, NAT64, WARP ni desvío a una conexión directa. El panel no controla tráfico excluido por el enrutamiento selectivo del cliente; desactive esos filtros para las pruebas básicas. El relay de descubrimiento usa IPv4 y excluye clientes con IPv4 bloqueado.

### Filtrado GeoIP

Los ajustes de acceso de cada cliente permiten desactivar el filtro, bloquear países seleccionados o permitir solo esos países. Introduzca nombres en el idioma del panel o códigos de dos letras, separados por comas, y guarde. No hace falta volver a importar el perfil VPN.

Se filtran rangos IP, no dominios: nftables comprueba IPv4 e IPv6 en ambas direcciones VPN ↔ internet, incluidas las conexiones establecidas. El acceso Home al panel y a otros clientes Home no cambia. Las aplicaciones excluidas de la VPN quedan fuera del filtro; no hay cambio automático a conexión directa. El país de una IP no garantiza la nacionalidad del servicio, la precisión ni evitar la detección de VPN. Las consultas a un DNS externo también pueden bloquearse.

[DB-IP Country Lite](https://db-ip.com/db/download/ip-to-country-lite) se descarga y actualiza automáticamente. Si falla la actualización, se conserva la base anterior; sin una base utilizable, un filtro activo deniega el acceso a internet. El panel muestra su estado. Véase el [informe técnico y de pruebas](docs/GEOIP_DATABASE.md).

**Volver a una versión anterior:** activar GeoIP por primera vez cambia los datos al formato v2, aunque después se desactive. La versión 0.1.5 no puede leerlo. Conserve una copia protegida de los datos antes de activarlo; después no basta con restaurar la imagen anterior.

### Diagnóstico de conexión

«Conexión reciente» indica un handshake en los últimos 150 segundos, no garantiza que el dispositivo siga conectado. Las velocidades son promedios por intervalo en bits/s: ↓ enviado al cliente, ↑ recibido del cliente. Los contadores pueden incluir tráfico de control; enviar no confirma la entrega. La primera muestra indica «Midiendo…»; un error o timeout muestra datos no disponibles, no velocidades antiguas. El intervalo real se muestra en los detalles de diagnóstico.

## Opciones de instalación y conflictos

Sin `--port` ni `AWG_PORT`, una instalación limpia elige un puerto UDP libre y aleatorio entre **20000–60000**, excluyendo el antiguo `51820`. Comprueba sockets del sistema y puertos publicados por Docker, muestra el puerto elegido y lo incluye en los perfiles. Autorícelo en el firewall del VPS/proveedor. Las actualizaciones conservan el puerto guardado; una reinstalación limpia vuelve a elegirlo salvo que se indique explícitamente. Esto no garantiza evitar la detección de VPN o el bloqueo de IP.

También puede usar `--port`, `--panel-port` y `--lang en|ru|fa|es|zh-cn`. Si el puerto TCP predeterminado del panel está ocupado, el modo interactivo propone el siguiente libre; un puerto indicado explícitamente produce un error y nunca se cambia en silencio. Se admiten APT, DNF, YUM, Zypper, Pacman y APK. En NixOS, el instalador muestra un módulo declarativo y una orden `nixos-rebuild` limitada a un solo trabajo, sin editar automáticamente `configuration.nix`. El puerto del panel permanece privado aunque se cambie. El instalador muestra una vez la contraseña y el primer enlace Home. Importe el enlace en AmneziaVPN y abra `http://10.8.0.1:51821`.

## Compatibilidad y pruebas de campo

Estos perfiles requieren un cliente AWG 3.x; WireGuard convencional y clientes AWG antiguos no son compatibles. AWG-Easy 3 es independiente de los proyectos cliente.

- **Android, alternativa verificada:** [AmneziaWG v3.1.20260814](https://github.com/amnezia-vpn/amneziawg-android/releases/tag/v3.1.20260814). La pantalla de información muestra aplicación **3.1.20260813** y motor **3.1.20260814**. El 09-09-2026 el usuario confirmó en Honor 50 la importación de nuestro `.conf`, la conexión y el acceso al panel por IPv4 e IPv6. Importe el archivo, no `vpn://`; **2.0.1 no es compatible**. La descarga usa un nombre ASCII corto, como `Honor_50.conf`, sin cambiar el nombre visible del cliente ni el contenido. Los nombres compuestos solo por caracteres no ASCII usan `AWG-client.conf`.
- **Escritorio, candidato a evaluación:** [Throne 1.3.0-beta.2](https://github.com/throneproj/Throne/releases/tag/1.3.0-beta.2) implementa los campos AWG 3.x, incluidos `RandomTrailers` y `DisableCookies`. Pruebe la importación `.conf`. Es una beta; **el panel IPv6 y la red Home con AWG-Easy 3 aún no se han probado en condiciones reales**.
- **Opción avanzada:** [Mihomo 1.19.30](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.30) implementa AWG 3.0/3.1. Requiere un YAML adecuado con `amnezia-wg-option.version: 3`; no todas las interfaces gráficas incluyen ese motor. Aquí no se han verificado la importación, el panel IPv6 ni la red Home.

**AmneziaVPN 5.0.2.1 en Android:** la prueba comparativa en Honor 50 mostró un tiempo de espera al abrir el panel IPv6, mientras que el mismo perfil funcionó con AmneziaWG. Su [procesamiento de rutas Android](https://github.com/amnezia-vpn/amnezia-client/blob/5.0.2.1/client/android/protocolApi/src/main/kotlin/ProtocolConfig.kt) sustituye `::/0` por `2000::/3`, excluyendo la dirección ULA interna incluso en modo Todos los sitios. Use el panel IPv4 o la alternativa Android verificada. No se generaliza a todas las versiones/plataformas. Internet, DNS, servicios Home y descubrimiento requieren pruebas independientes.

Pruebas de campo anteriores, hasta **0.1.3** inclusive. Añade permisos IPv4/IPv6 por cliente y Ajustes de acceso plegables. Además de Ubuntu/systemd, ya se probaron la instalación, migración y reinicios en un VPS real con Alpine/OpenRC. Los últimos cambios de interfaz se probaron localmente tras eliminar el VPS. Consulte las [notas de la versión](docs/releases/v0.1.3.md) y el [informe de Alpine (en ruso)](docs/VPS_TEST_2026-08-31.ru.md).

AWG 3.1, Docker, la importación en AmneziaVPN para Android, IPv4/IPv6, el aislamiento Home/Guest y la revocación de perfiles ya se validaron en un VPS. La retransmisión Home del servidor y la reescritura de direcciones SSDP también se validaron entre dos peers reales; la visibilidad final depende del soporte multicast de la aplicación cliente sobre la interfaz VPN.

## Licencia y atribución

El material adaptado heredado se distribuye bajo **CC BY-NC-SA 4.0**. Consulte [LICENSE](LICENSE), [NOTICE](NOTICE) y [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Este proyecto no está afiliado ni respaldado por AmneziaVPN.
