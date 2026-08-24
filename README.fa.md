# AWG-Easy 3

[English](README.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md)

یک پنل سادهٔ Docker برای **AmneziaWG 3.x**. این پروژه یک فورک مستقل و غیرتجاری از [JohnnyVBut/awg-easy](https://github.com/JohnnyVBut/awg-easy) است که برای نصب تمیز AWG 3.x بازسازی شده است.

> وضعیت: نامزد پیش‌انتشار. موتور AWG 3.1، استقرار Docker، ورود پروفایل در AmneziaVPN اندروید، IPv4/IPv6، جداسازی Home/Guest و لغو پروفایل حذف‌شده روی VPS آزمایش شده‌اند. بازپخش سمت سرور برای Discovery شبکهٔ Home و بازنویسی نشانی SSDP نیز میان دو peer واقعی تأیید شده است؛ نمایش نهایی به ارسال و دریافت multicast روی رابط VPN توسط برنامهٔ کلاینت بستگی دارد.

## امکانات

- پروفایل AWG 3.1 با پیوند `vpn://` و امکان دریافت فایل `.conf`.
- کاربران Home به پنل و دیگر کاربران Home دسترسی دارند؛ Guest فقط به اینترنت دسترسی دارد.
- وضعیت آنلاین، سرعت لحظه‌ای دریافت/ارسال، handshake و endpoint بدون نگهداری تاریخچهٔ ترافیک.
- DNS پیش‌فرض AdGuard: `94.140.14.14`، `94.140.15.15`، `2a10:50c0::ad1:ff` و `2a10:50c0::ad2:ff`.
- IPv6 خودکار با ULA و NAT66 محدود، در صورت پشتیبانی VPS.
- کشف سرویس با mDNS و UPnP/SSDP فقط برای Home فعال است. UPnP IGD، NAT-PMP، PCP و هرگونه باز کردن خودکار پورت عمداً پشتیبانی نمی‌شوند. نمایش سرویس‌ها به پشتیبانی برنامهٔ کلاینت از multicast روی رابط VPN بستگی دارد.
- پنل فقط درون VPN و در `http://10.8.0.1:51821` در دسترس است.
- جدول اختصاصی nftables؛ قوانین سرویس‌های دیگر دست‌کاری یا پاک نمی‌شوند.
- بدون مهاجرت از 2.x، پشتیبان‌گیری، نقش‌های کاربری یا WireGuard قدیمی.
- مسیریابی انتخابی GeoIP تا طراحی مناسب سمت سرور به تعویق افتاده است.

## نیازمندی و نصب

یک VPS لینوکس بومی `amd64`، مسیر `/dev/net/tun`، دسترسی root، مدیر بستهٔ پشتیبانی‌شده و یک پورت UDP ورودی آزاد لازم است. FreeBSD، OpenBSD، NetBSD، macOS و WSL پیش از نصب بسته‌ها رد می‌شوند. نصب‌کننده در صورت نیاز Docker Engine، Docker Compose v2، iproute2 و nftables را از مخزنهای سیستم نصب می‌کند.

```bash
git clone https://github.com/alexsemenovru/awg-easy-3.git
cd awg-easy-3
sudo ./install.sh --host PUBLIC_IP_OR_DOMAIN --lang fa
```

گزینه‌های `--port`، `--panel-port` و `--lang en|ru|fa|es|zh-cn` نیز پشتیبانی می‌شوند. اگر پورت پیش‌فرض اشغال باشد، اجرای تعاملی نزدیک‌ترین پورت آزاد را پیشنهاد می‌دهد؛ پورت اشغال‌شده‌ای که صریحاً تعیین شده باشد بدون تغییر مخفیانه خطا می‌دهد. APT، DNF، YUM، Zypper، Pacman و APK پشتیبانی می‌شوند. در NixOS نصب‌کننده یک ماژول اعلانی و فرمان تک‌وظیفه‌ای `nixos-rebuild` را نمایش می‌دهد و `configuration.nix` را خودکار ویرایش نمی‌کند. پورت پنل حتی پس از تغییر عمومی نمی‌شود. نصب‌کننده رمز عبور و نخستین پیوند Home را فقط یک بار نمایش می‌دهد. پیوند را در AmneziaVPN وارد کنید و `http://10.8.0.1:51821` را باز کنید.

با اجرای دوباره در ترمینال تعاملی، نصب‌کننده نصب موجود را تشخیص می‌دهد و گزینه‌های حفظ، حذف کامل یا نصب مجدد از صفر را ارائه می‌کند. دو گزینهٔ آخر نیازمند تأیید هستند و همهٔ کلاینت‌ها، کلیدها، گذرواژه و تنظیمات AWG-Easy 3 را برای همیشه حذف می‌کنند. برای اجرای خودکار می‌توان از `--uninstall` یا `--reinstall` استفاده کرد. فقط سرویس Compose این پروژه، داده‌های آن و فایل sysctl خودش حذف می‌شوند؛ Docker، کانتینرها، imageها، شبکه‌ها و قوانین دیگر و مقادیر فعلی forwarding میزبان دست‌نخورده می‌مانند.

## مدیریت محلی

```bash
docker compose run --rm --no-deps awg-easy reset-password
docker compose run --rm --no-deps awg-easy export-client "Home admin"
docker compose logs -f awg-easy
docker compose exec awg-easy awg show awg0
```

مطالب اقتباس‌شدهٔ به‌ارث‌رسیده تحت مجوز **CC BY-NC-SA 4.0** منتشر می‌شوند. [LICENSE](LICENSE)، [NOTICE](NOTICE) و [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) را ببینید. این پروژه وابسته به AmneziaVPN نیست و تأیید رسمی آن را ندارد.
