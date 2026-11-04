#!/bin/sh
set -eu

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] || die 'run as root'
[ "$(uname -s)" = Linux ] || die 'Main Node requires Linux'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"
[ -r "$script_dir/lib/owned-rp-filter.sh" ] || die 'owned interface sysctl helper is missing'
# shellcheck disable=SC1091
. "$script_dir/lib/owned-rp-filter.sh"
[ -r "$script_dir/lib/selinux-socket-watch.sh" ] || die 'SELinux compatibility helper is missing'
. "$script_dir/lib/selinux-socket-watch.sh"
[ -f docker-compose.yml ] && [ -f docker-compose.cells-main.yml ] \
  || die 'Main Node compose assets are missing'
[ -f data/state.json ] || die 'an existing AWG-Easy 3 panel is required'
has docker && docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
has ip && has ss && has nft || die 'iproute2 and nftables are required'
docker inspect -f '{{.State.Running}}' awg-easy-3 2>/dev/null | grep -qx true \
  || die 'the existing panel must be running'
docker compose exec -T awg-easy test -r /app/main-cell-install-info.js >/dev/null 2>&1 \
  || die 'the running panel image does not contain Main Node support'

env_file="$script_dir/.env.cells-main"
if [ ! -e "$env_file" ] && [ ! -L "$env_file" ]; then
  [ ! -e "$script_dir/cell-data" ] && [ ! -L "$script_dir/cell-data" ] \
    || die 'Cell state already exists without an installation record; inspect it before enabling'
  [ ! -e "$script_dir/cell-status" ] && [ ! -L "$script_dir/cell-status" ] \
    || die 'Cell status directory already exists without an installation record'
  metadata=$(docker compose exec -T awg-easy node /app/main-cell-install-info.js) \
    || die 'cannot read validated panel settings'
  # The image emits exactly four whitespace-free validated tokens.
  set -- $metadata
  [ "$#" -eq 4 ] || die 'unexpected panel settings format'
  user_interface=$1
  user_port=$2
  panel_port=$3
  endpoint=$4
  case "$user_interface" in ''|*[!A-Za-z0-9_.-]*) die 'unsafe panel interface' ;; esac
  case "$user_port:$panel_port" in *[!0-9:]*) die 'unsafe panel ports' ;; esac
  case "$endpoint" in ''|*[!A-Za-z0-9.:-]*) die 'unsafe panel endpoint' ;; esac

  for name in awgmainb0 awgmainc0; do
    if ip link show dev "$name" >/dev/null 2>&1; then
      die "network interface $name is already in use"
    fi
  done
  for table in awg_easy_3_bootstrap awg_easy_3_bootstrap_guard \
    awg_easy_3_control awg_easy_3_control_guard; do
    if nft list table inet "$table" >/dev/null 2>&1; then
      die "nftables table $table is already in use"
    fi
  done
  for subnet in 10.90.8.0/24 10.91.8.0/24; do
    if ip -4 route show exact "$subnet" | grep -q .; then
      die "private subnet $subnet conflicts with an existing route"
    fi
  done

  free_port() {
    protocol=$1
    candidate=$2
    while [ "$candidate" -le 60000 ]; do
      if { [ "$protocol" = udp ] && [ "$candidate" = "$user_port" ]; } \
        || { [ "$protocol" = tcp ] && [ "$candidate" = "$panel_port" ]; }; then
        candidate=$((candidate + 1))
        continue
      fi
      case "$protocol" in
        udp) sockets=$(ss -H -lun) || return 1 ;;
        tcp) sockets=$(ss -H -tln) || return 1 ;;
      esac
      if ! printf '%s\n' "$sockets" | grep -Eq ":${candidate}[[:space:]]"; then
        printf '%s\n' "$candidate"
        return 0
      fi
      candidate=$((candidate + 1))
    done
    return 1
  }
  bootstrap_port=$(free_port udp 53081) || die 'no free bootstrap UDP port'
  control_port=$(free_port udp "$((bootstrap_port + 1))") || die 'no free control UDP port'
  registration_port=$(free_port tcp 53082) || die 'no free registration TCP port'
  control_tcp_port=$(free_port tcp "$((registration_port + 1))") \
    || die 'no free control TCP port'
  [ "$user_port" != "$bootstrap_port" ] && [ "$user_port" != "$control_port" ] \
    || die 'selected Main UDP port overlaps the panel UDP port'
  [ "$panel_port" != "$registration_port" ] && [ "$panel_port" != "$control_tcp_port" ] \
    || die 'selected Main TCP port overlaps the panel TCP port'

  image=$(docker inspect -f '{{.Image}}' awg-easy-3) || die 'cannot inspect panel image'
  case "$image" in sha256:*) image_hash=${image#sha256:} ;;
    *) die 'invalid panel image ID' ;;
  esac
  [ "${#image_hash}" -eq 64 ] || die 'invalid panel image ID length'
  case "$image_hash" in *[!0-9a-f]*) die 'invalid panel image ID' ;; esac
  umask 077
  temporary=$(mktemp "$script_dir/.env.cells-main.XXXXXX") || die 'cannot create installation record'
  trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
  {
    printf 'AWG_IMAGE=%s\n' "$image"
    printf 'AWG_HOST=%s\nAWG_PORT=%s\nAWG_PANEL_PORT=%s\n' "$endpoint" "$user_port" "$panel_port"
    printf 'AWG_MAIN_USER_INTERFACE=%s\nAWG_MAIN_USER_PORT=%s\n' "$user_interface" "$user_port"
    printf 'AWG_MAIN_BOOTSTRAP_INTERFACE=awgmainb0\nAWG_MAIN_CONTROL_INTERFACE=awgmainc0\n'
    printf 'AWG_MAIN_BOOTSTRAP_PORT=%s\nAWG_MAIN_CONTROL_PORT=%s\n' "$bootstrap_port" "$control_port"
    printf 'AWG_MAIN_REGISTRATION_PORT=%s\nAWG_MAIN_CONTROL_TCP_PORT=%s\n' "$registration_port" "$control_tcp_port"
    printf 'AWG_MAIN_BOOTSTRAP_ADDRESS=10.90.8.1\nAWG_MAIN_CONTROL_ADDRESS=10.91.8.1\n'
    printf 'AWG_MAIN_ENDPOINT=%s\n' "$endpoint"
  } > "$temporary"
  ln "$temporary" "$env_file" || die 'installation record was created concurrently'
  rm -f -- "$temporary"
  trap - EXIT HUP INT TERM
else
  [ -f "$env_file" ] && [ ! -L "$env_file" ] \
    || die 'unsafe Main Node installation record'
  [ "$(stat -c %u "$env_file")" = 0 ] \
    && [ "$(stat -c %a "$env_file")" = 600 ] \
    && [ "$(stat -c %h "$env_file")" = 1 ] \
    || die 'Main Node installation record must be root-owned, private and unlinked'
fi

for directory in cell-data cell-status; do
  [ ! -L "$directory" ] || die "unsafe $directory symlink"
  if [ -e "$directory" ]; then
    [ -d "$directory" ] || die "unsafe $directory path"
  fi
done

# Compose must use the saved, checked reservation even if the administrator's
# shell has unrelated AWG_* variables set for another installation.
unset AWG_IMAGE AWG_HOST AWG_PORT AWG_PANEL_PORT AWG_MAIN_USER_INTERFACE \
  AWG_MAIN_USER_PORT AWG_MAIN_BOOTSTRAP_INTERFACE AWG_MAIN_CONTROL_INTERFACE \
  AWG_MAIN_BOOTSTRAP_PORT AWG_MAIN_CONTROL_PORT AWG_MAIN_REGISTRATION_PORT \
  AWG_MAIN_CONTROL_TCP_PORT AWG_MAIN_BOOTSTRAP_ADDRESS AWG_MAIN_CONTROL_ADDRESS \
  AWG_MAIN_ENDPOINT

compose() {
  docker compose --env-file "$env_file" -f docker-compose.yml \
    -f docker-compose.cells-main.yml --profile cells-main "$@"
}
compose config --quiet || die 'Main Node compose configuration is invalid'
set -- awgmainb0 awgmainc0
awg_data_slot=0
while [ "$awg_data_slot" -lt 127 ]; do
  set -- "$@" "awgd${awg_data_slot}"
  awg_data_slot=$((awg_data_slot + 1))
done
awg_cells_install_rp_filter main "$@" \
  || die 'cannot reserve loose rp_filter for Main-owned AWG interfaces'
install -d -m 0700 cell-data cell-status
info 'Starting the Main Node service without changing the running panel'
awg_easy_install_selinux_socket_watch || die 'cannot install the AWG UAPI SELinux permission'
started_at=$(date +%s)
compose up -d --no-deps main-cell || die 'Main Node service could not be started'

attempt=0
while [ "$attempt" -lt 30 ]; do
  if [ -s cell-status/cells.json ] \
    && [ "$(stat -c %Y cell-status/cells.json)" -gt "$started_at" ] \
    && [ -S cell-status/control.sock ] \
    && [ "$(stat -c %a cell-status/control.sock)" = 600 ] \
    && docker inspect -f '{{.State.Running}}' awg-easy-3-main-cell 2>/dev/null | grep -qx true; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$attempt" -eq 30 ]; then
  compose stop main-cell >/dev/null 2>&1 || true
  die 'Main Node did not become ready; the panel was not changed and Cell state was preserved'
fi

info 'Connecting Cell status to the panel (brief panel restart)'
compose up -d --no-deps awg-easy || die 'Main Node is running, but panel status mount failed'
info 'Main Node enabled; existing client profiles were not changed'
bootstrap_udp=$(sed -n 's/^AWG_MAIN_BOOTSTRAP_PORT=//p' "$env_file")
control_udp=$(sed -n 's/^AWG_MAIN_CONTROL_PORT=//p' "$env_file")
printf 'If your provider has a cloud firewall, allow inbound UDP %s and %s for Cells.\n' \
  "$bootstrap_udp" "$control_udp"
printf 'Stable auto-updates are held until coordinated Main/Cell updates are available.\n'
