# GeoIP database lifecycle (development)

This describes local, unreleased work. The automatic database service and rule
compiler are implemented, along with country selection in client cards.
Do not edit `state.json` manually to enable experimental GeoIP policies.

## Client controls

Access settings contain Off / Block selected / Allow only selected modes and
comma-separated country entry with suggestions. Country names are resolved using
the browser's region names in English, Russian, Spanish, Persian and Chinese;
two-letter codes also work. Unknown or ambiguous input is rejected. Stored values
are normalized country codes. Existing profiles remain unchanged.

The authenticated API accepts `geoPolicy: { mode, countries }` in a client PATCH.
Non-off policies require the selected countries in the loaded database, including
when the client is disabled. Missing data or rejected firewall application leaves
the saved policy unchanged. The filter applies to DNS packets too; there are no
DNS exceptions, domain classification or direct routes.

## Source and licence

The service downloads **DB-IP IP to Country Lite**, directly from
`https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.csv.gz`.
No Xray binary, DNS proxy, GeoSite database or extra container is involved.

- [Source and downloads](https://db-ip.com/db/download/ip-to-country-lite)
- [CSV format](https://db-ip.com/db/format/ip-to-country-lite/csv.html)
- [DB-IP Lite licensing terms](https://db-ip.com/db/lite.php)
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

The database is a separate CC BY 4.0 work, not covered by the application's
licence. The panel includes the required **IP Geolocation by DB-IP** link.
The source archive is preserved unchanged; the in-memory representation groups
its address ranges by country for nftables. Lite coverage and accuracy are
limited. An IP country is not a service's nationality or a VPN-detection guarantee.

## Automatic operation

- Starts with the panel, after a random 1–30 second delay. A missing database does
  not hold up a normal installation without country policies.
- Checks once per day, with up to 20% jitter. DB-IP publishes monthly editions;
  an already cached edition is not downloaded again each day.
- Retries failures after 5 minutes, then backs off exponentially up to 24 hours,
  plus jitter. No reboot, cron job or manual command is required.
- On a first installation only, a 404 for the current month permits trying the
  previous month. Other failures do not trigger alternate sources or insecure HTTP.
- A temporary Node worker parses the archive, so decompression/validation does
  not occupy the HTTP server's event loop. It exits after parsing.
- The authenticated GeoIP status endpoint reports ready/updating/stale/unavailable,
  the installed edition and last check. The panel shows this in all five languages.

## Validation and persistence

Downloads have a 120-second deadline, a 32 MiB compressed limit and no redirects.
Parsing has a separate 120-second deadline, a 256 MiB worker heap limit and a
96 MiB decompressed limit. At most 1.5 million CSV rows are accepted. A full
edition must have at least 100,000 rows, 200 country/territory codes and both IP
families. Addresses, country-code syntax, order and non-overlapping ranges are
checked. Compiler selection limits provide an additional bound on nftables output.

`/data/geoip/current.db` contains a versioned envelope, edition, SHA-256 and the
original gzip payload. Its checksum and source structure are rechecked on startup.
The checksum detects local corruption, **not** a malicious database publisher.
HTTPS and a fixed source establish the transport trust boundary.

A candidate is written to an exclusive temporary file, synced and renamed within
the same directory. Download/parse/write/rename failures retain the old snapshot.
Database installation uses the same queue as client mutations. New rules are
checked/applied before the file commit; a failed file commit restores the old
rules. When no active GeoIP policy changes the firewall, a database update does
not touch the running AWG interface. If rollback itself fails, the update reports
an error; this is not reported as successful protection.

With active policies but no usable snapshot, startup tries to recover the database
and otherwise refuses to build missing-country rules rather than silently removing
the filter. This exceptional startup path may therefore require network access.

## Local verification (2026-09-10)

- Desktop and 390 px preview: country controls fit; saving normalizes country names.
  These are synthetic browser previews, not a real Android-device test.
- Persian RTL controls fit at 390 px and accept Persian country names. Unknown
  country input produces an error without losing the draft. Error messages now
  participate in language switching.
- State persistence tests cover the sticky v2 transition, retained keys and reload.
  The actual v0.1.5 validator from its Git tag rejects v2 before reading clients.
  This is not yet an end-to-end container rollback test.
- Application tests cover cached-data restart without downloading, unchanged
  exported vpn links, and refusal to apply rules when recovery fails or the
  selected country is absent. The full local suite passes 238 tests.
- Ubuntu under WSL, in a disposable root network namespace: **202 packet assertions
  passed** using `src/test/helpers/verify-ip-families-linux.py` and policies from
  `src/test/helpers/ip-family-policies.js`. Both families, block/allow modes, empty
  country sets, established flows, Home access and unrelated forwarding were tested.
  A foreign nftables table remained unchanged. No host/VPS networking was modified.
- The kernel test exposed nftables rejecting single-address ranges. The compiler
  now converts these to /32 or /128 host prefixes, with a regression test.

## Still required before release

- A real mobile-browser check (desktop synthetic 390 px and RTL checks passed).
- Production updater download/persistence verification (full archive offline parse
  and rule application passed on the temporary VPS; see below).
- Full-database nftables application/resource checks (packet tests above use
  synthetic ranges, not the full upstream edition).
- Upgrade/rollback compatibility and resource measurements on a small VPS.

### Temporary VPS: full edition check

Ubuntu 26.04.1, 889 MiB RAM, stable v0.1.5 remained healthy during isolated tests.
Official September 2026 archive downloaded completely (4,522,052 bytes) and passed
gzip validation. SHA-256:
`a32bb3c384bd3de60ad9024596aa5b395a6dd5beaa27a7223407cc2edc681d0b`.

Current parser ran offline in the stable image's Node 22.18 runtime with a 512 MiB
container limit: 717,170 rows, 251 country codes, 7.202 seconds. Sampled process RSS
peaked at 320,516,096 bytes (about 306 MiB); this is not a measurement of total
production-panel or kernel memory. Worker heap limit remained 256 MiB.

Full IPv4/IPv6 block rules checked/applied with nftables in a disposable network
namespace: RU 0.151/0.144 s, CN 0.092/0.092 s, IR 0.026/0.026 s,
US 0.890/0.771 s. This verifies real set loading, not end-to-end VPN filtering.
Helpers: `verify-full-geoip.js` and `verify-full-geoip-linux.py` under
`src/test/helpers/`. The host firewall was not changed by these checks.

Production `GeoIpUpdater` also passed on this VPS in a separate 512 MiB container:
real download, atomic persistence, offline reload, same-edition check without
network, and simulated next-month download failure retaining identical cache bytes
and reporting `stale`. See `verify-geoip-updater-live.js`.

A local test-only image overlays current `src` on the pinned v0.1.5 image
(`Dockerfile.geoip-preview`). This is not a published release or a full Dockerfile
rebuild. After replacing the stable container with this image, health was healthy,
`state.json` was byte-identical to its pre-test backup, and the live panel's
scheduler automatically created `data/geoip/current.db`. A post-load container
memory sample was 89.88 MiB, not a peak measurement. Source cache and state backups
remain on the disposable VPS; results here survive its deletion.

Still pending: real VPN country-policy traffic, enabled-policy restart, actual
container rollback checks and user phone verification. Do not infer these from
the successful image replacement or offline/kernel checks above.

### Replacement VPS: container upgrade/rollback completed

On the replacement Ubuntu test VPS, `scripts/test-awg-upgrade.cjs` completed with
exit 0 against the local candidate image, using pinned v0.1.5 for previous server
and client engines. Tests used disposable Docker namespaces/data, not panel data.
Existing clients reconnected after 19 seconds on upgrade and 21 seconds on rollback.
Both panel address families, the generated IPv6 panel link/login, 2 MiB transfers,
Guest panel denial and the four IPv4/IPv6 permission combinations passed.
Snapshots confirmed unchanged state, keys, auth, ports and exported profiles.
Disposable resources were cleaned by the script. This closes container rollback
for **v1 state without GeoIP**, not the v2 refusal/recovery or country traffic tests.

### Recreated VPS: enabled-policy lifecycle

Using the local candidate on the recreated test VPS, the production ClientManager
enabled RU blocking for the disposable Home admin. State became v2; exports were
unchanged and inbound/outbound GeoIP rules appeared. After a Docker restart,
`geoip-lifecycle.js verify` confirmed the same state, exports and rules; the panel
was healthy. A separate v0.1.5 `serve` container with no network and read-only
access to test data exited 1 with `Unsupported state version: 2; expected 1`.
This verifies old-image rejection, not a full stop-old-start-new rollback cycle.
Real end-to-end VPN country traffic and phone verification remain pending.

### Owner phone check

Owner confirmed Home panel access with RU blocking enabled. Controlled browser
comparison: mail.ru opened after disabling GeoIP and failed again after restoring
RU blocking, without disconnecting the VPN. This confirms that case, not every
country/IP family or application. Country entry suggestions were visible on Android.
Delta Chat could add a message to Saved Messages while blocking was enabled;
this does not establish SMTP delivery (self-chat may remain local). No bypass
conclusion has been drawn; external delivery and destination IP were not verified.

Owner subsequently confirmed Delta Chat was excluded from the VPN by client split
tunneling; its delivery is therefore not a GeoIP bypass. In allow-only RU mode,
Home panel and mail.ru remained available, while google.com, example.com and
Telegram were unavailable. After switching filtering off, Telegram resumed and
mail.ru, google.com and ipv6.google.com opened. This is a successful phone control
test, but does not isolate each IP family or prove all established-flow cases.

The 202-assertion packet matrix was subsequently repeated successfully on the
actual Ubuntu VPS kernel in a disposable network namespace. Explicit IPv4/IPv6
block/allow, established return flows, independent Home client forwarding,
Home-panel traffic, empty country sets and foreign-table preservation passed.
These are synthetic injected IP packets through production-generated nftables
rules, not encrypted end-to-end client sessions. Combined with the owner's
phone tests they cover distinct layers; neither should be described as the other.

Enabling a non-off GeoIP policy upgrades state to version 2 atomically with the
policy save. Current code reads versions 1 and 2; older panels reject version 2
instead of ignoring the filter. Keys and exported profiles are unchanged. The
version stays 2 after disabling filters, so this is not an automatic downgrade
path. Installations that never enable GeoIP retain version 1.

The root `STATE_VERSION` update-compatibility marker remains 1: upgrading an
existing installation does not itself migrate its state. State v2 is activated
only by a successful GeoIP policy mutation. Container upgrade tests must cover
both untouched v1 state and already-enabled v2 state; do not infer downgrade
safety from the root marker alone.

Do not roll back a GeoIP installation to pre-GeoIP images: they will not start
with this state. Restoring a pre-GeoIP backup also restores its old settings and
does not retain newer filters/clients. The format guard prevents silent acceptance
by old code; it does not guarantee continued connectivity during a failed rollback.

## Temporary VPS acceptance checklist

Keep DB-IP Lite as the source. Reconsider alternatives only if the full download
also fails on the test VPS (decision agreed with the project owner).

1. Download and validate the complete official edition with the production updater;
   record edition, compressed size, rows, parse duration and peak memory.
2. Apply full-country IPv4/IPv6 sets in an isolated namespace first; measure nft
   validation/application time and memory. Then test through disposable VPN peers.
3. Check block/allow modes, existing flows, other clients and Home-panel access.
4. Restart with the cached edition while the source is unavailable. Verify that
   the last valid rules remain effective and updater errors are visible.
5. Upgrade a disposable v0.1.5 installation before enabling GeoIP; compare exports,
   keys and settings. Test a failed-update rollback with unchanged v1 state.
6. Enable GeoIP and verify persistence across restart. Check that a pre-GeoIP
   image rejects v2; restore the new image and confirm filtering resumes.
7. Perform the short real Android-browser check. Publish only after recording
   results; no tests against the owner's personal production VPS.
