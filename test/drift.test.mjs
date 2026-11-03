// The files this fork shares with upstream myco must stay identical to it, or upstream
// fixes stop merging cleanly. These tests cover the checker on fixture trees and git
// repositories, and the real invariant on this repository.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { ROOT, sandbox } from './helpers.mjs';
import { check, init, release, report, sharedFiles } from '../scripts/drift.mjs';

const DRIFT = join(ROOT, 'scripts', 'drift.mjs');
const put = (root, rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitInit = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
};
const commit = (dir, msg) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
};

/** A tree with two shared templates and one shared script. */
function tree(root) {
  put(root, 'plugins/design-team/templates/prd.md', 'prd\n');
  put(root, 'plugins/team-ops/templates/report.md', 'report\n');
  put(root, 'plugins/team-ops/scripts/otlp.mjs', '// otlp\n');
  put(root, 'plugins/team-ops/scripts/capture.mjs', '// not shared\n');
}

describe('drift: this repository', () => {
  test('every file meant to match upstream still does', () => {
    assert.deepEqual(check(ROOT), []);
  });

  test('the manifest names an upstream commit and covers the portable scripts and templates', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'drift-manifest.json'), 'utf8'));
    assert.match(m.upstream.commit, /^[0-9a-f]{40}$/);
    for (const f of ['plugins/team-ops/scripts/otlp.mjs', 'plugins/team-ops/scripts/profile.mjs', 'plugins/engineering-team/scripts/profile.mjs', 'plugins/design-team/scripts/check-package.mjs']) {
      assert.ok(f in m.files || f in m.diverged, f);
    }
    assert.ok(Object.keys(m.files).some((f) => f.includes('/templates/')));
  });
});

describe('drift: checker', () => {
  test('init records the shared files, and not the ones that are ours', (t) => {
    const { root } = sandbox(t);
    tree(root);
    assert.deepEqual(sharedFiles(root), ['plugins/design-team/templates/prd.md', 'plugins/team-ops/scripts/otlp.mjs', 'plugins/team-ops/templates/report.md']);
    assert.equal(init(root, { commit: 'abc', remote: 'none' }), 3);
    assert.deepEqual(check(root), []);
  });

  test('a changed, deleted or newly shared file is a problem, each named', (t) => {
    const { root } = sandbox(t);
    tree(root);
    init(root, { commit: 'abc', remote: 'none' });
    put(root, 'plugins/design-team/templates/prd.md', 'changed\n');
    rmSync(join(root, 'plugins/team-ops/templates/report.md'));
    put(root, 'plugins/team-ops/templates/new.md', 'new\n');
    const problems = check(root);
    assert.equal(problems.length, 3);
    assert.match(problems.find((p) => p.startsWith('plugins/design-team/templates/prd.md')), /differs from upstream/);
    assert.match(problems.find((p) => p.startsWith('plugins/team-ops/templates/report.md')), /missing/);
    assert.match(problems.find((p) => p.startsWith('plugins/team-ops/templates/new.md')), /not in the manifest/);
  });

  test('line endings do not count as a change', (t) => {
    const { root } = sandbox(t);
    tree(root);
    init(root, { commit: 'abc', remote: 'none' });
    put(root, 'plugins/design-team/templates/prd.md', 'prd\r\n');
    assert.deepEqual(check(root), []);
  });

  test('releasing a file needs a reason, and keeps it out of later inits', (t) => {
    const { root } = sandbox(t);
    tree(root);
    init(root, { commit: 'abc', remote: 'none' });
    assert.throws(() => release(root, 'plugins/design-team/templates/prd.md', ''), /needs --reason/);
    assert.throws(() => release(root, 'plugins/nope.md', 'x'), /not a shared file/);
    put(root, 'plugins/design-team/templates/prd.md', 'diverged\n');
    release(root, 'plugins/design-team/templates/prd.md', 'opencode wording');
    assert.deepEqual(check(root), []);
    assert.equal(init(root, { commit: 'def', remote: 'none' }), 2);
    const m = JSON.parse(readFileSync(join(root, 'drift-manifest.json'), 'utf8'));
    assert.equal(m.diverged['plugins/design-team/templates/prd.md'], 'opencode wording');
  });

  test('the CLI exits 1 on drift and 0 when clean', (t) => {
    const { root } = sandbox(t);
    tree(root);
    init(root, { commit: 'abc', remote: 'none' });
    assert.equal(spawnSync(process.execPath, [DRIFT, 'check', '--root', root], { encoding: 'utf8' }).status, 0);
    put(root, 'plugins/team-ops/scripts/otlp.mjs', '// edited\n');
    const r = spawnSync(process.execPath, [DRIFT, 'check', '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /otlp\.mjs: differs from upstream/);
  });
});

describe('drift: report', () => {
  test('sorts upstream changes into pull, merge by hand and review', (t) => {
    const { root } = sandbox(t);
    const upstream = join(root, 'upstream');
    gitInit(upstream);
    tree(upstream);
    put(upstream, 'plugins/team-ops/agents/coach.md', 'v1\n');
    const first = commit(upstream, 'first');

    const fork = join(root, 'fork');
    git(root, 'clone', '-q', upstream, fork);
    git(fork, 'remote', 'rename', 'origin', 'upstream');
    git(fork, 'config', 'user.email', 't@example.com');
    git(fork, 'config', 'user.name', 't');
    init(fork, { commit: first });
    put(fork, 'plugins/design-team/templates/prd.md', 'ours\n');
    release(fork, 'plugins/design-team/templates/prd.md', 'wording');
    assert.deepEqual(report(fork, {}).pull, []);

    put(upstream, 'plugins/team-ops/scripts/otlp.mjs', '// fixed upstream\n');
    put(upstream, 'plugins/design-team/templates/prd.md', 'upstream edit\n');
    put(upstream, 'plugins/team-ops/agents/coach.md', 'v2\n');
    commit(upstream, 'second');

    const r = report(fork, {});
    assert.equal(r.recorded, first);
    assert.deepEqual(r.pull, ['plugins/team-ops/scripts/otlp.mjs']);
    assert.deepEqual(r.merge, ['plugins/design-team/templates/prd.md']);
    assert.deepEqual(r.review, ['plugins/team-ops/agents/coach.md']);

    const cli = spawnSync(process.execPath, [DRIFT, 'report', '--root', fork], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /pull \(shared, take upstream\):\n {2}plugins\/team-ops\/scripts\/otlp\.mjs/);
    assert.match(cli.stdout, /merge by hand \(released\):\n {2}plugins\/design-team\/templates\/prd\.md/);
  });
});
