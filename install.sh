#!/bin/sh
set -eu

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '\n==> %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "run this installer as root: sudo ./install.sh"
case "$(uname -m)" in x86_64|amd64) ;; *) die "only linux/amd64 is supported in this release" ;; esac
command -v docker >/dev/null 2>&1 || die "Docker Engine is not installed"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is not installed"
[ -c /dev/net/tun ] || die "/dev/net/tun is unavailable on this VPS"

AWG_HOST_VALUE=${AWG_HOST:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) [ "$#" -ge 2 ] || die "--host requires an IPv4 address or DNS name"; AWG_HOST_VALUE=$2; shift 2 ;;
    --help) printf 'Usage: sudo ./install.sh [--host PUBLIC_IP_OR_DOMAIN]\n'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [ -z "$AWG_HOST_VALUE" ]; then
  AWG_HOST_VALUE=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit } }')
fi
[ -n "$AWG_HOST_VALUE" ] || die "unable to detect the public endpoint; use --host PUBLIC_IP_OR_DOMAIN"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
[ ! -e data/state.json ] || die "AWG-Easy 3 is already initialized in $SCRIPT_DIR/data"

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

info "Building the pinned linux/amd64 image"
docker compose build --pull awg-easy

info "Creating the first Home profile"
docker compose run --rm --no-deps -e AWG_HOST="$AWG_HOST_VALUE" awg-easy init

info "Starting AWG-Easy 3"
docker compose up -d awg-easy

printf '\nInstallation complete.\n'
printf 'AWG endpoint: %s:51820/udp\n' "$AWG_HOST_VALUE"
printf 'The panel has no public TCP listener. Connect the first Home profile, then open http://10.8.0.1:51821\n'
printf 'If your provider has a cloud firewall, allow inbound UDP 51820 manually.\n'
