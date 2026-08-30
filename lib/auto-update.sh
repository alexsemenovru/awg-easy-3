#!/bin/sh

# This file is sourced by the installer and the awg-easy-3 management command.
# Keep it POSIX-sh compatible and namespace every public helper.

AWG_EASY_UPDATE_REPOSITORY=https://github.com/alexsemenovru/awg-easy-3.git
AWG_EASY_UPDATE_SERVICE=/etc/systemd/system/awg-easy-3-update.service
AWG_EASY_UPDATE_TIMER=/etc/systemd/system/awg-easy-3-update.timer
AWG_EASY_UPDATE_OPENRC_SERVICE=/etc/init.d/awg-easy-3-update
AWG_EASY_UPDATE_OPENRC_RUNNER=/usr/local/libexec/awg-easy-3-update-on-boot
AWG_EASY_UPDATE_LOCK=/run/lock/awg-easy-3-update.lock

awg_easy_auto_update_backend() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    printf '%s\n' systemd
    return 0
  fi
  if command -v rc-update >/dev/null 2>&1 &&
     command -v rc-service >/dev/null 2>&1 &&
     command -v openrc-run >/dev/null 2>&1 &&
     [ -d /etc/init.d ]; then
    printf '%s\n' openrc
    return 0
  fi
  printf '%s\n' unsupported
}

awg_easy_auto_update_enable_systemd() {
  cat > "$AWG_EASY_UPDATE_SERVICE" <<'EOF' || return 1
[Unit]
Description=Check for a stable AWG-Easy 3 update
Wants=network-online.target
After=network-online.target docker.service
ConditionPathExists=/etc/awg-easy-3-install-dir

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/awg-easy-3 auto-update run
TimeoutStartSec=15min
TimeoutStopSec=3min
EOF
  cat > "$AWG_EASY_UPDATE_TIMER" <<'EOF' || return 1
[Unit]
Description=Check for a stable AWG-Easy 3 update after boot

[Timer]
OnActiveSec=5min
RandomizedDelaySec=2min
AccuracySec=1min
Persistent=false
Unit=awg-easy-3-update.service

[Install]
WantedBy=timers.target
EOF
  chmod 0644 "$AWG_EASY_UPDATE_SERVICE" "$AWG_EASY_UPDATE_TIMER" || return 1
  if ! systemctl daemon-reload; then
    awg_easy_auto_update_disable
    return 1
  fi
  if ! systemctl enable --now awg-easy-3-update.timer; then
    awg_easy_auto_update_disable
    return 1
  fi
  printf 'Automatic stable update checks are enabled with systemd.\n'
}

awg_easy_auto_update_enable_openrc() {
  install -d -m 0755 /usr/local/libexec || return 1
  cat > "$AWG_EASY_UPDATE_OPENRC_RUNNER" <<'EOF' || return 1
#!/bin/sh
exec >> /var/log/awg-easy-3-update.log 2>&1
sleep 300
exec /usr/local/sbin/awg-easy-3 auto-update run
EOF
  chmod 0755 "$AWG_EASY_UPDATE_OPENRC_RUNNER" || return 1
  openrc_run=$(command -v openrc-run) || return 1
  printf '#!%s\n' "$openrc_run" > "$AWG_EASY_UPDATE_OPENRC_SERVICE" || return 1
  cat >> "$AWG_EASY_UPDATE_OPENRC_SERVICE" <<'EOF' || return 1
description="Check for a stable AWG-Easy 3 update after boot"
command="/usr/local/libexec/awg-easy-3-update-on-boot"
command_background="yes"
pidfile="/run/awg-easy-3-update.pid"

depend() {
  need net
  after docker
}
EOF
  chmod 0755 "$AWG_EASY_UPDATE_OPENRC_SERVICE" || return 1
  if ! rc-update add awg-easy-3-update default >/dev/null; then
    awg_easy_auto_update_disable
    return 1
  fi
  if ! rc-service awg-easy-3-update status >/dev/null 2>&1; then
    rc-service awg-easy-3-update zap >/dev/null 2>&1 || true
    if ! rc-service awg-easy-3-update start >/dev/null; then
      awg_easy_auto_update_disable
      return 1
    fi
  fi
  printf 'Automatic stable update checks are enabled with OpenRC.\n'
}

awg_easy_auto_update_enable() {
  case "$(awg_easy_auto_update_backend)" in
    systemd) awg_easy_auto_update_enable_systemd ;;
    openrc) awg_easy_auto_update_enable_openrc ;;
    unsupported)
      printf 'Automatic updates are unavailable: no supported systemd or OpenRC boot mechanism was detected.\n' >&2
      printf 'Use sudo awg-easy-3 update to check for stable updates manually.\n' >&2
      return 2
      ;;
  esac
}

awg_easy_auto_update_disable() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now awg-easy-3-update.timer >/dev/null 2>&1 || true
    systemctl stop awg-easy-3-update.service >/dev/null 2>&1 || true
  fi
  rm -f -- "$AWG_EASY_UPDATE_SERVICE" "$AWG_EASY_UPDATE_TIMER"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed awg-easy-3-update.service >/dev/null 2>&1 || true
  fi
  if command -v rc-service >/dev/null 2>&1; then
    rc-service awg-easy-3-update stop >/dev/null 2>&1 || true
  fi
  if command -v rc-update >/dev/null 2>&1; then
    rc-update del awg-easy-3-update default >/dev/null 2>&1 || true
  fi
  rm -f -- "$AWG_EASY_UPDATE_OPENRC_SERVICE" "$AWG_EASY_UPDATE_OPENRC_RUNNER"
  printf 'Automatic stable update checks are disabled.\n'
}

awg_easy_auto_update_status() {
  if [ -f "$AWG_EASY_UPDATE_TIMER" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-enabled --quiet awg-easy-3-update.timer 2>/dev/null; then
      printf 'Automatic stable update checks: enabled (systemd)\n'
      systemctl list-timers awg-easy-3-update.timer --no-pager 2>/dev/null || true
    else
      printf 'Automatic stable update checks: disabled\n'
    fi
    return 0
  fi
  if [ -x "$AWG_EASY_UPDATE_OPENRC_SERVICE" ] &&
     [ -e /etc/runlevels/default/awg-easy-3-update ]; then
    printf 'Automatic stable update checks: enabled (OpenRC, after each boot)\n'
    return 0
  fi
  printf 'Automatic stable update checks: disabled\n'
}

awg_easy_semver_is_newer() {
  awk -v candidate="$1" -v current="$2" 'BEGIN {
    split(candidate, c, "."); split(current, o, ".")
    for (i = 1; i <= 3; i += 1) {
      if ((c[i] + 0) > (o[i] + 0)) exit 0
      if ((c[i] + 0) < (o[i] + 0)) exit 1
    }
    exit 1
  }'
}

# Candidates are installed deliberately. Only a stable release may replace one.
awg_easy_stable_is_update() {
  installed_base=${2%%-*}
  if awg_easy_semver_is_newer "$1" "$installed_base"; then return 0; fi
  [ "$1" = "$installed_base" ] && [ "$2" != "$installed_base" ]
}

awg_easy_latest_stable_version() {
  refs=$(GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 \
    ls-remote --tags --refs "$AWG_EASY_UPDATE_REPOSITORY" 'v*') \
    || die "unable to query stable releases; the current installation was left unchanged"
  latest=$(printf '%s\n' "$refs" | awk '
    {
      tag = $2
      sub(/^refs\/tags\/v/, "", tag)
      if (tag !~ /^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$/) next
      split(tag, part, ".")
      if (!found || part[1] + 0 > major ||
          (part[1] + 0 == major && part[2] + 0 > minor) ||
          (part[1] + 0 == major && part[2] + 0 == minor && part[3] + 0 > patch)) {
        found = 1
        major = part[1] + 0
        minor = part[2] + 0
        patch = part[3] + 0
        best = tag
      }
    }
    END { if (found) print best }
  ')
  [ -n "$latest" ] || die "no stable release tag was found; the current installation was left unchanged"
  printf '%s\n' "$latest"
}

awg_easy_wait_healthy() {
  attempts=0
  while [ "$attempts" -lt 60 ]; do
    attempts=$((attempts + 1))
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' awg-easy-3 2>/dev/null || true)
    case "$health" in
      healthy) return 0 ;;
      unhealthy|missing) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

awg_easy_update_cleanup() {
  [ -z "${AWG_EASY_UPDATE_STAGE:-}" ] || rm -rf -- "$AWG_EASY_UPDATE_STAGE"
  if [ -r "$AWG_EASY_UPDATE_LOCK/pid" ] &&
     [ "$(sed -n '1p' "$AWG_EASY_UPDATE_LOCK/pid")" = "$$" ]; then
    rm -f -- "$AWG_EASY_UPDATE_LOCK/pid"
    rmdir "$AWG_EASY_UPDATE_LOCK" 2>/dev/null || true
  fi
}

awg_easy_acquire_update_lock() {
  install -d -m 0755 /run/lock || return 1
  if mkdir "$AWG_EASY_UPDATE_LOCK" 2>/dev/null; then
    if ! printf '%s\n' "$$" > "$AWG_EASY_UPDATE_LOCK/pid"; then
      rmdir "$AWG_EASY_UPDATE_LOCK" 2>/dev/null || true
      return 1
    fi
    return 0
  fi
  # Never steal an existing directory: its owner may still be writing the PID,
  # and two concurrent stale-lock removers could otherwise remove a live lock.
  # An unclean shutdown's orphan is cleared with /run on the next OS boot.
  return 1
}

awg_easy_stable_compose() {
  AWG_IMAGE= docker compose --project-directory "$project_dir" -f "$project_dir/docker-compose.yml" "$@"
}

awg_easy_install_manager() {
  install -m 0755 "$project_dir/awg-easy-3" /usr/local/sbin/.awg-easy-3-update-new || return 1
  mv -f /usr/local/sbin/.awg-easy-3-update-new /usr/local/sbin/awg-easy-3
}

awg_easy_restore_previous() {
  old_commit=$1
  reason=$2
  AWG_EASY_UPDATE_ROLLBACK_COMMIT=
  printf 'Update failed (%s). Rolling back to the previous release...\n' "$reason" >&2
  git -C "$project_dir" reset --hard "$old_commit" >/dev/null || return 1
  awg_easy_install_manager || return 1
  # Use the original cached image ID, not a mutable registry tag.
  AWG_IMAGE="$AWG_EASY_UPDATE_PREVIOUS_IMAGE" docker compose --project-directory "$project_dir" \
    -f "$project_dir/docker-compose.yml" up -d --pull never awg-easy || return 1
  awg_easy_wait_healthy || return 1
  printf 'The previous healthy release was restored.\n' >&2
}

awg_easy_rollback_update() {
  awg_easy_restore_previous "$1" "$2" || die "rollback failed; inspect sudo awg-easy-3 diagnose before retrying"
  die "the candidate release did not pass its health check; the previous healthy release was restored"
}

awg_easy_update_on_exit() {
  update_exit_status=$?
  trap - 0
  trap '' HUP INT TERM
  if [ -n "${AWG_EASY_UPDATE_ROLLBACK_COMMIT:-}" ]; then
    if ! awg_easy_restore_previous "$AWG_EASY_UPDATE_ROLLBACK_COMMIT" "update interrupted"; then
      printf 'Error: interrupted update rollback failed; run sudo awg-easy-3 diagnose.\n' >&2
    fi
    update_exit_status=1
  fi
  awg_easy_update_cleanup
  exit "$update_exit_status"
}

awg_easy_run_stable_update() {
  update_mode=${1:-manual}
  command -v git >/dev/null 2>&1 || die "git is required for updates"
  command -v tar >/dev/null 2>&1 || die "tar is required for updates"
  git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "the installation directory is not a Git checkout; reinstall from the official repository"
  [ -r "$project_dir/VERSION" ] || die "installed release metadata is missing"
  [ -r "$project_dir/STATE_VERSION" ] || die "installed state compatibility metadata is missing"
  if ! awg_easy_acquire_update_lock; then
    die "another AWG-Easy 3 update is already running or its lock remains after an unclean shutdown; retry after it finishes, or reboot to clear an orphaned /run lock"
  fi
  AWG_EASY_UPDATE_STAGE=
  AWG_EASY_UPDATE_ROLLBACK_COMMIT=
  trap awg_easy_update_on_exit 0
  trap 'exit 1' HUP INT TERM
  current_version=$(sed -n '1p' "$project_dir/VERSION")
  printf '%s\n' "$current_version" | awk '/^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*(-rc\.[1-9][0-9]*)?$/ { ok = 1 } END { exit !ok }' \
    || die "installed release version is invalid"
  tracked_changes=$(git -C "$project_dir" status --porcelain --untracked-files=no) \
    || die "unable to inspect tracked project files; the installation was left unchanged"
  if [ -n "$tracked_changes" ]; then
    die "tracked project files contain local changes; commit or restore them before updating"
  fi

  if [ "$update_mode" = automatic ]; then
    running_container=$(awg_easy_stable_compose ps -q awg-easy) \
      || die "unable to inspect Docker; the installation was left unchanged"
    container_running=false
    if [ -n "$running_container" ]; then
      container_running=$(docker inspect -f '{{.State.Running}}' "$running_container") \
        || die "unable to inspect the current container; the installation was left unchanged"
    fi
    if [ -z "$running_container" ] ||
       [ "$container_running" != true ]; then
      printf 'Automatic update skipped because AWG-Easy 3 was deliberately stopped.\n'
      return 0
    fi
  fi

  AWG_EASY_UPDATE_STAGE=$(mktemp -d /tmp/awg-easy-3-update.XXXXXX) \
    || die "unable to create a temporary update directory"

  latest_version=$(awg_easy_latest_stable_version) \
    || die "unable to select a stable release; the current installation was left unchanged"
  if ! awg_easy_stable_is_update "$latest_version" "$current_version"; then
    printf 'No newer stable release is available (installed: %s, latest stable: %s).\n' "$current_version" "$latest_version"
    return 0
  fi

  candidate_ref=refs/awg-easy-3/stable-candidate
  GIT_TERMINAL_PROMPT=0 git -C "$project_dir" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 \
    fetch --force --no-tags "$AWG_EASY_UPDATE_REPOSITORY" \
    "refs/tags/v$latest_version:$candidate_ref" \
    || die "unable to download stable release v$latest_version; the current installation was left unchanged"
  candidate_commit=$(git -C "$project_dir" rev-parse "$candidate_ref^{commit}") \
    || die "unable to resolve stable release v$latest_version"
  current_commit=$(git -C "$project_dir" rev-parse HEAD) \
    || die "unable to read the installed project revision"
  git -C "$project_dir" merge-base --is-ancestor "$current_commit" "$candidate_commit" \
    || die "stable release v$latest_version is not a fast-forward update; the current installation was left unchanged"

  git -C "$project_dir" archive --output="$AWG_EASY_UPDATE_STAGE/candidate.tar" "$candidate_commit" \
    || die "unable to archive stable release v$latest_version"
  tar -xf "$AWG_EASY_UPDATE_STAGE/candidate.tar" -C "$AWG_EASY_UPDATE_STAGE" \
    || die "unable to stage stable release v$latest_version"
  candidate_version=$(sed -n '1p' "$AWG_EASY_UPDATE_STAGE/VERSION" 2>/dev/null || true)
  [ "$candidate_version" = "$latest_version" ] \
    || die "stable release metadata does not match tag v$latest_version"
  candidate_state_version=$(sed -n '1p' "$AWG_EASY_UPDATE_STAGE/STATE_VERSION" 2>/dev/null || true)
  current_state_version=$(sed -n '1p' "$project_dir/STATE_VERSION")
  [ "$candidate_state_version" = "$current_state_version" ] \
    || die "stable release v$latest_version needs a state migration and cannot be installed automatically"
  candidate_image=$(AWG_IMAGE= docker compose --project-directory "$AWG_EASY_UPDATE_STAGE" \
    -f "$AWG_EASY_UPDATE_STAGE/docker-compose.yml" config --images) \
    || die "unable to validate candidate Compose settings"
  [ "$candidate_image" = "ghcr.io/alexsemenovru/awg-easy-3:$latest_version" ] \
    || die "stable release v$latest_version does not pin its matching container image"
  [ -x "$AWG_EASY_UPDATE_STAGE/install.sh" ] \
    || die "stable release v$latest_version has no executable installer"
  [ -f "$AWG_EASY_UPDATE_STAGE/awg-easy-3" ] \
    || die "stable release v$latest_version has no management command"

  printf 'Downloading the complete v%s container image before changing the installation...\n' "$latest_version"
  AWG_IMAGE= docker compose --project-directory "$AWG_EASY_UPDATE_STAGE" \
    -f "$AWG_EASY_UPDATE_STAGE/docker-compose.yml" pull awg-easy \
    || die "unable to download stable release v$latest_version; the current installation was left unchanged"

  awg_easy_wait_healthy || die "the current container must be healthy before updating; run sudo awg-easy-3 start and diagnose"
  AWG_EASY_UPDATE_PREVIOUS_IMAGE=$(docker inspect -f '{{.Image}}' awg-easy-3) \
    || die "unable to record the previous image for rollback"
  [ -n "$AWG_EASY_UPDATE_PREVIOUS_IMAGE" ] || die "previous container image is unavailable"
  # Recheck after downloads: refuse to overwrite edits made while waiting.
  tracked_changes=$(git -C "$project_dir" status --porcelain --untracked-files=no) \
    || die "unable to inspect project files before replacement"
  [ -z "$tracked_changes" ] && [ "$(git -C "$project_dir" rev-parse HEAD)" = "$current_commit" ] \
    || die "the checkout changed while downloading; the installation was left unchanged"

  printf 'Installing stable AWG-Easy 3 v%s...\n' "$latest_version"
  AWG_EASY_UPDATE_ROLLBACK_COMMIT=$current_commit
  if ! git -C "$project_dir" merge --ff-only "$candidate_commit"; then
    AWG_EASY_UPDATE_ROLLBACK_COMMIT=
    die "unable to fast-forward the project; inspect the checkout before retrying"
  fi
  awg_easy_install_manager \
    || awg_easy_rollback_update "$current_commit" "management command installation failed"
  if ! awg_easy_stable_compose up -d awg-easy; then
    awg_easy_rollback_update "$current_commit" "container startup failed"
  fi
  if ! awg_easy_wait_healthy; then
    awg_easy_rollback_update "$current_commit" "container health check failed"
  fi
  AWG_EASY_UPDATE_ROLLBACK_COMMIT=
  printf 'AWG-Easy 3 was updated successfully from %s to %s.\n' "$current_version" "$latest_version"
}
