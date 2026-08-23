#!/bin/sh
set -eu

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '\n==> %s\n' "$*"; }
valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

[ "$(id -u)" -eq 0 ] || die "run this installer as root: sudo ./install.sh"
case "$(uname -m)" in x86_64|amd64) ;; *) die "only linux/amd64 is supported in this release" ;; esac
command -v docker >/dev/null 2>&1 || die "Docker Engine is not installed"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is not installed"
command -v ip >/dev/null 2>&1 || die "iproute2 is not installed"
command -v ss >/dev/null 2>&1 || die "the iproute2 ss utility is not installed"
[ -c /dev/net/tun ] || die "/dev/net/tun is unavailable on this VPS"

AWG_HOST_VALUE=${AWG_HOST:-}
AWG_PORT_VALUE=${AWG_PORT:-51820}
AWG_PANEL_PORT_VALUE=${AWG_PANEL_PORT:-51821}
AWG_LANG_VALUE=${AWG_LANG:-en}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) [ "$#" -ge 2 ] || die "--host requires an IPv4 address or DNS name"; AWG_HOST_VALUE=$2; shift 2 ;;
    --port) [ "$#" -ge 2 ] || die "--port requires a UDP port"; AWG_PORT_VALUE=$2; shift 2 ;;
    --panel-port) [ "$#" -ge 2 ] || die "--panel-port requires a TCP port"; AWG_PANEL_PORT_VALUE=$2; shift 2 ;;
    --lang) [ "$#" -ge 2 ] || die "--lang requires en, ru, fa, es or zh-cn"; AWG_LANG_VALUE=$2; shift 2 ;;
    --help) printf 'Usage: sudo ./install.sh [--host HOST] [--port UDP_PORT] [--panel-port TCP_PORT] [--lang en|ru|fa|es|zh-cn]\n'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

valid_port "$AWG_PORT_VALUE" || die "--port must be an integer between 1 and 65535"
valid_port "$AWG_PANEL_PORT_VALUE" || die "--panel-port must be an integer between 1 and 65535"
case "$AWG_LANG_VALUE" in en|ru|fa|es|zh-cn) ;; *) die "--lang must be en, ru, fa, es or zh-cn" ;; esac

if [ -z "$AWG_HOST_VALUE" ]; then
  AWG_HOST_VALUE=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit } }')
fi
[ -n "$AWG_HOST_VALUE" ] || die "unable to detect the public endpoint; use --host PUBLIC_IP_OR_DOMAIN"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
[ ! -e data/state.json ] || die "AWG-Easy 3 is already initialized in $SCRIPT_DIR/data"

info "Checking interface, subnet and port availability"
if ip link show dev awg0 >/dev/null 2>&1; then
  die "network interface awg0 already exists"
fi
if ip -4 route show exact 10.8.0.0/24 | grep -q .; then
  die "VPN subnet 10.8.0.0/24 conflicts with an existing route"
fi
if ss -H -lun "sport = :$AWG_PORT_VALUE" | grep -q .; then
  die "UDP port $AWG_PORT_VALUE is already in use"
fi
if ss -H -ltn "sport = :$AWG_PANEL_PORT_VALUE" | grep -q .; then
  die "TCP port $AWG_PANEL_PORT_VALUE is already in use"
fi

info "Enabling IPv4/IPv6 forwarding"
umask 077
cat > /etc/sysctl.d/99-awg-easy-3.conf <<'EOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
EOF
chmod 0644 /etc/sysctl.d/99-awg-easy-3.conf
sysctl --system >/dev/null

install -d -m 0700 data
export AWG_HOST="$AWG_HOST_VALUE"
export AWG_PORT="$AWG_PORT_VALUE"
export AWG_PANEL_PORT="$AWG_PANEL_PORT_VALUE"
export AWG_LANG="$AWG_LANG_VALUE"

info "Building the pinned linux/amd64 image"
docker compose build --pull awg-easy

info "Creating the first Home profile"
docker compose run --rm --no-deps \
  -e AWG_HOST="$AWG_HOST_VALUE" \
  -e AWG_PORT="$AWG_PORT_VALUE" \
  -e AWG_PANEL_PORT="$AWG_PANEL_PORT_VALUE" \
  -e AWG_LANG="$AWG_LANG_VALUE" \
  awg-easy init

info "Starting AWG-Easy 3"
docker compose up -d awg-easy

printf '\nInstallation complete.\n'
printf 'AWG endpoint: %s:%s/udp\n' "$AWG_HOST_VALUE" "$AWG_PORT_VALUE"
printf 'Panel language: %s\n' "$AWG_LANG_VALUE"
printf 'The panel has no public TCP listener. Connect the first Home profile, then open http://10.8.0.1:%s\n' "$AWG_PANEL_PORT_VALUE"
printf 'If your provider has a cloud firewall, allow inbound UDP %s manually.\n' "$AWG_PORT_VALUE"
