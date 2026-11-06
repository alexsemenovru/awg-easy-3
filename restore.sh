#!/bin/sh
set -eu
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die 'run as root'
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"
. "$project_dir/lib/auto-update.sh"
awg_easy_acquire_update_lock || die 'another installation/update/restore operation is active'
trap 'awg_easy_update_cleanup' 0
trap 'exit 1' HUP INT TERM
image=$(docker inspect -f '{{.Image}}' awg-easy-3) || die 'cannot inspect the destination panel image'
case "$image" in sha256:*) ;; *) die 'a pinned destination image is required' ;; esac
unset AWG_IMAGE AWG_HOST AWG_PORT AWG_PANEL_PORT AWG_MAIN_USER_INTERFACE AWG_MAIN_USER_PORT \
  AWG_MAIN_BOOTSTRAP_INTERFACE AWG_MAIN_CONTROL_INTERFACE AWG_MAIN_BOOTSTRAP_PORT \
  AWG_MAIN_CONTROL_PORT AWG_MAIN_REGISTRATION_PORT AWG_MAIN_CONTROL_TCP_PORT \
  AWG_MAIN_BOOTSTRAP_ADDRESS AWG_MAIN_CONTROL_ADDRESS AWG_MAIN_ENDPOINT AWG_MAIN_DHT_PORT
tool() {
  mode=$1
  shift
  if [ "$mode" = prepare ]; then
    docker run --rm --network host --cap-add NET_ADMIN --read-only --tmpfs /tmp:mode=1777,size=32m \
      --security-opt no-new-privileges:true \
      -v "$project_dir:/restore:z" -v "$archive:/input/archive:ro,z" -v "$key_file:/input/key:ro,z" \
      --entrypoint node "$image" /app/installation-restore-cli.js prepare /restore /input/archive /input/key "$image"
  else
    docker run --rm --network host --cap-add NET_ADMIN --read-only --tmpfs /tmp:mode=1777,size=32m \
      --security-opt no-new-privileges:true -v "$project_dir:/restore:z" \
      --entrypoint node "$image" /app/installation-restore-cli.js "$mode" /restore
  fi
}
compose() {
  if [ -f .env.cells-main ]; then
    docker compose --project-directory "$project_dir" --env-file .env.cells-main \
      -f docker-compose.yml -f docker-compose.cells-main.yml --profile cells-main "$@"
  else
    docker compose --project-directory "$project_dir" -f docker-compose.yml "$@"
  fi
}
case "${1:-}" in
  --resume) [ "$#" -eq 1 ] || die 'use restore --resume' ;;
  --rollback)
    [ "$#" -eq 1 ] || die 'use restore --rollback'
    # The Node journal rejects rollback before any containers are stopped if
    # startup/takeover may already have happened.
    phase=$(tool status) || die 'cannot read restore state'
    case "$phase" in *'"phase":"prepared"'*|*'"phase":"switching"'*|*'"phase":"committed"'*|*'"phase":"rolling-back"'*) ;;
      *) die 'rollback is unavailable after restored service startup' ;; esac
    compose stop || die 'cannot stop destination services'
    tool rollback || die 'rollback interrupted; original data is retained'
    compose up -d --no-deps awg-easy
    exit
    ;;
  *)
    [ "$#" -eq 2 ] || die 'use restore ARCHIVE KEY_FILE | --resume | --rollback'
    [ -f data/state.json ] && [ ! -L data ] || die 'an initialized destination panel is required'
    archive=$1 key_file=$2
    case "$archive:$key_file" in /*:/*) ;; *) die 'archive and key paths must be absolute' ;; esac
    [ -f "$archive" ] && [ ! -L "$archive" ] && [ -f "$key_file" ] && [ ! -L "$key_file" ] || die 'regular private archive and key files are required'
    tool prepare || die 'restore preparation failed; the running panel was not stopped'
    ;;
esac
phase=$(tool status) || die 'cannot read restore state'
case "$phase" in
  *'"phase":"complete"'*) printf 'Restore is already complete.\n'; exit ;;
  *'"phase":"rolled-back"'*|*'"phase":"none"'*) die 'no pending restore' ;;
esac
compose stop || die 'cannot stop destination services; restore files are retained'
case "$phase" in
  *'"phase":"prepared"'*|*'"phase":"switching"'*|*'"phase":"committed"'*)
    tool commit || die 'restore switching interrupted; use restore --resume or --rollback'
    tool start || die 'cannot persist restore startup boundary'
    ;;
  *'"phase":"starting"'*) ;;
  *) die 'restore requires rollback recovery' ;;
esac
# From this point a Cell can pin the new authority. Retrying this installation
# is safe; reverting an old filesystem snapshot is NOT an automatic recovery.
compose up -d --no-deps awg-easy || die 'restored panel did not start; use restore --resume'
awg_easy_wait_healthy || die 'restored panel is not healthy; data is retained, use restore --resume'
if [ -f .env.cells-main ]; then
  "$project_dir/enable-main-node.sh" || die 'restored Main requires attention; use restore --resume'
fi
tool complete || die 'services started but completion record needs restore --resume'
printf 'Restore complete. Previous destination data is retained privately under .restore/.\n'
