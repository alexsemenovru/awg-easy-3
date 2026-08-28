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
AWG_PORT_VALUE=${AWG_PORT-}
AWG_PANEL_PORT_VALUE=${AWG_PANEL_PORT:-51821}
AWG_LANG_VALUE=${AWG_LANG:-en}
AWG_PORT_EXPLICIT=0
AWG_PANEL_PORT_EXPLICIT=0
INSTALL_ACTION=install
[ "${AWG_PORT+x}" = x ] && AWG_PORT_EXPLICIT=1
[ "${AWG_PANEL_PORT+x}" = x ] && AWG_PANEL_PORT_EXPLICIT=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) [ "$#" -ge 2 ] || die "--host requires an IPv4 address or DNS name"; AWG_HOST_VALUE=$2; shift 2 ;;
    --port) [ "$#" -ge 2 ] || die "--port requires a UDP port"; AWG_PORT_VALUE=$2; AWG_PORT_EXPLICIT=1; shift 2 ;;
    --panel-port) [ "$#" -ge 2 ] || die "--panel-port requires a TCP port"; AWG_PANEL_PORT_VALUE=$2; AWG_PANEL_PORT_EXPLICIT=1; shift 2 ;;
    --lang) [ "$#" -ge 2 ] || die "--lang requires en, ru, fa, es or zh-cn"; AWG_LANG_VALUE=$2; shift 2 ;;
    --uninstall) [ "$INSTALL_ACTION" = install ] || die "--uninstall and --reinstall cannot be used together"; INSTALL_ACTION=uninstall; shift ;;
    --reinstall) [ "$INSTALL_ACTION" = install ] || die "--uninstall and --reinstall cannot be used together"; INSTALL_ACTION=reinstall; shift ;;
    --help)
      printf 'Usage: sudo ./install.sh [--host HOST] [--port UDP_PORT] [--panel-port TCP_PORT] [--lang en|ru|fa|es|zh-cn]\n'
      printf '       sudo ./install.sh --uninstall\n'
      printf '       sudo ./install.sh --reinstall [installation options]\n'
      printf '\nMissing runtime packages are installed with the system package manager.\n'
      printf 'Without --port or AWG_PORT, a random free UDP port from 20000 to 60000 is chosen.\n'
      printf 'When the default panel TCP port is occupied, an interactive terminal suggests a free alternative.\n'
      printf 'Uninstall and reinstall permanently delete every AWG-Easy 3 client and setting.\n'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [ "$AWG_PORT_EXPLICIT" -eq 1 ]; then
  valid_port "$AWG_PORT_VALUE" || die "--port must be an integer between 1 and 65535"
fi
valid_port "$AWG_PANEL_PORT_VALUE" || die "--panel-port must be an integer between 1 and 65535"
case "$AWG_LANG_VALUE" in en|ru|fa|es|zh-cn) ;; *) die "--lang must be en, ru, fa, es or zh-cn" ;; esac

[ "$(id -u)" -eq 0 ] || die "run this installer as root: sudo ./install.sh"
case "$(uname -s)" in
  Linux) ;;
  FreeBSD|OpenBSD|NetBSD|Darwin)
    die "AWG-Easy 3 currently supports Linux/amd64 only; $(uname -s) is unsupported because this release requires Docker Engine, Linux TUN networking and nftables"
    ;;
  *) die "AWG-Easy 3 currently supports Linux/amd64 only; unsupported kernel: $(uname -s)" ;;
esac
if grep -qiE '(microsoft|wsl)' /proc/sys/kernel/osrelease /proc/version 2>/dev/null; then
  die "WSL is unsupported; install AWG-Easy 3 on a real Linux VPS with native TUN, forwarding and nftables"
fi
case "$(uname -m)" in x86_64|amd64) ;; *) die "only linux/amd64 is supported in this release" ;; esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
EXISTING_INSTALL_DIR=""

detect_existing_installation() {
  if [ -e "$SCRIPT_DIR/data/state.json" ]; then
    EXISTING_INSTALL_DIR=$SCRIPT_DIR
    return 0
  fi
  has_command docker || return 0
  docker container inspect awg-easy-3 >/dev/null 2>&1 || return 0
  service=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' awg-easy-3 2>/dev/null || true)
  project_dir=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' awg-easy-3 2>/dev/null || true)
  [ "$service" = awg-easy ] || return 0
  case "$project_dir" in /*) ;; *) return 0 ;; esac
  [ -f "$project_dir/docker-compose.yml" ] || return 0
  [ -e "$project_dir/data/state.json" ] || return 0
  EXISTING_INSTALL_DIR=$project_dir
}

choose_existing_install_action() {
  detect_existing_installation
  if [ -z "$EXISTING_INSTALL_DIR" ]; then
    if [ "$INSTALL_ACTION" = uninstall ]; then
      printf 'AWG-Easy 3 is not installed in %s. Nothing to remove.\n' "$SCRIPT_DIR"
      exit 0
    fi
    return 0
  fi
  if [ "$INSTALL_ACTION" = reinstall ] || [ "$INSTALL_ACTION" = uninstall ]; then
    return 0
  fi
  if ! is_interactive; then
    die "AWG-Easy 3 is already installed; rerun interactively, with --uninstall, or with --reinstall"
  fi
  printf '\nAWG-Easy 3 is already installed in %s.\n' "$EXISTING_INSTALL_DIR"
  printf '  1) Keep the current installation and exit\n'
  printf '  2) Uninstall and permanently delete all clients and settings\n'
  printf '  3) Reinstall from scratch and permanently delete all clients and settings\n'
  printf 'Choose an action [1]: '
  read -r answer
  case "$answer" in
    ''|1) printf 'The existing installation was left unchanged.\n'; exit 0 ;;
    2) INSTALL_ACTION=uninstall ;;
    3) INSTALL_ACTION=reinstall ;;
    *) die "invalid choice; the existing installation was left unchanged" ;;
  esac
}

confirm_data_removal() {
  if ! is_interactive; then
    return 0
  fi
  while :; do
    printf 'This permanently deletes every AWG-Easy 3 client, key, password and setting. Continue? [y/N]: '
    if ! read -r answer; then
      printf 'Confirmation input was closed; nothing was removed.\n' >&2
      return 1
    fi
    case "$answer" in
      y|Y|yes|YES|Yes|д|Д|да|ДА|Да) return 0 ;;
      ''|n|N|no|NO|No|н|Н|нет|НЕТ|Нет) return 1 ;;
      *) printf 'Please answer y/yes (or д/да) to continue, or n/no (or н/нет) to cancel.\n' >&2 ;;
    esac
  done
}

choose_existing_install_action

detect_package_manager() {
  for manager in apt-get dnf yum zypper pacman apk; do
    if has_command "$manager"; then
      printf '%s\n' "$manager"
      return 0
    fi
  done
  return 1
}

is_nixos() {
  [ -r /etc/os-release ] || return 1
  # os-release is a system-owned file containing simple key/value metadata.
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = nixos ]
}

show_nixos_runtime_instructions() {
  cat >&2 <<'EOF'
Error: NixOS detected. Runtime services must be enabled declaratively.

Create /etc/nixos/awg-easy-3-runtime.nix with:

  { pkgs, ... }:
  {
    virtualisation.docker.enable = true;
    environment.systemPackages = with pkgs; [
      docker-compose
      iproute2
      nftables
    ];
    boot.kernelModules = [ "tun" ];
  }

Then add this line inside the imports list in /etc/nixos/configuration.nix:

    ./awg-easy-3-runtime.nix

Apply the configuration and rerun this installer:

  sudo nixos-rebuild switch --option max-jobs 1 --option cores 1
  cd /opt/awg-easy-3
  sudo ./install.sh --host PUBLIC_IP_OR_DOMAIN --lang en

The installer intentionally does not edit configuration.nix automatically.
The single-job rebuild is intentional for low-memory VPS instances.
EOF
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

  if is_nixos; then
    show_nixos_runtime_instructions
    exit 1
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

remove_existing_installation() {
  confirm_data_removal || die "removal cancelled; the existing installation was left unchanged"
  info "Stopping only the AWG-Easy 3 Compose service"
  docker compose --project-directory "$EXISTING_INSTALL_DIR" -f "$EXISTING_INSTALL_DIR/docker-compose.yml" down --remove-orphans
  if ip link show dev awg0 >/dev/null 2>&1; then
    info "Removing the residual owned AWG interface"
    ip link delete dev awg0 || die "failed to remove the owned AWG interface; settings were preserved"
  fi
  if nft list table inet awg_easy_3 >/dev/null 2>&1; then
    info "Removing the residual owned nftables table"
    nft delete table inet awg_easy_3 || die "failed to remove the owned nftables table; settings were preserved"
  fi
  for family in ip ip6; do
    chain=$(nft -a list chain "$family" filter DOCKER-USER 2>/dev/null || true)
    for marker in awg_easy_3_forward_v4 awg_easy_3_return_v4 awg_easy_3_forward_v6 awg_easy_3_return_v6; do
      handles=$(printf '%s\n' "$chain" | awk -v marker="$marker" '
        index($0, "comment \"" marker "\"") {
          for (field = 1; field <= NF; field += 1) if ($field == "handle") print $(field + 1)
        }
      ')
      for handle in $handles; do
        nft delete rule "$family" filter DOCKER-USER handle "$handle" \
          || die "failed to remove an owned Docker compatibility rule; settings were preserved"
      done
    done
  done
  if ip link show dev awg0 >/dev/null 2>&1; then
    die "AWG interface awg0 is still active; settings were preserved so it can be inspected safely"
  fi
  if nft list table inet awg_easy_3 >/dev/null 2>&1; then
    die "owned nftables table inet awg_easy_3 is still active; settings were preserved so it can be inspected safely"
  fi
  case "$EXISTING_INSTALL_DIR" in /|'' ) die "refusing to remove data from an unsafe project path" ;; esac
  rm -rf -- "$EXISTING_INSTALL_DIR/data"
  rm -f -- /etc/sysctl.d/99-awg-easy-3.conf
  rm -f -- /usr/local/sbin/awg-easy-3 /etc/awg-easy-3-install-dir
  info "AWG-Easy 3 clients, settings and service were removed"
  printf 'Host forwarding values were left unchanged to avoid disrupting other VPS services.\n'
}

install_management_command() {
  printf '%s\n' "$SCRIPT_DIR" > /etc/awg-easy-3-install-dir
  chmod 0644 /etc/awg-easy-3-install-dir
  install -m 0755 "$SCRIPT_DIR/awg-easy-3" /usr/local/sbin/awg-easy-3
}

if [ -n "$EXISTING_INSTALL_DIR" ] && { [ "$INSTALL_ACTION" = uninstall ] || [ "$INSTALL_ACTION" = reinstall ]; }; then
  remove_existing_installation
  if [ "$INSTALL_ACTION" = uninstall ]; then
    printf 'Uninstallation complete. The project files remain in %s so the installer can be run again.\n' "$EXISTING_INSTALL_DIR"
    exit 0
  fi
fi

if [ ! -c /dev/net/tun ]; then
  has_command modprobe && modprobe tun >/dev/null 2>&1 || true
fi
[ -c /dev/net/tun ] || die "/dev/net/tun is unavailable on this VPS"

if [ -z "$AWG_HOST_VALUE" ]; then
  AWG_HOST_VALUE=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit } }')
fi
[ -n "$AWG_HOST_VALUE" ] || die "unable to detect the public endpoint; use --host PUBLIC_IP_OR_DOMAIN"

[ ! -e data/state.json ] || die "AWG-Easy 3 is already initialized in $SCRIPT_DIR/data"

port_in_use() {
  protocol=$1
  port=$2
  case "$protocol" in
    udp) listeners=$(ss -H -uan "sport = :$port") || die "unable to inspect UDP sockets" ;;
    tcp) listeners=$(ss -H -ltn "sport = :$port") || die "unable to inspect TCP sockets" ;;
    *) die "unsupported port protocol" ;;
  esac
  [ -z "$listeners" ] || return 0
  # Docker can publish a DNAT port without a docker-proxy listening socket.
  container_ids=$(docker ps -q) || die "unable to inspect Docker port ownership"
  if [ -n "$container_ids" ]; then
    # Docker supplies whitespace-separated hexadecimal IDs, not shell code.
    # shellcheck disable=SC2086
    published_ports=$(docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{printf "%s %s\n" $port .HostPort}}{{end}}{{end}}' $container_ids) \
      || die "unable to inspect Docker published ports"
    if printf '%s\n' "$published_ports" | awk -v port="$port" -v protocol="$protocol" '
      $1 ~ ("/" protocol "$") && $2 == port { found = 1 }
      END { exit !found }
    '; then
      return 0
    else
      inspect_status=$?
      [ "$inspect_status" -eq 1 ] || die "unable to parse Docker published ports"
    fi
  fi
  return 1
}

random_port_candidate() {
  # Rejection sampling avoids modulo bias: 0..40000 maps to 20000..60000.
  # /dev/urandom and od are supplied by Linux/coreutils or BusyBox, no daemon.
  entropy_attempt=0
  while [ "$entropy_attempt" -lt 32 ]; do
    entropy_attempt=$((entropy_attempt + 1))
    random_value=$(od -An -N2 -tu2 /dev/urandom) || die "unable to read random port data; use --port UDP_PORT"
    # Word splitting trims od's padding. Validate before arithmetic.
    # shellcheck disable=SC2086
    set -- $random_value
    [ "$#" -eq 1 ] || die "invalid random port data; use --port UDP_PORT"
    case "$1" in ''|*[!0-9]*) die "invalid random port data; use --port UDP_PORT" ;; esac
    [ "$1" -le 65535 ] || die "invalid random port data; use --port UDP_PORT"
    if [ "$1" -le 40000 ]; then
      printf '%s\n' "$((20000 + $1))"
      return 0
    fi
  done
  die "unable to choose a random port; use --port UDP_PORT"
}

choose_random_udp_port() {
  random_attempt=0
  while [ "$random_attempt" -lt 128 ]; do
    random_attempt=$((random_attempt + 1))
    random_candidate=$(random_port_candidate) || return 1
    # Avoid accidentally selecting the well-known old default.
    [ "$random_candidate" -ne 51820 ] || continue
    if ! port_in_use udp "$random_candidate"; then
      printf '%s\n' "$random_candidate"
      return 0
    fi
  done
  die "could not find a free random UDP port after 128 attempts; use --port UDP_PORT"
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

if [ "$AWG_PORT_EXPLICIT" -eq 0 ]; then
  AWG_PORT_VALUE=$(choose_random_udp_port)
  info "Selected random AWG UDP port: $AWG_PORT_VALUE"
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
install_management_command

printf '\nInstallation complete.\n'
printf 'AWG endpoint: %s:%s/udp\n' "$AWG_HOST_VALUE" "$AWG_PORT_VALUE"
printf 'Panel language: %s\n' "$AWG_LANG_VALUE"
printf 'The panel has no public TCP listener. Connect the first Home profile, then open http://10.8.0.1:%s\n' "$AWG_PANEL_PORT_VALUE"
printf 'If your provider has a cloud firewall, allow inbound UDP %s manually.\n' "$AWG_PORT_VALUE"
printf 'Run sudo awg-easy-3 from any directory to manage, uninstall or reinstall the panel.\n'
