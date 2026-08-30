'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const manager = fs.readFileSync(path.join(root, 'awg-easy-3'), 'utf8').replace(/\r\n/g, '\n');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8').replace(/\r\n/g, '\n');
const updater = fs.readFileSync(path.join(root, 'lib', 'auto-update.sh'), 'utf8').replace(/\r\n/g, '\n');
const shell = process.env.AWG_TEST_SHELL || (process.platform === 'win32' ? null : 'sh');
const shellOptions = { skip: !shell && 'Set AWG_TEST_SHELL to a POSIX sh executable on Windows' };

test('release metadata stays aligned across application, state and image', () => {
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const stateVersion = fs.readFileSync(path.join(root, 'STATE_VERSION'), 'utf8').trim();
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src', 'package.json'), 'utf8'));
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'src', 'lib', 'StateStore.js'), 'utf8');
  assert.equal(version, packageJson.version);
  assert.match(compose, new RegExp(`ghcr\\.io/alexsemenovru/awg-easy-3:${version.replaceAll('.', '\\.')}`));
  assert.match(store, new RegExp(`const STATE_VERSION = ${stateVersion};`));
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'docker-publish.yml'), 'utf8');
  assert.match(workflow, /Verify release metadata/);
  assert.match(workflow, /GITHUB_REF_NAME.*v\$version/);
  assert.match(workflow, /latest=false/);
  assert.match(workflow, /type=raw,value=latest,enable=.*is_stable/);
  assert.ok(workflow.indexOf('pnpm test') < workflow.indexOf('Build and push Docker image'));
});

test('installer enables boot update checks without asking and removes owned hooks on uninstall', () => {
  const enable = installer.indexOf('awg_easy_auto_update_enable');
  const complete = installer.indexOf("printf '\\nInstallation complete");
  const remove = installer.indexOf('awg_easy_auto_update_disable');
  const healthy = installer.lastIndexOf('awg_easy_wait_healthy');
  assert.ok(enable > 0 && enable < complete);
  assert.ok(healthy > 0 && healthy < enable);
  assert.ok(remove > 0 && remove < installer.indexOf(' down --remove-orphans'));
  assert.doesNotMatch(installer, /Enable stable update checks|Включить проверку стабильных обновлений|auto-update.*\[y\/N\]/i);
  assert.match(installer, /sudo awg-easy-3 auto-update disable/);
});

test('boot integration uses native one-shot mechanisms and no cron or extra container', () => {
  assert.match(updater, /OnActiveSec=5min/);
  assert.match(updater, /RandomizedDelaySec=2min/);
  assert.match(updater, /Persistent=false/);
  assert.match(updater, /Type=oneshot/);
  assert.match(updater, /ExecStart=\/usr\/local\/sbin\/awg-easy-3 auto-update run/);
  assert.match(updater, /command_background="yes"/);
  assert.match(updater, /rc-update add awg-easy-3-update default/);
  assert.doesNotMatch(updater + installer, /\bcrontab\b|\/etc\/cron|docker run.*update/i);
});

test('stable updater stages and validates a release before a fast-forward, with lock and rollback', () => {
  const pull = updater.indexOf('pull awg-easy');
  const merge = updater.indexOf('merge --ff-only');
  assert.match(updater, /refs\/tags\/v/);
  assert.ok(updater.includes('[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*'));
  assert.match(updater, /candidate_state_version/);
  assert.match(updater, /status --porcelain --untracked-files=no/);
  assert.match(updater, /merge-base --is-ancestor/);
  assert.match(updater, /another AWG-Easy 3 update is already running/);
  assert.match(updater, /Automatic update skipped because AWG-Easy 3 was deliberately stopped/);
  assert.ok(pull > 0 && merge > pull);
  assert.match(updater, /reset --hard "\$old_commit"/);
  assert.match(updater, /previous healthy release was restored/);
  assert.doesNotMatch(updater, /git[^\n]* pull /);
});

test('management command exposes explicit automatic-update controls', () => {
  assert.match(manager, /auto-update enable\|disable\|status\|run/);
  assert.match(manager, /run\) awg_easy_run_stable_update automatic/);
  assert.match(manager, /disable\) awg_easy_auto_update_disable/);
  assert.match(manager, /status\) awg_easy_auto_update_status/);
});

test('semantic version selection ignores prereleases and orders numeric components', shellOptions, () => {
  const result = spawnSync(shell, ['-s'], {
    input: `${updater}\n` + String.raw`
      die() { printf '%s\n' "$*" >&2; exit 1; }
      git() {
        printf '%s\n' \
          'a refs/tags/v1.2.9' \
          'b refs/tags/v1.10.0' \
          'c refs/tags/v2.0.0-rc.1' \
          'd refs/tags/not-a-version'
      }
      awg_easy_latest_stable_version
      awg_easy_semver_is_newer 1.10.0 1.9.99
      if awg_easy_semver_is_newer 1.10.0 1.10.0; then exit 9; fi
      awg_easy_stable_is_update 1.10.0 1.10.0-rc.1 || exit 10
      awg_easy_stable_is_update 1.11.0 1.10.0-rc.2 || exit 11
      if awg_easy_stable_is_update 1.9.0 1.10.0-rc.1; then exit 12; fi
      if awg_easy_stable_is_update 1.10.0 1.10.0; then exit 13; fi
    `,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1.10.0');
});

const updateFixture = String.raw`
  die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
  task_root=$(mktemp -d /tmp/awg-easy-update-test.XXXXXX) || exit 90
  remote="$task_root/remote"
  project_dir="$task_root/project"
  mkdir -p "$remote"
  git -C "$remote" init -q
  git -C "$remote" config user.email test@example.invalid
  git -C "$remote" config user.name Test
  printf '1.0.0\n' > "$remote/VERSION"
  printf '1\n' > "$remote/STATE_VERSION"
  printf 'services:\n  awg-easy:\n    image: ghcr.io/alexsemenovru/awg-easy-3:1.0.0\n' > "$remote/docker-compose.yml"
  printf '#!/bin/sh\n' > "$remote/install.sh"
  printf '#!/bin/sh\n' > "$remote/awg-easy-3"
  chmod +x "$remote/install.sh" "$remote/awg-easy-3"
  git -C "$remote" add VERSION STATE_VERSION docker-compose.yml install.sh awg-easy-3
  git -C "$remote" commit -qm v1.0.0
  git -C "$remote" tag v1.0.0
  printf '1.1.0\n' > "$remote/VERSION"
  printf 'services:\n  awg-easy:\n    image: ghcr.io/alexsemenovru/awg-easy-3:1.1.0\n' > "$remote/docker-compose.yml"
  git -C "$remote" add VERSION docker-compose.yml
  git -C "$remote" commit -qm v1.1.0
  git -C "$remote" tag v1.1.0
  git clone -q "$remote" "$project_dir"
  git -C "$project_dir" checkout -qb installed v1.0.0
  mkdir "$project_dir/data"
  printf 'preserve-state\n' > "$project_dir/data/state.json"
  printf 'preserve-env\n' > "$project_dir/.env"
  AWG_EASY_UPDATE_REPOSITORY="$remote"
  AWG_EASY_UPDATE_LOCK="$task_root/update.lock"
  AWG_IMAGE=
  test_stopped=false
  test_pull_failure=false
  test_bad_health=false
  install() { return 0; }
  awg_easy_install_manager() { return 0; }
  docker() {
    printf '%s | image=%s\n' "$*" "$AWG_IMAGE" >> "$task_root/docker.log"
    case "$*" in
      *config\ --images) printf 'ghcr.io/alexsemenovru/awg-easy-3:1.1.0\n';;
      *ps\ -q*) [ "$test_stopped" = true ] || printf 'test-container\n';;
      *pull\ awg-easy) [ "$test_pull_failure" != true ] || return 1;;
      inspect*)
        case "$*" in
          *'.Image'*) printf 'sha256:previous-image\n';;
          *'.State.Running'*) printf 'true\n';;
          *)
            if [ "$test_bad_health" = true ] &&
               [ "$(sed -n '1p' "$project_dir/VERSION")" = 1.1.0 ]; then
              printf 'unhealthy\n'
            else
              printf 'healthy\n'
            fi;;
        esac;;
    esac
    return 0
  }
  assert_preserved() {
    [ "$(cat "$project_dir/data/state.json")" = preserve-state ] &&
      [ "$(cat "$project_dir/.env")" = preserve-env ] &&
      [ ! -e "$AWG_EASY_UPDATE_LOCK" ]
  }
`;

test('staged stable update fast-forwards only after the candidate image is available', shellOptions, () => {
  const result = spawnSync(shell, ['-s'], {
    input: `${updater}\n${updateFixture}\n` + String.raw`
      (set -eu; awg_easy_run_stable_update manual)
      update_status=$?
      installed_version=$(sed -n '1p' "$project_dir/VERSION")
      assert_preserved || exit 91
      rm -rf -- "$task_root"
      [ "$update_status" -eq 0 ] && [ "$installed_version" = 1.1.0 ]
    `,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /updated successfully from 1\.0\.0 to 1\.1\.0/);
});

test('failed candidate health check restores the previous commit', shellOptions, () => {
  const result = spawnSync(shell, ['-s'], {
    input: `${updater}\n${updateFixture}\n` + String.raw`
      test_bad_health=true
      (set -eu; awg_easy_run_stable_update manual)
      update_status=$?
      installed_version=$(sed -n '1p' "$project_dir/VERSION")
      assert_preserved || exit 91
      grep -q 'pull never.*image=sha256:previous-image' "$task_root/docker.log" || exit 92
      rm -rf -- "$task_root"
      [ "$update_status" -ne 0 ] && [ "$installed_version" = 1.0.0 ]
    `,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /previous healthy release was restored/);
});

for (const [name, setup, message, success = false] of [
  ['unavailable image', 'test_pull_failure=true', /unable to download stable release/],
  ['unavailable release list', 'awg_easy_latest_stable_version() { return 1; }', /unable to select a stable release/],
  ['unreadable checkout', String.raw`git() { case "$*" in *status*) return 1;; *) command git "$@";; esac; }`, /unable to inspect tracked project files/],
  ['unavailable Docker', 'docker() { return 1; }', /unable to inspect Docker/],
  ['deliberately stopped service', 'test_stopped=true', /deliberately stopped/, true],
  ['exit during replacement', String.raw`
    awg_easy_install_manager() {
      if [ "$(cat "$project_dir/VERSION")" = 1.1.0 ]; then exit 77; fi
    }
  `, /previous healthy release was restored/],
]) {
  test(`${name} preserves installed files and state`, shellOptions, () => {
    const result = spawnSync(shell, ['-s'], {
      input: `${updater}\n${updateFixture}\n${setup}\n` + String.raw`
        (set -eu; awg_easy_run_stable_update automatic)
        update_status=$?
        [ "$(cat "$project_dir/VERSION")" = 1.0.0 ] || exit 92
        assert_preserved || exit 91
        rm -rf -- "$task_root"
      ` + `\n[ "$update_status" ${success ? '-eq' : '-ne'} 0 ]\n`,
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, message);
  });
}

test('an existing lock is never stolen, even before its owner writes a PID', shellOptions, () => {
  const result = spawnSync(shell, ['-s'], {
    input: `${updater}\n` + String.raw`
      task_root=$(mktemp -d /tmp/awg-lock-test.XXXXXX) || exit 90
      AWG_EASY_UPDATE_LOCK="$task_root/update.lock"
      install() { return 0; }
      mkdir "$AWG_EASY_UPDATE_LOCK"
      if awg_easy_acquire_update_lock; then exit 91; fi
      printf '99999999\n' > "$AWG_EASY_UPDATE_LOCK/pid"
      if awg_easy_acquire_update_lock; then exit 92; fi
      [ "$(cat "$AWG_EASY_UPDATE_LOCK/pid")" = 99999999 ] || exit 93
      rm -rf -- "$task_root"
    `,
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
