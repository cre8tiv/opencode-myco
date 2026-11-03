// A script that only runs "when executed directly" decides that by comparing paths. A
// symlinked directory (macOS's /var → /private/var, a dotfiles-managed ~/.config) makes
// the two spellings differ, and the script then does nothing and says nothing. These run
// each CLI through a symlink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, sandbox } from './helpers.mjs';
import { install } from '../scripts/install.mjs';

/** Makes `<sandbox>/<name>` point at `dir`, or skips the test where symlinks aren't allowed (Windows without privileges). */
function link(t, sb, dir, name) {
  const p = join(sb.root, name);
  try {
    symlinkSync(dir, p, 'dir');
  } catch (e) {
    t.skip(`cannot create a symlink here: ${e.code}`);
    return null;
  }
  return p;
}

const run = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' });

test('install.mjs and drift.mjs run through a symlinked repository path', (t) => {
  const sb = sandbox(t);
  const repo = link(t, sb, ROOT, 'repo-link');
  if (!repo) return;
  const target = join(sb.root, 'out');
  const installed = run(join(repo, 'scripts', 'install.mjs'), '--target', target);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installed 11 agents/);
  const drift = run(join(repo, 'scripts', 'drift.mjs'), 'check');
  assert.equal(drift.status, 0, drift.stderr);
  assert.match(drift.stdout, /shared files match upstream/);
});

test('models.mjs runs from an installed copy reached through a symlink', (t) => {
  const sb = sandbox(t);
  const real = join(sb.root, 'real');
  mkdirSync(real);
  install({ target: join(real, 'opencode') });
  const alias = link(t, sb, real, 'alias');
  if (!alias) return;
  const r = run(join(alias, 'opencode', 'myco', 'team-ops', 'scripts', 'models.mjs'), 'show');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /engineering-team\/tech-lead\s+lead\s+\(your default model\)/);
});
