#!/bin/sh
# Forward-only Main + panel transaction. A root-owned intent survives a killed
# updater/reboot; Cells remain on their last rules until the new Main runs.
awg_easy_main_compose() {
  AWG_IMAGE="$AWG_EASY_UPDATE_CANDIDATE_IMAGE" docker compose --project-directory "$project_dir" \
    --env-file "$project_dir/.env.cells-main" -f "$project_dir/docker-compose.yml" \
    -f "$project_dir/docker-compose.cells-main.yml" --profile cells-main "$@"
}
awg_easy_main_intent_safe() {
  [ -d "$project_dir/.update" ] && [ ! -L "$project_dir/.update" ] \
    && [ "$(stat -c %u:%a "$project_dir/.update")" = 0:700 ] \
    && [ -f "$project_dir/.update/intent" ] && [ ! -L "$project_dir/.update/intent" ] \
    && [ "$(stat -c %u:%a:%h "$project_dir/.update/intent")" = 0:600:1 ] \
    && [ "$(stat -c %s "$project_dir/.update/intent")" -lt 512 ]
}
awg_easy_main_update_prepare() {
  [ ! -L "$project_dir/.update" ] || return 1
  install -d -m 0700 "$project_dir/.update" || return 1
  [ "$(stat -c %u:%a "$project_dir/.update")" = 0:700 ] || return 1
  [ ! -e "$project_dir/.update/intent" ] && [ ! -L "$project_dir/.update/intent" ] || return 1
  [ -f "$project_dir/.env.cells-main" ] && [ ! -L "$project_dir/.env.cells-main" ] \
    && [ "$(stat -c %u:%a:%h "$project_dir/.env.cells-main")" = 0:600:1 ] || return 1
  # Main replacement uses the same verified immutable image as the panel.
  [ "$(docker inspect -f '{{.State.Running}}' awg-easy-3-main-cell)" = true ] || return 1
  umask 077
  temporary=$(mktemp "$project_dir/.update/intent.XXXXXX") || return 1
  printf '%s\n%s\n%s\n' "$candidate_commit" "$AWG_EASY_UPDATE_CANDIDATE_IMAGE" "$latest_version" > "$temporary" || return 1
  sync -f "$temporary" || return 1
  mv "$temporary" "$project_dir/.update/intent" || return 1
  sync -f "$project_dir/.update"
}
awg_easy_main_update_resume() {
  awg_easy_main_intent_safe || die 'unsafe Main update intent; no replacement was attempted'
  candidate_commit=$(sed -n '1p' "$project_dir/.update/intent")
  AWG_EASY_UPDATE_CANDIDATE_IMAGE=$(sed -n '2p' "$project_dir/.update/intent")
  latest_version=$(sed -n '3p' "$project_dir/.update/intent")
  [ "$(wc -l < "$project_dir/.update/intent" | tr -d ' ')" = 3 ] || die 'invalid Main update intent'
  printf '%s\n' "$candidate_commit" | grep -Eq '^[a-f0-9]{40}$' || die 'invalid Main update revision'
  printf '%s\n' "$latest_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die 'invalid Main update version'
  awg_easy_verify_candidate_image "$latest_version" "$candidate_commit" "$AWG_EASY_UPDATE_CANDIDATE_IMAGE" \
    || die 'saved Main update image signature rejected; intent retained'
  [ -z "$(git -C "$project_dir" status --porcelain --untracked-files=no)" ] || die 'tracked edits prevent Main update recovery'
  git -C "$project_dir" merge-base --is-ancestor HEAD "$candidate_commit" || die 'Main update would downgrade or diverge'
  image_id=$(docker image inspect -f '{{.Id}}' "$AWG_EASY_UPDATE_CANDIDATE_IMAGE") || die 'saved image is unavailable'
  actual_version=$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint node "$image_id" -p "require('/app/package.json').version")
  [ "$actual_version" = "$latest_version" ] || die 'signed Main package version differs'
  # Both old processes stop before either new process starts. Do not rollback a
  # Main after it may have issued a newer command to a Cell: resume forward.
  awg_easy_main_compose stop main-cell awg-easy || die 'could not stop the previous Main pair; intent retained'
  git -C "$project_dir" merge --ff-only "$candidate_commit" || die 'cannot promote Main update; intent retained'
  awg_easy_install_manager || die 'cannot install the updated management command; intent retained'
  temporary=$(mktemp "$project_dir/.update/main-env.XXXXXX") || die 'cannot stage Main bindings'
  chmod 600 "$temporary"
  awk -v image="$image_id" '/^AWG_IMAGE=/{print "AWG_IMAGE=" image; next}{print}' "$project_dir/.env.cells-main" > "$temporary"
  grep -qx "AWG_IMAGE=$image_id" "$temporary" || die 'Main image binding missing'
  sync -f "$temporary" && mv "$temporary" "$project_dir/.env.cells-main" || die 'cannot persist Main image binding'
  sync -f "$project_dir"
  . "$project_dir/lib/owned-rp-filter.sh"
  set -- "$(sed -n 's/^AWG_MAIN_BOOTSTRAP_INTERFACE=//p' "$project_dir/.env.cells-main")" \
    "$(sed -n 's/^AWG_MAIN_CONTROL_INTERFACE=//p' "$project_dir/.env.cells-main")"
  slot=0
  while [ "$slot" -le 126 ]; do set -- "$@" "awgd$slot"; slot=$((slot + 1)); done
  for reserved do
    if ip link show dev "$reserved" >/dev/null 2>&1; then
      ip -d -o link show dev "$reserved" | grep -Eq 'alias awg-easy-3-cell:[a-f0-9-]{36}([[:space:]]|$)' || die 'foreign device in a reserved Main slot'
    fi
  done
  awg_cells_install_rp_filter main "$@" || die 'cannot install owned interface settings; intent retained'
  rm -f "$project_dir/cell-status/main-ready.json"
  awg_easy_main_compose up -d --pull never awg-easy || die 'new panel failed to start; intent retained'
  awg_easy_wait_healthy || die 'new panel is not healthy; intent retained for forward recovery'
  verified_user=$(docker exec awg-easy-3 node /app/main-cell-install-info.js --verify) || die 'new panel interface verification failed; intent retained'
  set -- $verified_user
  [ "$#" = 4 ] || die 'invalid verified user interface metadata'
  awg_cells_install_rp_filter user "$1" || die 'cannot configure owned panel mark validation'
  awg_easy_main_compose up -d --no-deps --pull never main-cell || die 'new Main failed to start; intent retained'
  attempts=0
  while [ "$attempts" -lt 60 ]; do
    if [ "$(docker inspect -f '{{.State.Running}}:{{.Image}}' awg-easy-3-main-cell)" = "true:$image_id" ] \
      && docker exec awg-easy-3-main-cell node /app/main-update-health.js >/dev/null 2>&1; then break; fi
    attempts=$((attempts + 1)); sleep 2
  done
  [ "$attempts" -lt 60 ] || die 'new Main did not become ready; intent retained for forward recovery'
  [ "$(docker inspect -f '{{.Image}}' awg-easy-3)" = "$image_id" ] || die 'panel and Main images differ'
  mv "$project_dir/.update/intent" "$project_dir/.update/completed"
  sync -f "$project_dir/.update"
  printf 'Main and panel now run v%s. Cells update automatically through authenticated maintenance; unavailable Cells remain pending.\n' "$latest_version"
}
