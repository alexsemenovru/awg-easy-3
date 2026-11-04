#!/bin/sh
set -eu

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die 'run as root'
[ "$(uname -s)" = Linux ] || die 'Cell requires Linux'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"
[ -r "$script_dir/lib/owned-rp-filter.sh" ] || die 'owned interface sysctl helper is missing'
# shellcheck disable=SC1091
. "$script_dir/lib/owned-rp-filter.sh"
[ -r "$script_dir/lib/selinux-socket-watch.sh" ] || die 'SELinux compatibility helper is missing'
. "$script_dir/lib/selinux-socket-watch.sh"
[ -f docker-compose.cells-cell.yml ] || die 'Cell compose file is missing'
[ ! -e data/state.json ] && [ ! -e .env.cells-main ] \
  || die 'do not install a Cell over an existing Main panel'
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
  || die 'Docker Compose v2 is required'
command -v ip >/dev/null 2>&1 && command -v ss >/dev/null 2>&1 \
  && command -v nft >/dev/null 2>&1 || die 'iproute2 and nftables are required'
[ ! -L cell-data ] || die 'unsafe Cell state symlink'
[ ! -L .env.cells-cell ] || die 'unsafe Cell installation record symlink'
if docker inspect awg-easy-3 >/dev/null 2>&1 \
  || docker inspect awg-easy-3-main-cell >/dev/null 2>&1; then
  die 'an AWG-Easy Main panel already exists on this host'
fi
if docker inspect awg-easy-3-cell >/dev/null 2>&1; then
  die 'legacy Cell container exists; inspect and migrate it before installation'
fi

env_file="$script_dir/.env.cells-cell"
cell_public_endpoint() {
  candidate=${AWG_CELL_ENDPOINT:-}
  if [ -z "$candidate" ]; then
    candidate=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{
      for (i=1; i<=NF; i++) if ($i=="src") { print $(i+1); exit }
    }')
    case "$candidate" in
      ''|10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
        die 'cannot detect a public Cell endpoint; set AWG_CELL_ENDPOINT to the VPS public IP or DNS name' ;;
    esac
  fi
  case "$candidate" in
    *[!A-Za-z0-9.:-]*|'') die 'unsafe Cell endpoint' ;;
  esac
  [ "${#candidate}" -le 253 ] || die 'Cell endpoint is too long'
  printf '%s\n' "$candidate"
}
if [ ! -e "$env_file" ]; then
  [ ! -e cell-data ] || die 'Cell state exists without an installation record; inspect it first'
  if docker inspect network-relay >/dev/null 2>&1; then
    die 'Cell container exists without an installation record'
  fi
  [ "${AWG_IMAGE+x}" = x ] && [ -n "$AWG_IMAGE" ] \
    || die 'set AWG_IMAGE to the tested Cell-capable image before installation'
  case "$AWG_IMAGE" in -*|*[!A-Za-z0-9_./:@-]*|'') die 'unsafe Cell image reference' ;; esac
  docker image inspect "$AWG_IMAGE" >/dev/null 2>&1 \
    || die 'Cell image is not available locally; pull or load the tested image first'
  docker run --rm --entrypoint test "$AWG_IMAGE" -r /app/cell-cli.js >/dev/null 2>&1 \
    || die 'image does not contain the Cell service'
  docker run --rm --entrypoint test "$AWG_IMAGE" -r /app/link-agent.js >/dev/null 2>&1 \
    || die 'image does not contain the neutral Cell entrypoint'
  docker run --rm --entrypoint node "$AWG_IMAGE" -e \
    "if(typeof require('/app/lib/CellUserBootstrap').ensureCellUserBootstrap!=='function')process.exit(1)" >/dev/null 2>&1 \
    || die 'image does not contain automatic Cell user bootstrap'
  image=$(docker image inspect -f '{{.Id}}' "$AWG_IMAGE") || die 'cannot pin Cell image'
  case "$image" in sha256:*) image_hash=${image#sha256:} ;;
    *) die 'invalid Cell image ID' ;;
  esac
  [ "${#image_hash}" -eq 64 ] || die 'invalid Cell image ID length'
  case "$image_hash" in *[!0-9a-f]*) die 'invalid Cell image ID' ;; esac
  for name in awgcellb0 awgcellc0 awgcellu0; do
    ip link show dev "$name" >/dev/null 2>&1 && die "interface $name is in use"
  done
  for table in awg_easy_3_bootstrap awg_easy_3_bootstrap_guard \
    awg_easy_3_control awg_easy_3_control_guard awg_easy_3 awg_easy_3_cell_guard; do
    nft list table inet "$table" >/dev/null 2>&1 && die "nftables table $table is in use"
  done
  wan_interface=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{
    for (i=1; i<=NF; i++) if ($i=="dev") { print $(i+1); exit }
  }')
  case "$wan_interface" in ''|*[!A-Za-z0-9_.-]*) die 'cannot detect a safe WAN interface' ;; esac
  [ "${#wan_interface}" -le 15 ] || die 'WAN interface name is too long'
  case "$wan_interface" in lo|awgcellb0|awgcellc0|awgcellu0) die 'WAN interface is not suitable for Cell traffic' ;; esac
  cell_endpoint=$(cell_public_endpoint)
  user_port=51830
  while [ "$user_port" -le 60000 ]; do
    sockets=$(ss -H -lun) || die 'cannot inspect UDP listeners'
    if ! printf '%s\n' "$sockets" | grep -Eq ":${user_port}[[:space:]]"; then break; fi
    user_port=$((user_port + 1))
  done
  [ "$user_port" -le 60000 ] || die 'no free Cell UDP port'
  umask 077
  temporary=$(mktemp "$script_dir/.env.cells-cell.XXXXXX") || die 'cannot create installation record'
  trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
  {
    printf 'AWG_IMAGE=%s\n' "$image"
    printf 'AWG_CELL_WAN_INTERFACE=%s\n' "$wan_interface"
    printf 'AWG_CELL_USER_PORT=%s\n' "$user_port"
    printf 'AWG_CELL_ENDPOINT=%s\n' "$cell_endpoint"
  } > "$temporary"
  ln "$temporary" "$env_file" || die 'Cell installation record was created concurrently'
  rm -f -- "$temporary"
  trap - EXIT HUP INT TERM
  install -d -m 0700 cell-data
else
  [ -f "$env_file" ] && [ "$(stat -c %u "$env_file")" = 0 ] \
    && [ "$(stat -c %a "$env_file")" = 600 ] \
    && [ "$(stat -c %h "$env_file")" = 1 ] \
    || die 'Cell installation record must be root-owned, private and unlinked'
  [ -d cell-data ] || die 'Cell state directory is missing'
  if ! grep -q '^AWG_CELL_ENDPOINT=' "$env_file"; then
    cell_endpoint=$(cell_public_endpoint)
    temporary=$(mktemp "$script_dir/.env.cells-cell.XXXXXX") \
      || die 'cannot update Cell installation record'
    trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
    cat "$env_file" > "$temporary"
    printf 'AWG_CELL_ENDPOINT=%s\n' "$cell_endpoint" >> "$temporary"
    mv -f -- "$temporary" "$env_file"
    trap - EXIT HUP INT TERM
  fi
fi

if [ ! -e cell-data/connection.json ] && [ ! -e cell-data/invitation ]; then
  if [ -t 0 ]; then
    printf 'Paste the one-time Cell invitation code: ' >&2
    old_tty=$(stty -g) || die 'cannot protect terminal input'
    trap 'stty "$old_tty" 2>/dev/null || true' EXIT HUP INT TERM
    stty -echo || die 'cannot hide terminal input'
    if ! IFS= read -r invitation; then die 'Cell invitation was not supplied'; fi
    stty "$old_tty" || die 'cannot restore terminal input'
    trap - EXIT HUP INT TERM
    printf '\n' >&2
  else
    IFS= read -r invitation || die 'Cell invitation was not supplied'
  fi
  [ -n "$invitation" ] && [ "${#invitation}" -le 8192 ] \
    || die 'invalid Cell invitation length'
  case "$invitation" in *[!A-Za-z0-9_-]*) die 'invalid Cell invitation characters' ;; esac
  secret_tmp=$(mktemp "$script_dir/cell-data/.invitation.XXXXXX") \
    || die 'cannot prepare Cell invitation'
  trap 'rm -f -- "$secret_tmp"' EXIT HUP INT TERM
  printf '%s' "$invitation" > "$secret_tmp"
  unset invitation
  ln "$secret_tmp" cell-data/invitation || die 'Cell invitation already exists'
  rm -f -- "$secret_tmp"
  trap - EXIT HUP INT TERM
fi

unset AWG_IMAGE AWG_CELL_WAN_INTERFACE AWG_CELL_USER_PORT AWG_CELL_ENDPOINT
compose() { docker compose --env-file "$env_file" -f docker-compose.cells-cell.yml "$@"; }
compose config --quiet || die 'Cell compose configuration is invalid'
awg_cells_install_rp_filter cell awgcellb0 awgcellc0 awgcellu0 awgdata0 \
  || die 'cannot reserve loose rp_filter for Cell-owned AWG interfaces'
info 'Starting the headless Cell; the invitation is never printed'
awg_easy_install_selinux_socket_watch || die 'cannot install the AWG UAPI SELinux permission'
[ -r "$script_dir/lib/firewalld.sh" ] || die 'firewalld compatibility helper is missing'
. "$script_dir/lib/firewalld.sh"
awg_easy_configure_firewalld "$(sed -n 's/^AWG_CELL_WAN_INTERFACE=//p' "$env_file")" \
  "$(sed -n 's/^AWG_CELL_USER_PORT=//p' "$env_file")" awgcellb0 awgcellc0 awgcellu0 awgdata0 \
  || die 'cannot configure firewalld for the reserved Cell interfaces'
compose up -d cell || die 'Cell service did not start; private state was preserved'
attempt=0
while [ "$attempt" -lt 120 ]; do
  if docker inspect -f '{{.State.Running}}' network-relay 2>/dev/null | grep -qx true; then
    status=$(compose exec -T cell node /app/cell-cli.js status 2>/dev/null || true)
    case "$status" in
      *'"registration":"registered"'*'"userConfigured":true'*)
        info 'Cell registered; awaiting or applying signed settings from the Main Node'
        printf 'Allow inbound UDP %s in the provider firewall for future clients.\n' \
          "$(sed -n 's/^AWG_CELL_USER_PORT=//p' "$env_file")"
        exit 0 ;;
    esac
  fi
  attempt=$((attempt + 1))
  sleep 1
done
die 'Cell did not become ready in time; state was preserved for diagnosis/resume'
