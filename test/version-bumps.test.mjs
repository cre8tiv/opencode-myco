// The version-bump check runs in CI against a pull request's base. These tests build
// small throwaway git repositories to cover the cases that decide whether a change
// ever reaches an installed plugin.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, sandbox, runNode } from './helpers.mjs';

const CHECK = join(ROOT, 'scripts', 'check-version-bumps.mjs');
// Commits made by the tests must not depend on, or be changed by, the developer's git config.
const NO_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: NO_CONFIG, GIT_CONFIG_SYSTEM: NO_CONFIG };

/** A repository on `main` with two plugins, then a `change` branch checked out. */
function repo(t) {
  const sb = sandbox(t);
  const dir = join(sb.root, 'repo');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  for (const [name, version] of [['alpha', '1.2.3'], ['beta', '0.4.9']]) {
    write(`plugins/${name}/meta.json`, JSON.stringify({ name, version }, null, 2));
    write(`plugins/${name}/README.md`, '# readme');
    write(`plugins/${name}/agents/lead.md`, 'v1');
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'change');
  const commit = (msg = 'change') => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
  };
  const bump = (name, version) => write(`plugins/${name}/meta.json`, JSON.stringify({ name, version }, null, 2));
  const check = (args = ['--base', 'main']) => runNode(CHECK, { args, cwd: dir, env: { ...sb.env, ...GIT_ENV } });
  return { write, commit, bump, check, git };
}

describe('check-version-bumps', () => {
  test('passes when nothing under plugins/ changed', async (t) => {
    const r = repo(t);
    r.write('docs/notes.md', 'x');
    r.commit();
    const out = await r.check();
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /No plugin changes/);
  });

  test('fails when an agent changes and the version does not', async (t) => {
    const r = repo(t);
    r.write('plugins/alpha/agents/lead.md', 'v2');
    r.commit();
    const out = await r.check();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /alpha: changed \(agents\/lead\.md\) but its version is 1\.2\.3, unchanged from 1\.2\.3/);
    assert.match(out.stderr, /plugins\/alpha\/meta\.json/);
  });

  test('passes once the version goes up', async (t) => {
    const r = repo(t);
    r.write('plugins/alpha/agents/lead.md', 'v2');
    r.bump('alpha', '1.2.4');
    r.commit();
    const out = await r.check();
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /alpha/);
  });

  test('compares versions numerically, not as text', async (t) => {
    const r = repo(t);
    r.write('plugins/beta/agents/lead.md', 'v2');
    r.bump('beta', '0.4.10'); // 0.4.10 > 0.4.9, though "0.4.10" < "0.4.9" as strings
    r.commit();
    assert.equal((await r.check()).status, 0);
  });

  test('a lower version is not a bump', async (t) => {
    const r = repo(t);
    r.write('plugins/alpha/agents/lead.md', 'v2');
    r.bump('alpha', '1.1.0');
    r.commit();
    const out = await r.check();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /not above/);
  });

  test('a README-only change needs no bump', async (t) => {
    const r = repo(t);
    r.write('plugins/alpha/README.md', '# better docs');
    r.commit();
    assert.equal((await r.check()).status, 0);
  });

  test('a script or template change does need one', async (t) => {
    const r = repo(t);
    r.write('plugins/beta/scripts/gate.mjs', 'export {}');
    r.write('plugins/beta/templates/x.md', 'x');
    r.commit();
    const out = await r.check();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /beta: changed \(scripts\/gate\.mjs, templates\/x\.md\)/);
  });

  test('each plugin is judged on its own', async (t) => {
    const r = repo(t);
    r.write('plugins/alpha/agents/lead.md', 'v2');
    r.write('plugins/beta/agents/lead.md', 'v2');
    r.bump('alpha', '1.3.0');
    r.commit();
    const out = await r.check();
    assert.equal(out.status, 1);
    assert.match(out.stderr, /beta:/);
    assert.equal(/alpha:/.test(out.stderr), false);
  });

  test('a brand-new plugin has nothing to compare with', async (t) => {
    const r = repo(t);
    r.write('plugins/gamma/meta.json', JSON.stringify({ name: 'gamma', version: '0.1.0' }));
    r.write('plugins/gamma/agents/new.md', 'x');
    r.commit();
    assert.equal((await r.check()).status, 0);
  });

  test('judges the whole branch, not just its last commit', async (t) => {
    const r = repo(t);
    r.write('plugins/alpha/agents/lead.md', 'v2');
    r.bump('alpha', '1.2.4');
    r.commit('first');
    r.write('plugins/alpha/agents/lead.md', 'v3');
    r.commit('second, no further bump');
    assert.equal((await r.check()).status, 0);
  });

  test('when main moves on, only what this branch changed counts', async (t) => {
    const r = repo(t);
    r.write('plugins/alpha/agents/lead.md', 'v2');
    r.bump('alpha', '1.2.4');
    r.commit();
    r.git('checkout', '-q', 'main');
    r.write('plugins/beta/agents/lead.md', 'changed on main by someone else');
    r.commit('main moves');
    r.git('checkout', '-q', 'change');
    assert.equal((await r.check()).status, 0);
  });

  test('says so when the base cannot be found', async (t) => {
    const r = repo(t);
    const out = await r.check(['--base', 'no-such-ref']);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /Could not diff against no-such-ref/);
  });
});
