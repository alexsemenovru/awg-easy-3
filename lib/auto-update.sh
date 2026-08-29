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
  cat > "$AWG_EASY_UPDATE_SERVICE" <<'EOF'
[Unit]
Description=Check for a stable AWG-Easy 3 update
Wants=network-online.target
After=network-online.target docker.service
ConditionPathExists=/etc/awg-easy-3-install-dir

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/awg-easy-3 auto-update run
TimeoutStartSec=15min
EOF
  cat > "$AWG_EASY_UPDATE_TIMER" <<'EOF'
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
  chmod 0644 "$AWG_EASY_UPDATE_SERVICE" "$AWG_EASY_UPDATE_TIMER"
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
  cat > "$AWG_EASY_UPDATE_OPENRC_RUNNER" <<'EOF'
#!/bin/sh
exec >> /var/log/awg-easy-3-update.log 2>&1
sleep 300
exec /usr/local/sbin/awg-easy-3 auto-update run
EOF
  chmod 0755 "$AWG_EASY_UPDATE_OPENRC_RUNNER"
  openrc_run=$(command -v openrc-run) || return 1
  printf '#!%s\n' "$openrc_run" > "$AWG_EASY_UPDATE_OPENRC_SERVICE"
  cat >> "$AWG_EASY_UPDATE_OPENRC_SERVICE" <<'EOF'
description="Check for a stable AWG-Easy 3 update after boot"
command="/usr/local/libexec/awg-easy-3-update-on-boot"
command_background="yes"
pidfile="/run/awg-easy-3-update.pid"

depend() {
  need net
  after docker
}
EOF
  chmod 0755 "$AWG_EASY_UPDATE_OPENRC_SERVICE"
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
  install -d -m 0755 /run/lock
  if mkdir "$AWG_EASY_UPDATE_LOCK" 2>/dev/null; then
    printf '%s\n' "$$" > "$AWG_EASY_UPDATE_LOCK/pid"
    return 0
  fi
  lock_pid=$(sed -n '1p' "$AWG_EASY_UPDATE_LOCK/pid" 2>/dev/null || true)
  case "$lock_pid" in
    ''|*[!0-9]*) lock_pid= ;;
  esac
  if [ -z "$lock_pid" ] || ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -f -- "$AWG_EASY_UPDATE_LOCK/pid"
    if rmdir "$AWG_EASY_UPDATE_LOCK" 2>/dev/null && mkdir "$AWG_EASY_UPDATE_LOCK" 2>/dev/null; then
      printf '%s\n' "$$" > "$AWG_EASY_UPDATE_LOCK/pid"
      return 0
    fi
  fi
  return 1
}

awg_easy_stable_compose() {
  AWG_IMAGE= docker compose --project-directory "$project_dir" -f "$project_dir/docker-compose.yml" "$@"
}

awg_easy_rollback_update() {
  old_commit=$1
  reason=$2
  printf 'Update failed (%s). Rolling back to the previous release...\n' "$reason" >&2
  git -C "$project_dir" reset --hard "$old_commit" >/dev/null \
    || die "rollback could not restore the previous project revision"
  install -m 0755 "$project_dir/awg-easy-3" /usr/local/sbin/awg-easy-3 \
    || die "rollback restored the project but could not restore the management command"
  awg_easy_stable_compose up -d awg-easy \
    || die "rollback restored the project but could not restart the previous container"
  awg_easy_wait_healthy \
    || die "rollback restored the project, but the previous container did not become healthy"
  die "the candidate release did not pass its health check; the previous healthy release was restored"
}

awg_easy_run_stable_update() {
  update_mode=${1:-manual}
  command -v git >/dev/null 2>&1 || die "git is required for updates"
  command -v tar >/dev/null 2>&1 || die "tar is required for updates"
  git -C "$project_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "the installation directory is not a Git checkout; reinstall from the official repository"
  [ -r "$project_dir/VERSION" ] || die "installed release metadata is missing"
  [ -r "$project_dir/STATE_VERSION" ] || die "installed state compatibility metadata is missing"
  current_version=$(sed -n '1p' "$project_dir/VERSION")
  case "$current_version" in
    ''|*[!0-9.]*) die "installed release version is invalid" ;;
  esac
  printf '%s\n' "$current_version" | awk '/^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$/ { ok = 1 } END { exit !ok }' \
    || die "installed release version is invalid"
  if [ -n "$(git -C "$project_dir" status --porcelain --untracked-files=no)" ]; then
    die "tracked project files contain local changes; commit or restore them before updating"
  fi

  if [ "$update_mode" = automatic ]; then
    running_container=$(awg_easy_stable_compose ps -q awg-easy 2>/dev/null || true)
    if [ -z "$running_container" ] ||
       [ "$(docker inspect -f '{{.State.Running}}' "$running_container" 2>/dev/null || true)" != true ]; then
      printf 'Automatic update skipped because AWG-Easy 3 was deliberately stopped.\n'
      return 0
    fi
  fi

  if ! awg_easy_acquire_update_lock; then
    die "another AWG-Easy 3 update is already running"
  fi
  AWG_EASY_UPDATE_STAGE=
  trap awg_easy_update_cleanup 0
  trap 'awg_easy_update_cleanup; exit 1' HUP INT TERM
  AWG_EASY_UPDATE_STAGE=$(mktemp -d /tmp/awg-easy-3-update.XXXXXX) \
    || die "unable to create a temporary update directory"

  latest_version=$(awg_easy_latest_stable_version)
  if ! awg_easy_semver_is_newer "$latest_version" "$current_version"; then
    printf 'AWG-Easy 3 %s is already the newest stable release.\n' "$current_version"
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

  git -C "$project_dir" archive "$candidate_commit" | tar -x -C "$AWG_EASY_UPDATE_STAGE" \
    || die "unable to stage stable release v$latest_version"
  candidate_version=$(sed -n '1p' "$AWG_EASY_UPDATE_STAGE/VERSION" 2>/dev/null || true)
  [ "$candidate_version" = "$latest_version" ] \
    || die "stable release metadata does not match tag v$latest_version"
  candidate_state_version=$(sed -n '1p' "$AWG_EASY_UPDATE_STAGE/STATE_VERSION" 2>/dev/null || true)
  current_state_version=$(sed -n '1p' "$project_dir/STATE_VERSION")
  [ "$candidate_state_version" = "$current_state_version" ] \
    || die "stable release v$latest_version needs a state migration and cannot be installed automatically"
  grep -Fq "ghcr.io/alexsemenovru/awg-easy-3:$latest_version" "$AWG_EASY_UPDATE_STAGE/docker-compose.yml" \
    || die "stable release v$latest_version does not pin its matching container image"
  [ -x "$AWG_EASY_UPDATE_STAGE/install.sh" ] \
    || die "stable release v$latest_version has no executable installer"
  [ -f "$AWG_EASY_UPDATE_STAGE/awg-easy-3" ] \
    || die "stable release v$latest_version has no management command"

  printf 'Downloading the complete v%s container image before changing the installation...\n' "$latest_version"
  AWG_IMAGE= docker compose --project-directory "$AWG_EASY_UPDATE_STAGE" \
    -f "$AWG_EASY_UPDATE_STAGE/docker-compose.yml" pull awg-easy \
    || die "unable to download stable release v$latest_version; the current installation was left unchanged"

  printf 'Installing stable AWG-Easy 3 v%s...\n' "$latest_version"
  git -C "$project_dir" merge --ff-only "$candidate_commit" \
    || die "unable to fast-forward the project; the current installation was left unchanged"
  install -m 0755 "$project_dir/awg-easy-3" /usr/local/sbin/awg-easy-3 \
    || awg_easy_rollback_update "$current_commit" "management command installation failed"
  if ! awg_easy_stable_compose up -d awg-easy; then
    awg_easy_rollback_update "$current_commit" "container startup failed"
  fi
  if ! awg_easy_wait_healthy; then
    awg_easy_rollback_update "$current_commit" "container health check failed"
  fi
  printf 'AWG-Easy 3 was updated successfully from %s to %s.\n' "$current_version" "$latest_version"
}
