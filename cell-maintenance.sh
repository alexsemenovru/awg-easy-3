#!/bin/sh
# Root-only supervisor. No Docker socket or host maintenance directory is
# mounted in the ordinary Cell container. Network commands are never evaluated.
set -eu
die() { printf 'Network maintenance pending: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die 'root required'
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"
env_file=$project_dir/.env.cells-cell
host_dir=$project_dir/.cell-maintenance
state_dir=$project_dir/cell-data
private_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ] \
    && [ "$(stat -c %a "$1")" = 600 ] && [ "$(stat -c %h "$1")" = 1 ]
}
private_file "$env_file" || die 'unsafe installation record'
for directory in "$host_dir" "$state_dir"; do
  [ -d "$directory" ] && [ ! -L "$directory" ] && [ "$(stat -c %u "$directory")" = 0 ] \
    && [ "$(stat -c %a "$directory")" = 700 ] || die 'unsafe state directory'
done
request=$state_dir/maintenance/request.json
if [ "${1:-}" != --init ]; then
  [ -f "$request" ] || exit 0
  private_file "$request" && [ "$(stat -c %s "$request")" -le 16384 ] || die 'unsafe request'
  fingerprint=$(sha256sum "$request" | cut -d ' ' -f 1)
  if private_file "$host_dir/completed" && [ "$(cat "$host_dir/completed")" = "$fingerprint" ]; then exit 0; fi
fi
. "$project_dir/lib/auto-update.sh"
awg_easy_acquire_update_lock || exit 0
trap awg_easy_update_cleanup 0
trap 'exit 1' HUP INT TERM
docker info >/dev/null 2>&1 || die 'Docker is unavailable'
image=$(sed -n 's/^AWG_IMAGE=//p' "$env_file")
printf '%s\n' "$image" | grep -Eq '^sha256:[a-f0-9]{64}$' || die 'unpinned installed image'
bootstrap_name=$(sed -n 's/^AWG_CELL_BOOTSTRAP_INTERFACE=//p' "$env_file")
control_name=$(sed -n 's/^AWG_CELL_CONTROL_INTERFACE=//p' "$env_file")
user_name=$(sed -n 's/^AWG_CELL_USER_INTERFACE=//p' "$env_file")
runtime_dir=$(sed -n 's/^AWG_CELL_RUNTIME_DIR=//p' "$env_file")
bootstrap_name=${bootstrap_name:-awgcellb0} control_name=${control_name:-awgcellc0} user_name=${user_name:-awgcellu0}
runtime_dir=${runtime_dir:-/cell-data/runtime}
helper() {
  mode=$1; shift
  case "$mode" in readonly) mount_mode=ro ;; rw) mount_mode=rw ;; *) return 1 ;; esac
  docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 96 --memory 192m --cpu-shares 128 --tmpfs /run:rw,nosuid,nodev,size=16m,mode=700 \
    --tmpfs /tmp:rw,nosuid,nodev,size=32m,mode=1777 --env-file "$env_file" \
    -e AWG_PRIVATE_STATE=1 -e AWG_CELL_STATE_DIR=/cell-data \
    -e "AWG_CELL_RUNTIME_DIR=$runtime_dir" -e "AWG_CELL_BOOTSTRAP_INTERFACE=$bootstrap_name" \
    -e "AWG_CELL_CONTROL_INTERFACE=$control_name" -e "AWG_CELL_USER_INTERFACE=$user_name" \
    -e "MAINTENANCE_CONTAINER_ID=${new_id:-}" -e "MAINTENANCE_IMAGE_ID=${new_image:-}" \
    --volume "$state_dir:/cell-data:$mount_mode,z" \
    --volume "$host_dir:/maintenance-host:Z" \
    "$@" --entrypoint node "$image" /app/maintenance-cli.js "$action"
}
if [ "${1:-}" = --init ]; then
  new_id=$(docker inspect -f '{{.Id}}' network-relay)
  new_image=$(docker inspect -f '{{.Image}}' "$new_id")
  [ "$new_image" = "$image" ] || die 'installed container image differs'
  action=init; helper readonly
  exit 0
fi
action=check
status=$(helper readonly) || die 'request verification failed'
[ -n "$status" ] || exit 0
phase=$(printf '%s\n' "$status" | sed -n '1p')
command_id=$(printf '%s\n' "$status" | sed -n '2p')
operation=$(printf '%s\n' "$status" | sed -n '3p')
target=$(printf '%s\n' "$status" | sed -n '4p')
container_id=$(printf '%s\n' "$status" | sed -n '5p')
owned_image=$(printf '%s\n' "$status" | sed -n '6p')
replacement_image=$(printf '%s\n' "$status" | sed -n '7p')
requested_id=$(printf '%s\n' "$status" | sed -n '8p')
case "$operation:$phase" in update:queued|update:complete|remove:queued|remove:stopped|remove:resources-removed|remove:container-removed|remove:complete) ;; *) die 'invalid operation' ;; esac
if [ "$phase" = complete ]; then
  if [ "$command_id" = "$requested_id" ]; then
    umask 077; printf '%s\n' "$fingerprint" > "$host_dir/completed"
  fi
  exit 0
fi
compose() { docker compose --project-directory "$project_dir" --env-file "$env_file" -f "$project_dir/docker-compose.cells-cell.yml" "$@"; }
owned_present=false
if docker inspect "$container_id" >/dev/null 2>&1; then
  [ "$(docker inspect -f '{{.Image}}' "$container_id")" = "$owned_image" ] || die 'owned container image changed'
  owned_present=true
fi
if [ "$operation" = update ]; then
  if [ "$owned_present" = false ]; then
    # The old ID may disappear only after Root durably pinned this replacement.
    [ "$replacement_image" != - ] || die 'owned container disappeared without a replacement intent'
    current_image=$(docker inspect -f '{{.Image}}' network-relay) || die 'replacement container unavailable'
    [ "$current_image" = "$replacement_image" ] || die 'foreign container occupies the Cell name'
    [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/cell-data"}}{{.Source}}:{{.RW}}{{end}}{{end}}' network-relay)" = "$state_dir:true" ] || die 'replacement has a different state mount'
    if [ "$(docker inspect -f '{{.State.Running}}:{{.State.ExitCode}}' network-relay)" = false:0 ]; then exit 0; fi
  fi

  # A manually stopped Cell is not started by the automatic updater.
  if [ "$owned_present" = true ] && [ "$(docker inspect -f '{{.State.Running}}' "$container_id")" != true ]; then exit 0; fi
  installed=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node "$owned_image" -p "require('/app/package.json').version")
  awg_easy_semver_is_newer "$target" "$installed" || die 'only a newer Cell version may be installed'
  [ "$replacement_image" != - ] || [ "$(awg_easy_latest_stable_version)" = "$target" ] || die 'Main version is not the latest stable release'
  reference=ghcr.io/alexsemenovru/awg-easy-3:$target
  timeout 300 docker pull "$reference" >/dev/null || die 'image download failed'
  candidate=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$reference" | grep '^ghcr.io/alexsemenovru/awg-easy-3@sha256:')
  revision=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$reference")
  awg_easy_verify_candidate_image "$target" "$revision" "$candidate" || die 'image signature rejected'
  new_image=$(docker image inspect -f '{{.Id}}' "$candidate")
  reported=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node "$new_image" -p "require('/app/package.json').version")
  [ "$reported" = "$target" ] || die 'signed package version differs'
  action=plan-replacement
  helper readonly || die 'cannot persist the verified replacement image intent'
  temporary=$(mktemp "$project_dir/.env.cells-cell.XXXXXX")
  chmod 600 "$temporary"
  sed "s/^AWG_IMAGE=.*/AWG_IMAGE=$new_image/" "$env_file" > "$temporary"
  mv -f "$temporary" "$env_file"
  compose up -d --pull never cell || die 'replacement startup failed; no downgrade performed'
  new_id=$(compose ps -q cell)
  [ "$(docker inspect -f '{{.State.Running}}:{{.Image}}' "$new_id")" = "true:$new_image" ] || die 'replacement did not run'
  image=$new_image action=replace
  helper readonly || die 'replacement version/identity check failed'
else
  if [ "$phase" = queued ]; then
    [ "$owned_present" = true ] || die 'owned container disappeared before stop'
    umask 077; printf '%s\n' "$command_id" > "$host_dir/terminal"
    docker update --restart=no "$container_id" >/dev/null
    docker stop --time 20 "$container_id" >/dev/null
    [ "$(docker inspect -f '{{.State.Running}}' "$container_id")" = false ] || die 'container still running'
    action=stopped; helper readonly || die 'cannot persist stopped intent'
    phase=stopped
  fi
  if [ "$phase" = stopped ]; then
    [ "$owned_present" = false ] || [ "$(docker inspect -f '{{.State.Running}}' "$container_id")" = false ] || die 'container restarted'
    image=$owned_image action=cleanup
    helper rw --cap-add NET_ADMIN || die 'owned network cleanup failed'
    phase=resources-removed
  fi
  if [ "$phase" = resources-removed ]; then
    if docker inspect "$container_id" >/dev/null 2>&1; then docker rm "$container_id" >/dev/null; fi
    ! docker inspect "$container_id" >/dev/null 2>&1 || die 'container removal unconfirmed'
    action=removed; helper readonly || die 'cannot persist removed intent'
    phase=container-removed
  fi
  if [ "$phase" = container-removed ]; then
    action=receipt; helper readonly || die 'Main acknowledgement unavailable; receipt retained for retry'
  fi
fi
if [ "$command_id" = "$requested_id" ]; then
  umask 077; printf '%s\n' "$fingerprint" > "$host_dir/completed"
fi
