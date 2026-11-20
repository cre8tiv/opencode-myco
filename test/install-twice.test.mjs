// Installing myco in two places, and removing an install. OpenCode loads the user's config and the project's
// .opencode both, and two copies of the plugin collide (a plugin failure in the TUI), so the installer and the
// doctor say so; --uninstall is how to get back to one. Run as the scripts are, in a sandbox home.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sandbox } from './helpers.mjs';
import { install, uninstall } from '../scripts/install.mjs';

const INSTALL = join(ROOT, 'scripts', 'install.mjs');

function setup(t) {
  const sb = sandbox(t);
  const config = join(sb.home, '.config');
  const global = join(config, 'opencode');
  const project = join(sb.project, '.opencode');
  const env = { ...process.env, ...sb.env, XDG_CONFIG_HOME: config };
  const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: sb.project, encoding: 'utf8', env });
  return { sb, global, project, env, run, installer: (...a) => run(INSTALL, ...a) };
}

describe('installed twice', () => {
  test('a second install says where the first is and how to remove it', (t) => {
    const { global, project, installer } = setup(t);
    let r = installer('--global');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /WARNING/, 'the first install has nothing to warn about');
    r = installer('--project');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`WARNING: myco is also installed in ${global.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(r.stdout.includes(`--uninstall --target "${global}"`), r.stdout);
    r = installer('--global');
    assert.ok(r.stdout.includes(`--uninstall --target "${project}"`), 'and the same from the other side');
  });

  test('an install somewhere else (--target) is not a second copy OpenCode would load', (t) => {
    const { sb, installer } = setup(t);
    installer('--global');
    const r = installer('--target', join(sb.root, 'elsewhere'));
    assert.doesNotMatch(r.stdout, /WARNING/);
  });

  test('the doctor fails on it, naming the copy to remove', (t) => {
    const { global, project, run, installer } = setup(t);
    installer('--global');
    let r = run(join(global, 'myco', 'team-ops', 'scripts', 'doctor.mjs'), '--no-live');
    assert.doesNotMatch(r.stdout, /duplicate/);
    installer('--project');
    r = run(join(global, 'myco', 'team-ops', 'scripts', 'doctor.mjs'), '--no-live');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /FAIL\s+duplicate/);
    assert.ok(r.stdout.includes(`--uninstall --target "${project}"`), r.stdout);
  });
});

describe('--uninstall', () => {
  test('removes what the install put there, and leaves the user\'s own agents, skills and model mapping', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    mkdirSync(join(target, 'agents', 'mine'), { recursive: true });
    writeFileSync(join(target, 'agents', 'mine', 'helper.md'), 'mine');
    mkdirSync(join(target, 'agents', 'engineering-team'), { recursive: true });
    writeFileSync(join(target, 'agents', 'engineering-team', 'my-own-role.md'), 'mine too');
    mkdirSync(join(target, 'skills', 'my-skill'), { recursive: true });
    writeFileSync(join(target, 'skills', 'my-skill', 'SKILL.md'), 'mine');
    writeFileSync(join(target, 'myco', 'models.json'), '{"lead":"x"}');

    const gone = uninstall({ target });
    assert.ok(gone && gone.removed.length > 20, 'agents, skills, scripts, the plugin');
    assert.ok(!existsSync(join(target, 'plugins', 'myco')));
    assert.ok(!existsSync(join(target, 'agents', 'engineering-team', 'tech-lead.md')));
    assert.ok(!existsSync(join(target, 'skills', 'init-team')));
    assert.ok(!existsSync(join(target, 'myco', 'install.json')));
    assert.ok(!existsSync(join(target, 'myco', 'team-ops')));
    assert.equal(readFileSync(join(target, 'agents', 'mine', 'helper.md'), 'utf8'), 'mine');
    assert.equal(readFileSync(join(target, 'agents', 'engineering-team', 'my-own-role.md'), 'utf8'), 'mine too', 'a user\'s agent in one of our team directories stays');
    assert.equal(readFileSync(join(target, 'skills', 'my-skill', 'SKILL.md'), 'utf8'), 'mine');
    assert.equal(readFileSync(join(target, 'myco', 'models.json'), 'utf8'), '{"lead":"x"}');
    assert.deepEqual(gone.kept, [join('myco', 'models.json')]);
  });

  test('a clean install leaves no directory behind', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    uninstall({ target });
    assert.ok(!existsSync(join(target, 'myco')));
    assert.ok(!existsSync(join(target, 'agents', 'engineering-team')));
  });

  test('a second run, or a directory with no install, removes nothing and says so', (t) => {
    const { sb, installer } = setup(t);
    const target = join(sb.root, 'out');
    installer('--target', target);
    let r = installer('--uninstall', '--target', target);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Removed myco from/);
    r = installer('--uninstall', '--target', target);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing to uninstall/);
    mkdirSync(join(sb.root, 'plain', 'agents'), { recursive: true });
    writeFileSync(join(sb.root, 'plain', 'agents', 'x.md'), 'x');
    r = installer('--uninstall', '--target', join(sb.root, 'plain'));
    assert.match(r.stdout, /Nothing to uninstall/);
    assert.ok(existsSync(join(sb.root, 'plain', 'agents', 'x.md')));
  });

  test('an install.json that names a path outside the install removes nothing', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    const file = join(target, 'myco', 'install.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.skills.push('../../victim');
    writeFileSync(file, JSON.stringify(record));
    mkdirSync(join(sb.root, 'victim'));
    assert.throws(() => uninstall({ target }), /not agent, skill or team names/);
    assert.ok(existsSync(join(sb.root, 'victim')));
    assert.ok(existsSync(join(target, 'plugins', 'myco')), 'nothing was removed');
  });

  test('--global removes the user-level install the installer wrote', (t) => {
    const { global, installer } = setup(t);
    installer('--global');
    assert.ok(existsSync(join(global, 'plugins', 'myco')));
    const r = installer('--uninstall', '--global');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(global, 'plugins', 'myco')));
  });
});
