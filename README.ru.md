# AWG-Easy 3

Простая Docker-панель для **AmneziaWG 3.x**. Независимый некоммерческий форк [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy), переписанный для чистой установки AWG 3.x.

> Статус: prerelease-кандидат. Локальные тесты проходят, но реальная совместимость движка, AmneziaVPN Android и Home discovery должна быть подтверждена на отдельной VPS до первого релиза.

## Что уже реализовано

- AWG 3.1 `HeaderProtectionKey`, `AdvancedSecurity`, новые timing/padding-поля, `RandomTrailers` и `DisableCookies`.
- Основной импорт в AmneziaVPN через локально созданную ссылку `vpn://` и QR-код; `.conf` доступен дополнительно.
- Home/Guest для каждого клиента. Home видит панель и других Home peers, Guest получает только интернет.
- Компактные full-tunnel профили для IPv4 и, когда VPS поддерживает его, IPv6.
- AdGuard DNS по умолчанию: `94.140.14.14`, `94.140.15.15`, а при IPv6 также `2a10:50c0::ad1:ff`, `2a10:50c0::ad2:ff`.
- Автоматический IPv6 при наличии глобального адреса и default route на VPS: отдельная ULA `/64` и NAT66 только для неё.
- Home-only mDNS и SSDP discovery без UPnP IGD, NAT-PMP, PCP и открытия портов.
- Панель слушает только `10.8.0.1:51821` внутри AWG-сети. Публичного TCP mapping нет.
- Один пароль без ролей. Смена пароля отзывает все сессии; локальный reset не требует переустановки.
- nftables в отдельной таблице `awg_easy_3`; чужие таблицы не очищаются.
- Чистая установка без миграций, backup/restore и legacy WireGuard backend.

## Требования

- Linux VPS, архитектура `amd64`/`x86_64`.
- Docker Engine и Docker Compose v2.
- Доступный `/dev/net/tun`.
- Входящий UDP `51820` в firewall VPS/облачном firewall.
- Запуск установщика от root.

## Установка

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --host ПУБЛИЧНЫЙ_IP_ИЛИ_ДОМЕН --lang ru
```

Установщик:

1. проверит архитектуру, Docker Compose и TUN;
2. включит IPv4/IPv6 forwarding через `/etc/sysctl.d/99-awg-easy-3.conf`;
3. соберёт закреплённый `linux/amd64` образ;
4. создаст первый профиль Home;
5. один раз покажет пароль, QR и `vpn://`;
6. запустит контейнер.

Необязательные параметры позволяют избежать конфликтов с другой инфраструктурой:

```bash
sudo ./install.sh --host vpn.example.com --port 51820 --panel-port 51821 --lang en
```

Поддерживаемые языки панели: английский (`en`, по умолчанию), русский (`ru`) и фарси (`fa`, RTL). `--port` задаёт публичный UDP-порт AWG, а `--panel-port` — внутренний TCP-порт панели, который по-прежнему не публикуется в интернет.

Добавьте первый профиль в AmneziaVPN, подключитесь и откройте:

```text
http://10.8.0.1:51821
```

## Локальные административные команды

```bash
# Новый случайный пароль; все старые сессии будут отозваны
docker compose run --rm --no-deps awg-easy reset-password

# Задать новый пароль вручную (не менее 12 символов)
docker compose run --rm --no-deps awg-easy reset-password 'новый-надежный-пароль'

# Диагностика
docker compose logs -f awg-easy
docker compose exec awg-easy awg show awg0
docker compose exec awg-easy nft list table inet awg_easy_3
```

## Важные ограничения prerelease

- Миграции из AWG-Easy 2.x намеренно нет.
- Backup/restore намеренно отсутствует.
- Обычные WireGuard-клиенты не поддерживают AWG 3.x.
- Выборочная маршрутизация по GeoIP отложена до отдельного архитектурного решения: текущая версия всегда использует full tunnel.
- mDNS/SSDP relay не открывает порты и не является UPnP IGD.
- Реальная Docker-сборка и сетевые тесты отложены до появления тестовой VPS.

Архитектура и точные решения описаны в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), продуктовая спецификация — в [docs/PRODUCT_SPEC.ru.md](docs/PRODUCT_SPEC.ru.md).

## Лицензия и авторство

Унаследованный адаптированный материал распространяется по **CC BY-NC-SA 4.0**. См. [LICENSE](LICENSE) и [NOTICE](NOTICE). Проект не связан с AmneziaVPN и не одобрен её разработчиками.
