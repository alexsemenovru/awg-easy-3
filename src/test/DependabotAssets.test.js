'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');

test('Dependabot has real ecosystems, weekly schedules and bounded PR queues', () => {
  const config = fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(config, /^version: 2$/m);
  const entries = [...config.matchAll(/^  - package-ecosystem: "([^"]*)"\r?\n([\s\S]*?)(?=^  - package-ecosystem:|(?![\s\S]))/gm)];
  assert.deepEqual(entries.map((entry) => entry[1]).sort(), ['docker', 'github-actions']);
  for (const [, , body] of entries) {
    assert.match(body, /^    directory: "\/"$/m);
    assert.match(body, /^      interval: "weekly"$/m);
    assert.match(body, /^    open-pull-requests-limit: 3$/m);
  }
  assert.ok(fs.existsSync(path.join(root, 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'test.yml')));
  // The published app image is tied to release metadata, not an independent bump.
  assert.doesNotMatch(config, /package-ecosystem: "docker-compose"/);
  assert.match(config, /pnpm 11 updates remain manual/);
});
