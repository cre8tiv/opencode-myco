// The doctor exists for failures that make no noise: a plugin that did not load, a guard whose code
// did not, agents that cannot be seen from a worktree. These break an install one way at a time and
// check that it says so, against a stand-in OpenCode for the live checks. The real thing is in
// opencode.test.mjs. A few tests tie the doctor's lists to the source so they cannot drift from it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { ROOT, sandbox } from './helpers.mjs';
import { install } from '../scripts/install.mjs';
import { CORES, FEATURES, PLUGIN_FILES, checkInstall, checkLive, checkModelMapping, checkProject, format, loadFailureFromLog } from '../plugins/team-ops/scripts/doctor.mjs';

const read = (p) => readFileSync(p, 'utf8');
const levels = (results) => results.map((x) => x.level);
const find = (results, area) => results.find((x) => x.area === area);

/** A global-style install in a sandbox, with HOME pointed at it (the event stream lives under HOME). */
function installed(t, opts = {}) {
  const sb = sandbox(t);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = sb.home;
  process.env.USERPROFILE = sb.home;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const config = join(sb.home, '.config', 'opencode');
  install({ target: config, ...opts });
  return { sb, config, root: join(config, 'myco'), agent: (id) => join(config, 'agents', `${id}.md`) };
}

describe('the files', () => {
  test('a healthy install reports nothing wrong', (t) => {
    const { root } = installed(t);
    const out = checkInstall({ root });
    assert.deepEqual(levels(out).filter((l) => l === 'fail' || l === 'warn'), []);
    assert.match(find(out, 'install').message, /team-ops \d+\.\d+\.\d+/);
    assert.match(find(out, 'agents').message, /all 11 installed/);
  });

  test('a missing agent, skill, plugin file or core is a failure, each named', (t) => {
    const { root, config, agent } = installed(t);
    rmSync(agent('engineering-team/code-reviewer'));
    rmSync(join(config, 'skills', 'log-friction'), { recursive: true });
    rmSync(join(config, 'plugins', 'myco', 'guards.js'));
    rmSync(join(root, 'engineering-team', 'scripts', 'merge-gate-core.mjs'));
    const out = checkInstall({ root });
    assert.match(find(out, 'agents').message, /1 of 11.*engineering-team\/code-reviewer/);
    assert.match(find(out, 'skills').message, /log-friction/);
    assert.match(find(out, 'plugin').message, /guards\.js/);
    assert.match(find(out, 'cores').message, /engineering-team\/merge-gate-core\.mjs/);
    for (const area of ['agents', 'skills', 'plugin', 'cores']) assert.equal(find(out, area).level, 'fail', area);
    assert.match(find(out, 'agents').fix, /Reinstall/);
  });

  test('an install.json that is corrupt is not described as a missing one', (t) => {
    const { root } = installed(t);
    writeFileSync(join(root, 'install.json'), '{"installedAt":');
    const out = find(checkInstall({ root }), 'install');
    assert.equal(out.level, 'warn');
    assert.match(out.message, /install\.json is not valid JSON/);
    assert.doesNotMatch(out.message, /older installer/);
  });

  test('an install with no install.json is a warning, not a failure', (t) => {
    const { root } = installed(t);
    rmSync(join(root, 'install.json'));
    const out = checkInstall({ root });
    assert.equal(find(out, 'install').level, 'warn');
    assert.equal(find(out, 'agents').level, 'ok');
  });
});

describe('the merge backstop', () => {
  test('on everywhere, and off everywhere, are both fine and say which', (t) => {
    const on = installed(t);
    assert.match(find(checkInstall({ root: on.root }), 'backstop').message, /every agent denies gh pr merge natively/);
    const off = installed(t, { mergeBackstop: false });
    assert.match(find(checkInstall({ root: off.root }), 'backstop').message, /off: agents may merge/);
    assert.equal(find(checkInstall({ root: off.root }), 'backstop').level, 'info');
  });

  test('in some agents only means somebody edited them', (t) => {
    const { root, agent } = installed(t);
    writeFileSync(agent('design-team/architect'), read(agent('design-team/architect')).replace(/^ {4}"gh pr merge\*": deny\n/m, '').replace(/^ {4}"gh \* pr merge\*": deny\n/m, '').replace(/permission:\n {2}shell:\n/, ''));
    const out = checkInstall({ root });
    assert.equal(find(out, 'backstop').level, 'warn');
    assert.match(find(out, 'backstop').message, /10 of 11/);
  });

  test('install.json disagreeing with the agents is a warning', (t) => {
    const { root } = installed(t);
    const file = join(root, 'install.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file)), mergeBackstop: false }));
    assert.match(find(checkInstall({ root }), 'backstop').message, /install\.json says the backstop is off, but the agents have it/);
  });
});

describe('the project', () => {
  const profile = (dir, text) => {
    mkdirSync(join(dir, '.claude', 'team'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'team', 'project.md'), `---\n${text}\n---\n`);
  };

  test('a project that allows merging, next to an install that forbids it, is a warning with the remedy', (t) => {
    const { root, sb } = installed(t);
    profile(sb.project, 'merge_policy: autonomous\nstream: alpha');
    const p = find(checkProject({ cwd: sb.project, root }), 'project');
    assert.equal(p.level, 'warn');
    assert.match(p.message, /autonomous.*blocked regardless/);
    assert.match(p.fix, /--allow-autonomous-merge/);
  });

  test('the same project with an install that allows it is fine', (t) => {
    const { root, sb } = installed(t, { mergeBackstop: false });
    profile(sb.project, 'merge_policy: autonomous\nstream: alpha');
    assert.equal(find(checkProject({ cwd: sb.project, root }), 'project').level, 'ok');
  });

  test('no profile is gated by default, and a gated project is fine', (t) => {
    const { root, sb } = installed(t);
    assert.match(find(checkProject({ cwd: sb.project, root }), 'project').message, /gated by default/);
    profile(sb.project, 'merge_policy: human-approval\nstream: alpha');
    assert.match(find(checkProject({ cwd: sb.project, root }), 'project').message, /human-approval/);
  });

  test('a stream that can be written is fine, and one that cannot is a failure', (t) => {
    const { root, sb } = installed(t);
    profile(sb.project, 'stream: alpha');
    assert.equal(find(checkProject({ cwd: sb.project, root }), 'stream').level, 'ok');
    // Where the stream lives is a file, so the directory cannot be made.
    rmSync(join(sb.home, '.claude'), { recursive: true, force: true });
    writeFileSync(join(sb.home, '.claude'), 'not a directory');
    const bad = find(checkProject({ cwd: sb.project, root }), 'stream');
    assert.equal(bad.level, 'fail');
    assert.match(bad.message, /cannot be written/);
  });
});

describe('the model mapping', () => {
  test('no mapping is information, not a warning: it is a choice, and every fresh install has it', (t) => {
    const { root } = installed(t);
    const out = checkModelMapping({ root, catalog: null });
    assert.deepEqual(levels(out), ['info']);
    assert.match(out[0].message, /no mapping: every agent uses your default model, so reviewers and QA share a model with the ICs/);
    // A file that holds nothing useful is the same as none.
    writeFileSync(join(root, 'models.json'), 'null');
    assert.deepEqual(levels(checkModelMapping({ root, catalog: null })), ['info']);
    writeFileSync(join(root, 'models.json'), '{}');
    assert.deepEqual(levels(checkModelMapping({ root, catalog: null })), ['info']);
  });

  test('a good mapping has no problems, and one that puts reviewers with the ICs is a warning', (t) => {
    const { root } = installed(t);
    writeFileSync(join(root, 'models.json'), JSON.stringify({ tiers: { worker: 'p/a', reasoning: 'p/b' } }));
    assert.deepEqual(levels(checkModelMapping({ root, catalog: null })), ['ok']);
    writeFileSync(join(root, 'models.json'), JSON.stringify({ tiers: { worker: 'p/a', reasoning: 'p/a' } }));
    const out = checkModelMapping({ root, catalog: null });
    assert.deepEqual(levels(out), ['warn']);
    assert.match(out[0].message, /same model as the ICs \(p\/a\)/);
  });

  test('a models.json that is corrupt is a failure that says the mapping is being ignored, not "no mapping"', (t) => {
    const { root } = installed(t);
    // Truncated, as a half-written or hand-edited file might be.
    writeFileSync(join(root, 'models.json'), '{"tiers":{"lead":"p/a"');
    const out = checkModelMapping({ root, catalog: null });
    assert.deepEqual(levels(out), ['fail']);
    assert.match(out[0].message, /not valid JSON, so your model mapping is being ignored/);
    assert.match(out[0].fix, /init-models/);
  });

  test('valid JSON that is not a valid mapping is a different failure', (t) => {
    const { root } = installed(t);
    writeFileSync(join(root, 'models.json'), '{"tiers":{"lead":"not-a-model"}}');
    const bad = checkModelMapping({ root, catalog: null });
    assert.equal(bad[0].level, 'fail');
    assert.match(bad[0].message, /not valid: .*not provider\/model/);
    writeFileSync(join(root, 'models.json'), '{"tiers":{"nope":"p/a"}}');
    assert.match(checkModelMapping({ root, catalog: null })[0].message, /unknown tier/);
  });

  test('a model OpenCode does not list is a warning', (t) => {
    const { root } = installed(t);
    writeFileSync(join(root, 'models.json'), JSON.stringify({ tiers: { worker: 'p/real', reasoning: 'p/ghost' } }));
    const out = checkModelMapping({ root, catalog: [{ providerID: 'p', modelID: 'real', limit: { context: 1e6 }, variants: [] }] });
    assert.ok(out.some((x) => x.level === 'warn' && /p\/ghost/.test(x.message)));
  });
});

/**
 * A stand-in for the `opencode` command: it answers what checkLive asks, as configured.
 * @param {{root: string, version?: string, agents?: string[], created?: boolean, reported?: string | null, logDir?: string}} o
 */
function fakeOpencode(o) {
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
    const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
    if (o.version === null) return { status: 127, stdout: '', stderr: '' };
    if (args[0] === '--version') return ok(o.version ?? 'opencode v9.9.9');
    if (args[0] === 'debug' && args[1] === 'agents') return ok(JSON.stringify((o.agents ?? []).map((id) => ({ id }))));
    if (args[0] === 'debug' && args[1] === 'paths') return ok(`home   /h\nlog    ${o.logDir ?? '/nowhere'}\n`);
    if (args[0] === 'session') return ok('');
    if (args[0] === 'api') {
      const [, , method, path] = args;
      if (method === 'POST' && path === '/api/session') return ok(o.created === false ? '{}' : JSON.stringify({ data: { id: 'ses_doctor' } }));
      if (method === 'POST' && /\/shell$/.test(path)) return ok('{}');
      if (method === 'GET') return ok(JSON.stringify({ data: [{ type: 'shell', status: 'exited', output: { output: o.reported ?? '' } }] }));
    }
    return ok('');
  };
  return { exec, calls };
}

const ALL_AGENTS = (t, root) => Object.keys(JSON.parse(read(join(root, 'install.json'))).agents.reduce((m, id) => ({ ...m, [id]: 1 }), {}));

describe('against a running OpenCode', () => {
  const healthy = (root) => `MYCO_ROOT=${root} MYCO_FEATURES=${FEATURES.join(',')}`;

  test('a healthy install passes every live check, and the session it opened is deleted', (t) => {
    const { root, sb } = installed(t);
    const f = fakeOpencode({ root, agents: ALL_AGENTS(t, root), reported: healthy(root) });
    const out = checkLive({ cwd: sb.project, root, exec: f.exec });
    assert.deepEqual(levels(out), ['ok', 'ok', 'ok', 'ok']);
    assert.match(find(out, 'features').message, /capture, coach-guard, merge-gate, start_work, log_friction/);
    assert.ok(f.calls.some((c) => c === 'session delete ses_doctor --standalone'), 'the session is cleaned up');
  });

  test('no opencode on PATH is a warning, nothing more', (t) => {
    const { root, sb } = installed(t);
    const out = checkLive({ cwd: sb.project, root, exec: fakeOpencode({ root, version: null }).exec });
    assert.deepEqual(levels(out), ['warn']);
    assert.match(out[0].message, /not found on PATH/);
  });

  test('a plugin that loaded but lost a guard is a failure naming the guard and the code behind it', (t) => {
    const { root, sb } = installed(t);
    const without = FEATURES.filter((f) => f !== 'merge-gate').join(',');
    const f = fakeOpencode({ root, agents: ALL_AGENTS(t, root), reported: `MYCO_ROOT=${root} MYCO_FEATURES=${without}` });
    const out = checkLive({ cwd: sb.project, root, exec: f.exec });
    const gate = find(out, 'merge-gate');
    assert.equal(gate.level, 'fail');
    assert.match(gate.message, /merge-gate-core\.mjs did not load.*silently absent/);
    assert.equal(find(out, 'plugin (live)').level, 'ok', 'the plugin itself loaded');
    assert.equal(find(out, 'features'), undefined);
  });

  test('a plugin that never loaded is a failure, whatever else is fine', (t) => {
    const { root, sb } = installed(t);
    const f = fakeOpencode({ root, agents: ALL_AGENTS(t, root), reported: 'MYCO_ROOT= MYCO_FEATURES=' });
    const out = checkLive({ cwd: sb.project, root, exec: f.exec });
    const p = find(out, 'plugin (live)');
    assert.equal(p.level, 'fail');
    assert.match(p.message, /did not load/);
    assert.match(p.fix, /without the guards/);
    assert.equal(out.filter((x) => FEATURES.includes(x.area)).length, 0, 'no per-feature noise when nothing loaded');
  });

  test('another install\'s plugin answering is a warning that says which', (t) => {
    const { root, sb } = installed(t);
    const f = fakeOpencode({ root, agents: ALL_AGENTS(t, root), reported: `MYCO_ROOT=/somewhere/else/myco MYCO_FEATURES=${FEATURES.join(',')}` });
    const p = find(checkLive({ cwd: sb.project, root, exec: f.exec }), 'plugin (live)');
    assert.equal(p.level, 'warn');
    assert.match(p.message, /\/somewhere\/else\/myco/);
  });

  test('agents that cannot be seen are a failure, and in a git worktree it says why', (t) => {
    const { root, sb } = installed(t);
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...a], { cwd: sb.project, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(sb.project, 'a.txt'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'i');
    const wt = join(sb.root, 'wt');
    git('worktree', 'add', '-q', wt, '-b', 'wt');
    const f = fakeOpencode({ root, agents: ['build', 'general'], reported: healthy(root) });
    const inWorktree = find(checkLive({ cwd: wt, root, exec: f.exec }), 'agents (live)');
    assert.equal(inWorktree.level, 'fail');
    assert.match(inWorktree.message, /11 team agents are not visible.*\(a git worktree\)/);
    assert.match(inWorktree.fix, /--global.*commit \.opencode/);
    const inMain = find(checkLive({ cwd: sb.project, root, exec: f.exec }), 'agents (live)');
    assert.equal(inMain.level, 'fail');
    assert.doesNotMatch(inMain.message, /worktree/);
  });

  test('being unable to open a session is a warning and not a crash', (t) => {
    const { root, sb } = installed(t);
    const out = checkLive({ cwd: sb.project, root, exec: fakeOpencode({ root, agents: ALL_AGENTS(t, root), created: false }).exec });
    assert.equal(find(out, 'plugin (live)').level, 'warn');
  });
});

describe('the reason a plugin failed to load, from OpenCode\'s log', () => {
  const NOW = Date.parse('2026-11-04T12:00:00Z');
  const PLUGIN = '/home/u/.config/opencode/plugins/myco';
  /** A log directory holding the given lines, and an exec that points at it. */
  const logged = (t, lines) => {
    const sb = sandbox(t);
    mkdirSync(join(sb.root, 'log'), { recursive: true });
    writeFileSync(join(sb.root, 'log', 'opencode.log'), lines.join('\n') + '\n');
    return fakeOpencode({ root: '/x', logDir: join(sb.root, 'log') }).exec;
  };
  const line = (iso, plugin, cause) => `timestamp=${iso} level=WARN run=1 message="failed to load plugin" target=${plugin} ref=err_1 cause="${cause}"`;

  test('a recent failure of this plugin is reported with its cause', (t) => {
    const exec = logged(t, [line('2026-11-04T11:59:30.000Z', PLUGIN, 'SyntaxError: nope')]);
    assert.match(loadFailureFromLog(exec, '/', PLUGIN, NOW), /SyntaxError: nope/);
  });

  test('an old failure, or another install\'s, is not this one\'s cause', (t) => {
    const exec = logged(t, [line('2026-11-04T09:00:00.000Z', PLUGIN, 'old problem'), line('2026-11-04T11:59:50.000Z', '/other/place/plugins/myco', 'someone else\'s problem')]);
    assert.equal(loadFailureFromLog(exec, '/', PLUGIN, NOW), null);
  });

  test('no log, or no line, is nothing to say', (t) => {
    assert.equal(loadFailureFromLog(fakeOpencode({ root: '/x', logDir: '/does/not/exist' }).exec, '/', PLUGIN, NOW), null);
    assert.equal(loadFailureFromLog(logged(t, ['timestamp=2026-11-04T11:59:59.000Z level=INFO message="all good"']), '/', PLUGIN, NOW), null);
  });
});

describe('the command line', () => {
  const DOCTOR = (config) => join(config, 'myco', 'team-ops', 'scripts', 'doctor.mjs');
  const run = (config, sb, ...args) => spawnSync(process.execPath, [DOCTOR(config), '--no-live', '--cwd', sb.project, ...args], { encoding: 'utf8', env: { ...process.env, ...sb.env, MYCO_MODELS_CATALOG: 'none' } });

  test('exits 0 on a healthy install, 1 on a broken one, and says what is wrong', (t) => {
    const { config, sb, agent } = installed(t);
    const ok = run(config, sb);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.match(ok.stdout, /^ok {4}install: /m);
    assert.match(ok.stdout, /everything checks out/);
    assert.doesNotMatch(ok.stdout, /^warn /m, 'a fresh install has no warnings, or the doctor would be ignored');
    rmSync(agent('design-team/architect'));
    const bad = run(config, sb);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^FAIL {2}agents: 1 of 11 agents are not installed: design-team\/architect/m);
    assert.match(bad.stdout, /fix: Reinstall/);
    assert.match(bad.stdout, /1 problem, /);
  });

  test('--json prints the results for a program to read', (t) => {
    const { config, sb } = installed(t);
    const r = run(config, sb, '--json');
    const list = JSON.parse(r.stdout);
    assert.ok(list.every((x) => x.level && x.area && x.message));
    assert.ok(list.some((x) => x.area === 'live' && x.level === 'info'), '--no-live is said, not silent');
  });

  test('works through a symlinked path, like the other scripts', (t) => {
    const { config, sb } = installed(t);
    const { symlinkSync } = require_fs();
    const link = join(sb.root, 'link');
    try {
      symlinkSync(join(config, '..'), link, 'dir'); // <home>/.config
    } catch (e) {
      return t.skip(`cannot create a symlink here: ${e.code}`);
    }
    const r = spawnSync(process.execPath, [join(link, 'opencode', 'myco', 'team-ops', 'scripts', 'doctor.mjs'), '--no-live', '--cwd', sb.project], { encoding: 'utf8', env: { ...process.env, ...sb.env, MYCO_MODELS_CATALOG: 'none' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /install: /);
  });

  test('refuses to run from the source tree, where nothing is installed', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'plugins', 'team-ops', 'scripts', 'doctor.mjs'), '--no-live'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not an installed copy/);
  });

  test('format counts problems and warnings', () => {
    const text = format([{ level: 'fail', area: 'a', message: 'm', fix: 'f' }, { level: 'fail', area: 'b', message: 'm' }, { level: 'warn', area: 'c', message: 'm' }, { level: 'ok', area: 'd', message: 'm' }]);
    assert.match(text, /^FAIL {2}a: m\n {6}fix: f$/m);
    assert.match(text, /2 problems, 1 warning$/);
    assert.match(format([{ level: 'ok', area: 'd', message: 'm' }]), /everything checks out$/);
  });
});

// node:fs's symlinkSync, kept out of the import list above so the Windows skip reads in one place.
import * as fsAll from 'node:fs';
const require_fs = () => fsAll;

describe('the doctor\'s lists match the source', () => {
  test('the plugin files it expects are the files the plugin is made of', () => {
    const actual = readdirSync(join(ROOT, 'opencode-plugin', 'myco')).sort();
    assert.deepEqual([...PLUGIN_FILES].sort(), actual);
  });

  test('every core it expects exists in its team\'s scripts', () => {
    for (const [team, file] of CORES) assert.ok(existsSync(join(ROOT, 'plugins', team, 'scripts', file)), `${team}/${file}`);
  });

  test('every feature it expects, and no other, is one the plugin reports', () => {
    const plugin = read(join(ROOT, 'opencode-plugin', 'myco', 'index.js'));
    const reported = [...plugin.matchAll(/features\.push\('([\w-]+)'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual([...FEATURES].sort(), reported);
  });

  test('the plugin reports its features through MYCO_FEATURES, where a command can read them', () => {
    assert.match(read(join(ROOT, 'opencode-plugin', 'myco', 'index.js')), /MYCO_FEATURES: features\.join\(','\)/);
  });
});
