// install.sh and install.ps1: the one-line install and update. Each is run against this repository's own
// HEAD (MYCO_REPO is a local path) in a sandbox home, so nothing reaches GitHub or the real config directory.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sandbox } from './helpers.mjs';

const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const has = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

/** The environment a script runs in: a sandbox home, the cache inside it, this repository as the source. */
function env(sb) {
  return { ...process.env, ...sb.env, XDG_CONFIG_HOME: '', MYCO_REPO: ROOT, MYCO_SRC: join(sb.root, 'src') };
}

/** What an install leaves, whichever script made it. */
function assertInstalled(dir, sb) {
  const record = JSON.parse(readFileSync(join(dir, 'myco', 'install.json'), 'utf8'));
  assert.equal(record.source, head(), 'installed from the commit asked for');
  assert.equal(record.sourceRepo, ROOT, 'and the record says where it came from');
  assert.ok(existsSync(join(dir, 'agents', 'engineering-team', 'tech-lead.md')));
  assert.ok(existsSync(join(dir, 'plugins', 'myco')));
  assert.ok(existsSync(join(sb.root, 'src', '.git')));
}

describe('install.sh', { skip: process.platform === 'win32' || !has('bash') }, () => {
  const run = (sb, ...args) => spawnSync('bash', [join(ROOT, 'install.sh'), ...args], { encoding: 'utf8', env: env(sb) });

  test('installs globally by default, and a second run updates in place', (t) => {
    const sb = sandbox(t);
    const global = join(sb.home, '.config', 'opencode');
    let r = run(sb, '--ref', 'HEAD');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Installed \d+ agents/);
    assertInstalled(global, sb);
    r = run(sb, '--ref=HEAD');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assertInstalled(global, sb);
  });

  test('passes the installer its options, and does not add --global when told --target', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    const r = run(sb, '--ref', 'HEAD', '--target', target);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assertInstalled(target, sb);
  });

  test('a ref that does not exist stops with a message and installs nothing', (t) => {
    const sb = sandbox(t);
    const r = run(sb, '--ref', 'no-such-ref');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not fetch 'no-such-ref'/);
    assert.ok(!existsSync(join(sb.home, '.config', 'opencode', 'myco')));
  });

  test('refuses a cache directory that is not a checkout, rather than writing into it', (t) => {
    const sb = sandbox(t);
    mkdirSync(join(sb.root, 'src'));
    writeFileSync(join(sb.root, 'src', 'precious.txt'), 'mine');
    const r = run(sb, '--ref', 'HEAD');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is not a myco checkout/);
    assert.equal(readFileSync(join(sb.root, 'src', 'precious.txt'), 'utf8'), 'mine');
  });

  test('says what is missing when Node is too old or absent', (t) => {
    const sb = sandbox(t);
    const bin = join(sb.root, 'bin');
    mkdirSync(bin);
    // git and a node that reports an old version, and nothing else on PATH but the shell's own tools.
    writeFileSync(join(bin, 'node'), '#!/bin/sh\n[ "$1" = "-p" ] && echo 20 && exit 0\necho v20.0.0\n', { mode: 0o755 });
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nexec "${gitPath}" "$@"\n`, { mode: 0o755 });
    const r = spawnSync('/bin/bash', [join(ROOT, 'install.sh'), '--ref', 'HEAD'], { encoding: 'utf8', env: { ...env(sb), PATH: `${bin}:/usr/bin:/bin` } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Node\.js 22 or newer is required \(found v20\.0\.0\)/);
  });
});

const PWSH = has('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']) ? 'pwsh' : has('powershell', ['-NoProfile', '-Command', '1']) ? 'powershell' : null;

describe('install.ps1', { skip: !PWSH }, () => {
  const run = (sb, ...args) => spawnSync(/** @type {string} */ (PWSH), ['-NoProfile', '-NonInteractive', '-File', join(ROOT, 'install.ps1'), ...args], { encoding: 'utf8', env: env(sb) });

  test('installs, and a second run updates in place', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    let r = run(sb, '-Ref', 'HEAD', '-Target', target);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assertInstalled(target, sb);
    r = run(sb, '-Ref', 'HEAD', '-Target', target);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assertInstalled(target, sb);
  });

  test('a ref that does not exist stops with a message', (t) => {
    const sb = sandbox(t);
    const r = run(sb, '-Ref', 'no-such-ref', '-Target', join(sb.root, 'out'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /could not fetch 'no-such-ref'/);
    assert.ok(!existsSync(join(sb.root, 'out', 'myco')));
  });

  test('refuses a cache directory that is not a checkout', (t) => {
    const sb = sandbox(t);
    mkdirSync(join(sb.root, 'src'));
    writeFileSync(join(sb.root, 'src', 'precious.txt'), 'mine');
    const r = run(sb, '-Ref', 'HEAD', '-Target', join(sb.root, 'out'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /is not a myco checkout/);
  });
});
