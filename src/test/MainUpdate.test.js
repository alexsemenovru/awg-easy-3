'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const skip = process.platform !== 'linux' || process.getuid?.() !== 0 ? 'Root Linux disposable fixture required' : false;
for (const fault of ['none', 'start-panel', 'start-main', 'signature']) {
  test(`coordinated Main update keeps a durable forward-only intent: ${fault}`, { skip }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awg-main-update-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.chmod(directory, 0o700);
    const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']); git(['config', 'user.email', 'lab@example.invalid']); git(['config', 'user.name', 'Fixture']);
    await fs.writeFile(path.join(directory, 'VERSION'), '1.0.0\n'); git(['add', 'VERSION']); git(['commit', '-qm', 'old']);
    const previous = git(['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(directory, 'VERSION'), '1.1.0\n'); git(['commit', '-qam', 'new']);
    const candidate = git(['rev-parse', 'HEAD']); git(['reset', '--hard', previous]);
    await fs.mkdir(path.join(directory, 'lib'));
    await fs.writeFile(path.join(directory, 'lib/owned-rp-filter.sh'), 'awg_cells_install_rp_filter() { return 0; }\n');
    await fs.mkdir(path.join(directory, 'cell-status'), { mode: 0o700 });
    await fs.writeFile(path.join(directory, '.env.cells-main'), `AWG_IMAGE=sha256:${'b'.repeat(64)}\nAWG_MAIN_ENDPOINT=old.example.test\n`, { mode: 0o600 });
    const result = spawnSync('sh', ['-s'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, LAB_ROOT: directory, LAB_FAULT: fault }, input: `
set -eu
project_dir="$LAB_ROOT"
. '${root.replaceAll("'", "'\\''")}/lib/main-update.sh'
die() { echo "$*" >&2; exit 1; }
candidate_commit=${candidate}
latest_version=1.1.0
AWG_EASY_UPDATE_CANDIDATE_IMAGE=ghcr.io/alexsemenovru/awg-easy-3@sha256:${'a'.repeat(64)}
awg_easy_verify_candidate_image() { [ "$LAB_FAULT" != signature ]; }
awg_easy_install_manager() { echo install-manager >> "$project_dir/events"; }
awg_easy_wait_healthy() { return 0; }
docker() {
  case "$1:$2" in
    image:inspect) printf 'sha256:${'a'.repeat(64)}\n' ;;
    run:*) printf '1.1.0\n' ;;
    inspect:-f)
      case "$3:$4" in
        '{{.State.Running}}:{{.Image}}:awg-easy-3-main-cell') printf 'true:sha256:${'a'.repeat(64)}\n' ;;
        '{{.State.Running}}:awg-easy-3-main-cell') echo true ;;
        '{{.Image}}:awg-easy-3') printf 'sha256:${'a'.repeat(64)}\n' ;;
        *) return 99 ;;
      esac ;;
    exec:awg-easy-3) echo "awg0 55000 51821 old.example.test" ;;
    exec:awg-easy-3-main-cell) return 0 ;;
    *) return 98 ;;
  esac
}
awg_easy_main_compose() {
  echo "$*" >> "$project_dir/events"
  case "$LAB_FAULT:$*" in
    start-panel:'up -d --pull never awg-easy'|start-main:'up -d --no-deps --pull never main-cell') return 1 ;;
  esac
}
awg_easy_main_update_prepare
awg_easy_main_update_resume
` });
    const events = await fs.readFile(path.join(directory, 'events'), 'utf8').catch(() => '');
    if (fault === 'none') {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(events.indexOf('stop main-cell awg-easy') < events.indexOf('up -d --pull never awg-easy'));
      assert.ok(events.indexOf('up -d --pull never awg-easy') < events.indexOf('up -d --no-deps --pull never main-cell'));
      await assert.rejects(fs.access(path.join(directory, '.update/intent')));
      assert.equal(git(['rev-parse', 'HEAD']), candidate);
    } else {
      assert.notEqual(result.status, 0);
      await fs.access(path.join(directory, '.update/intent'));
      assert.equal(git(['rev-parse', 'HEAD']), fault === 'signature' ? previous : candidate);
      if (fault === 'signature') assert.equal(events, '');
    }
    assert.match(await fs.readFile(path.join(directory, '.env.cells-main'), 'utf8'), /AWG_MAIN_ENDPOINT=old.example.test/);
  });
}
