#!/bin/sh
set -eu

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '\n==> %s\n' "$*"; }
valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
# Port selection runs inside command substitution, where stdout is captured and
# is therefore not a TTY. Stdin remains the authoritative interaction signal.
is_interactive() { [ -t 0 ]; }
has_command() { command -v "$1" >/dev/null 2>&1; }

AWG_HOST_VALUE=${AWG_HOST:-}
AWG_PORT_VALUE=${AWG_PORT:-51820}
AWG_PANEL_PORT_VALUE=${AWG_PANEL_PORT:-51821}
AWG_LANG_VALUE=${AWG_LANG:-en}
AWG_PORT_EXPLICIT=0
AWG_PANEL_PORT_EXPLICIT=0
[ "${AWG_PORT+x}" = x ] && AWG_PORT_EXPLICIT=1
[ "${AWG_PANEL_PORT+x}" = x ] && AWG_PANEL_PORT_EXPLICIT=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) [ "$#" -ge 2 ] || die "--host requires an IPv4 address or DNS name"; AWG_HOST_VALUE=$2; shift 2 ;;
    --port) [ "$#" -ge 2 ] || die "--port requires a UDP port"; AWG_PORT_VALUE=$2; AWG_PORT_EXPLICIT=1; shift 2 ;;
    --panel-port) [ "$#" -ge 2 ] || die "--panel-port requires a TCP port"; AWG_PANEL_PORT_VALUE=$2; AWG_PANEL_PORT_EXPLICIT=1; shift 2 ;;
    --lang) [ "$#" -ge 2 ] || die "--lang requires en, ru, fa, es or zh-cn"; AWG_LANG_VALUE=$2; shift 2 ;;
    --help)
      printf 'Usage: sudo ./install.sh [--host HOST] [--port UDP_PORT] [--panel-port TCP_PORT] [--lang en|ru|fa|es|zh-cn]\n'
      printf '\nMissing runtime packages are installed with the system package manager.\n'
      printf 'When a default port is occupied, an interactive terminal suggests a free alternative.\n'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

valid_port "$AWG_PORT_VALUE" || die "--port must be an integer between 1 and 65535"
valid_port "$AWG_PANEL_PORT_VALUE" || die "--panel-port must be an integer between 1 and 65535"
case "$AWG_LANG_VALUE" in en|ru|fa|es|zh-cn) ;; *) die "--lang must be en, ru, fa, es or zh-cn" ;; esac

[ "$(id -u)" -eq 0 ] || die "run this installer as root: sudo ./install.sh"
case "$(uname -m)" in x86_64|amd64) ;; *) die "only linux/amd64 is supported in this release" ;; esac

detect_package_manager() {
  for manager in apt-get dnf yum zypper pacman apk; do
    if has_command "$manager"; then
      printf '%s\n' "$manager"
      return 0
    fi
  done
  return 1
}

confirm_dependency_install() {
  if ! is_interactive; then
    return 0
  fi
  printf 'Required system packages are missing: %s\n' "$1"
  printf 'Install them now? [Y/n]: '
  read -r answer
  case "$answer" in n|N|no|NO|No) return 1 ;; *) return 0 ;; esac
}

apt_compose_package() {
  for package in docker-compose-v2 docker-compose-plugin; do
    if apt-cache show "$package" >/dev/null 2>&1; then
      printf '%s\n' "$package"
      return 0
    fi
  done
  return 1
}

install_runtime_dependencies() {
  need_docker=0
  need_compose=0
  need_iproute=0
  need_nft=0
  has_command docker || need_docker=1
  has_command ip && has_command ss || need_iproute=1
  has_command nft || need_nft=1
  if [ "$need_docker" -eq 0 ]; then
    docker compose version >/dev/null 2>&1 || need_compose=1
  else
    need_compose=1
  fi

  if [ "$need_docker" -eq 0 ] && [ "$need_compose" -eq 0 ] && [ "$need_iproute" -eq 0 ] && [ "$need_nft" -eq 0 ]; then
    return 0
  fi

  manager=$(detect_package_manager) || die "no supported package manager found; install Docker Engine, Docker Compose v2, iproute2 and nftables manually"
  missing=""
  [ "$need_docker" -eq 1 ] && missing="${missing} Docker"
  [ "$need_compose" -eq 1 ] && missing="${missing} Docker-Compose-v2"
  [ "$need_iproute" -eq 1 ] && missing="${missing} iproute2"
  [ "$need_nft" -eq 1 ] && missing="${missing} nftables"
  confirm_dependency_install "$missing" || die "required package installation was declined"

  info "Installing missing runtime packages with $manager"
  case "$manager" in
    apt-get)
      apt-get update
      packages=""
      [ "$need_docker" -eq 1 ] && packages="$packages docker.io"
      [ "$need_iproute" -eq 1 ] && packages="$packages iproute2"
      [ "$need_nft" -eq 1 ] && packages="$packages nftables"
      if [ "$need_compose" -eq 1 ]; then
        compose_package=$(apt_compose_package) || die "Docker Compose v2 package is unavailable in the configured APT repositories"
        packages="$packages $compose_package"
      fi
      # Package names above are fixed by this script; intentional word splitting.
      DEBIAN_FRONTEND=noninteractive apt-get install -y $packages
      ;;
    dnf|yum)
      packages=""
      [ "$need_docker" -eq 1 ] && packages="$packages docker"
      [ "$need_compose" -eq 1 ] && packages="$packages docker-compose-plugin"
      [ "$need_iproute" -eq 1 ] && packages="$packages iproute"
      [ "$need_nft" -eq 1 ] && packages="$packages nftables"
      "$manager" install -y $packages
      ;;
    zypper)
      packages=""
      [ "$need_docker" -eq 1 ] && packages="$packages docker"
      [ "$need_compose" -eq 1 ] && packages="$packages docker-compose"
      [ "$need_iproute" -eq 1 ] && packages="$packages iproute2"
      [ "$need_nft" -eq 1 ] && packages="$packages nftables"
      zypper --non-interactive install $packages
      ;;
    pacman)
      packages=""
      [ "$need_docker" -eq 1 ] && packages="$packages docker"
      [ "$need_compose" -eq 1 ] && packages="$packages docker-compose"
      [ "$need_iproute" -eq 1 ] && packages="$packages iproute2"
      [ "$need_nft" -eq 1 ] && packages="$packages nftables"
      pacman --noconfirm -Sy --needed $packages
      ;;
    apk)
      packages=""
      [ "$need_docker" -eq 1 ] && packages="$packages docker"
      [ "$need_compose" -eq 1 ] && packages="$packages docker-cli-compose"
      [ "$need_iproute" -eq 1 ] && packages="$packages iproute2"
      [ "$need_nft" -eq 1 ] && packages="$packages nftables"
      apk add $packages
      ;;
  esac
}

start_docker_daemon() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  info "Starting Docker Engine"
  if has_command systemctl; then
    systemctl enable --now docker
  elif has_command rc-service; then
    rc-update add docker default >/dev/null 2>&1 || true
    rc-service docker start
  elif has_command service; then
    service docker start
  else
    die "Docker Engine is installed but its daemon is not running; start it and rerun the installer"
  fi
  docker info >/dev/null 2>&1 || die "Docker daemon did not become available"
}

install_runtime_dependencies
has_command docker || die "Docker Engine installation did not provide the docker command"
start_docker_daemon
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 installation did not provide 'docker compose'"
has_command ip || die "iproute2 installation did not provide the ip command"
has_command ss || die "iproute2 installation did not provide the ss command"
has_command nft || die "nftables installation did not provide the nft command"

if [ ! -c /dev/net/tun ]; then
  has_command modprobe && modprobe tun >/dev/null 2>&1 || true
fi
[ -c /dev/net/tun ] || die "/dev/net/tun is unavailable on this VPS"

if [ -z "$AWG_HOST_VALUE" ]; then
  AWG_HOST_VALUE=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit } }')
fi
[ -n "$AWG_HOST_VALUE" ] || die "unable to detect the public endpoint; use --host PUBLIC_IP_OR_DOMAIN"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
[ ! -e data/state.json ] || die "AWG-Easy 3 is already initialized in $SCRIPT_DIR/data"

port_in_use() {
  protocol=$1
  port=$2
  case "$protocol" in
    udp) ss -H -lun "sport = :$port" | grep -q . ;;
    tcp) ss -H -ltn "sport = :$port" | grep -q . ;;
    *) return 1 ;;
  esac
}

next_free_port() {
  protocol=$1
  candidate=$2
  while [ "$candidate" -le 65535 ]; do
    if ! port_in_use "$protocol" "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  candidate=1024
  while [ "$candidate" -lt "$2" ]; do
    if ! port_in_use "$protocol" "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  return 1
}

choose_available_port() {
  protocol=$1
  current=$2
  explicit=$3
  label=$4
  if ! port_in_use "$protocol" "$current"; then
    printf '%s\n' "$current"
    return 0
  fi
  suggestion=$(next_free_port "$protocol" "$((current + 1))") || die "no free $protocol port could be found"
  if [ "$explicit" -eq 1 ]; then
    die "$label port $current is already in use; choose another value (for example $suggestion)"
  fi
  if ! is_interactive; then
    if [ "$protocol" = udp ]; then option=port; else option=panel-port; fi
    die "$label port $current is already in use; rerun with --$option $suggestion"
  fi
  while :; do
    printf '%s port %s is already in use. Enter another port [%s]: ' "$label" "$current" "$suggestion" >&2
    read -r selected
    [ -n "$selected" ] || selected=$suggestion
    if ! valid_port "$selected"; then
      printf 'Port must be an integer between 1 and 65535.\n' >&2
      continue
    fi
    if port_in_use "$protocol" "$selected"; then
      printf '%s port %s is also in use.\n' "$label" "$selected" >&2
      continue
    fi
    printf '%s\n' "$selected"
    return 0
  done
}

info "Checking interface, subnet, ports and owned object names"
if ip link show dev awg0 >/dev/null 2>&1; then
  die "network interface awg0 already exists; remove or rename the conflicting VPN interface before installation"
fi
if ip -4 route show exact 10.8.0.0/24 | grep -q .; then
  die "VPN subnet 10.8.0.0/24 conflicts with an existing route"
fi
if docker container inspect awg-easy-3 >/dev/null 2>&1; then
  die "Docker container name awg-easy-3 is already in use; the installer will not remove an existing container"
fi
if nft list table inet awg_easy_3 >/dev/null 2>&1; then
  die "nftables table inet awg_easy_3 already exists; the installer will not overwrite an unowned or stale table"
fi

AWG_PORT_VALUE=$(choose_available_port udp "$AWG_PORT_VALUE" "$AWG_PORT_EXPLICIT" "AWG UDP")
AWG_PANEL_PORT_VALUE=$(choose_available_port tcp "$AWG_PANEL_PORT_VALUE" "$AWG_PANEL_PORT_EXPLICIT" "Panel TCP")

export AWG_HOST="$AWG_HOST_VALUE"
export AWG_PORT="$AWG_PORT_VALUE"
export AWG_PANEL_PORT="$AWG_PANEL_PORT_VALUE"
export AWG_LANG="$AWG_LANG_VALUE"

info "Pulling the pinned linux/amd64 image"
docker compose pull awg-easy

info "Enabling IPv4/IPv6 forwarding"
umask 077
cat > /etc/sysctl.d/99-awg-easy-3.conf <<'EOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
EOF
chmod 0644 /etc/sysctl.d/99-awg-easy-3.conf
sysctl --system >/dev/null

install -d -m 0700 data

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
