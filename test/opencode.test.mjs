// Checks the install against a real OpenCode: that it loads every agent as intended and
// that the plugin loads. The unit tests cover what the installer writes; only OpenCode
// can say how it reads it, and it is the one that forwards unknown frontmatter keys to
// the model provider.
//
// Opt in with MYCO_TEST_OPENCODE=1 (for example `MYCO_TEST_OPENCODE=1 npm test`). It needs the `opencode`
// binary and runs it with a throwaway HOME, so it neither reads nor changes your own
// OpenCode configuration, sessions or credentials.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, sandbox } from './helpers.mjs';
import { install } from '../scripts/install.mjs';

const enabled = process.env.MYCO_TEST_OPENCODE === '1' && spawnSync('opencode', ['--version']).status === 0;

/** A git project with the teams installed into it, and the environment to run OpenCode in. */
function project(t, models) {
  const sb = sandbox(t);
  const dir = join(sb.root, 'proj');
  mkdirSync(dir, { recursive: true });
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: 90000, ...opts });
  run('git', ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), 'x');
  run('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '-A']);
  run('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  install({ target: join(dir, '.opencode'), models });
  const env = { ...process.env, HOME: sb.home, USERPROFILE: sb.home, XDG_CONFIG_HOME: join(sb.home, '.config'), XDG_DATA_HOME: join(sb.home, '.local', 'share') };
  return { dir: realpathSync(dir), oc: (...args) => run('opencode', [...args, '--standalone'], { env }) };
}

describe('installed into OpenCode', { skip: !enabled && 'set MYCO_TEST_OPENCODE=1 and have opencode on PATH' }, () => {
  test('every team agent loads under its team/role name, with the intended mode and permissions', (t) => {
    const { oc } = project(t, { tiers: { reasoning: 'test/model#medium' } });
    const r = oc('debug', 'agents');
    assert.equal(r.status, 0, r.stderr);
    const agents = new Map(JSON.parse(r.stdout).map((a) => [a.id, a]));
    const team = [...agents.keys()].filter((id) => id.includes('/'));
    assert.equal(team.length, 11, team.join(', '));

    assert.equal(agents.get('engineering-team/tech-lead').mode, 'primary');
    assert.equal(agents.get('engineering-team/ic-generalist').mode, 'subagent');

    const rules = (id, action) => agents.get(id).permissions.filter((p) => p.action === action).map((p) => `${p.resource}=${p.effect}`);
    assert.deepEqual(rules('engineering-team/code-reviewer', 'edit'), ['*=deny']);
    // The last matching rule wins, so the deny comes first and both path forms allow after it.
    assert.deepEqual(rules('team-ops/agent-coach', 'edit'), ['*=deny', '.claude/ops/reports/**=allow', '*/.claude/ops/reports/**=allow']);

    assert.deepEqual(agents.get('design-team/architect').model, { id: 'model', providerID: 'test', variant: 'medium' });
  });

  test('the merge backstop is compiled into every team agent and decides as documented', (t) => {
    const { oc } = project(t);
    const agents = JSON.parse(oc('debug', 'agents').stdout).filter((a) => a.id.includes('/'));
    assert.equal(agents.length, 11);
    for (const a of agents) {
      const shell = a.permissions.filter((p) => p.action === 'shell').map((p) => `${p.resource}=${p.effect}`);
      assert.deepEqual(shell.slice(-2), ['gh pr merge*=deny', 'gh * pr merge*=deny'], a.id);
    }

    // Give OpenCode's own permission engine the compiled rules and ask it about commands: no model involved.
    const rules = agents.find((a) => a.id === 'engineering-team/ic-generalist').permissions;
    const id = JSON.parse(oc('api', 'POST', '/api/session', '-d', JSON.stringify({ title: 'myco-test', permissions: rules })).stdout).data.id;
    t.after(() => oc('session', 'delete', id));
    const decide = (command) => JSON.parse(oc('api', 'POST', `/api/session/${id}/permission`, '-d', JSON.stringify({ action: 'shell', resources: [command] })).stdout).data.effect;
    assert.equal(decide('gh pr merge 5'), 'deny');
    assert.equal(decide('gh pr merge 5 --squash'), 'deny');
    assert.equal(decide('gh --repo o/r pr merge 5'), 'deny');
    assert.equal(decide('gh pr view 5'), 'allow');
    assert.equal(decide('echo gh pr merge'), 'allow', 'a command that merely mentions it is not a merge');
    // What the backstop does not cover, which the plugin's guard does: the guard is the real check.
    assert.equal(decide('bash -c "gh pr merge 1"'), 'allow');
    // The rule sees the command as the last plugin to rewrite it left it, so a wrapped merge gets past it; the guard looks through wrappers.
    assert.equal(decide("'/opt/homebrew/bin/node' '/opt/homebrew/bin/caveman' shrink -- gh pr merge 5"), 'allow');
    assert.equal(decide('git push origin main'), 'allow');
  });

  test('start_work and log_friction are offered to agents as tools', async (t) => {
    // No tool-listing endpoint exists, so a probe plugin asks the host from a hook that runs while the
    // server is handling a request, after every plugin has set up.
    const { dir, oc } = project(t);
    mkdirSync(join(dir, '.opencode', 'plugins', 'toolprobe'), { recursive: true });
    const out = join(dir, 'tools.json');
    writeFileSync(join(dir, '.opencode', 'plugins', 'toolprobe', 'index.js'),
      'import { writeFileSync } from "node:fs";\n' +
      'export default { id: "toolprobe", async setup(ctx) { await ctx.shell.hook("create.before", async () => {\n' +
      '  try { const l = await ctx.tool.list(); const a = Array.isArray(l) ? l : (l.data || l.items || Object.values(l));\n' +
      '    writeFileSync(' + JSON.stringify(out) + ', JSON.stringify(a.map((x) => (typeof x === "string" ? x : x.name || x.id))));\n' +
      '  } catch (e) { writeFileSync(' + JSON.stringify(out) + ', JSON.stringify({ error: String(e) })); }\n' +
      '}); } };\n');
    const id = JSON.parse(oc('api', 'POST', '/api/session', '-d', '{"title":"myco-test"}').stdout).data.id;
    t.after(() => oc('session', 'delete', id));
    oc('api', 'POST', `/api/session/${id}/shell`, '-d', JSON.stringify({ command: 'echo hi' }));
    let names;
    for (let i = 0; i < 40 && !names; i++) {
      try { names = JSON.parse(readFileSync(out, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(Array.isArray(names), JSON.stringify(names));
    for (const tool of ['start_work', 'log_friction']) assert.ok(names.includes(tool), `${tool} is not among ${names.join(', ')}`);
  });

  test('no Claude Code key reaches the provider request', (t) => {
    const { oc } = project(t);
    const agents = JSON.parse(oc('debug', 'agents').stdout).filter((a) => a.id.includes('/'));
    assert.equal(agents.length, 11);
    for (const a of agents) assert.deepEqual(a.request.body, {}, `${a.id} would send ${JSON.stringify(a.request.body)}`);
  });

  test('the plugin loads and gives commands MYCO_ROOT', (t) => {
    const { dir, oc } = project(t);
    const created = JSON.parse(oc('api', 'POST', '/api/session', '-d', '{"title":"myco-test"}').stdout);
    const id = created.data.id;
    t.after(() => oc('session', 'delete', id));
    const sh = oc('api', 'POST', `/api/session/${id}/shell`, '-d', JSON.stringify({ command: 'echo ROOT=$MYCO_ROOT' }));
    assert.equal(sh.status, 0, sh.stderr);
    // The shell runs in the background; wait for it to exit.
    let out;
    for (let i = 0; i < 20 && out === undefined; i++) {
      const shell = JSON.parse(oc('api', 'GET', `/api/session/${id}/message`).stdout).data.find((m) => m.type === 'shell');
      if (shell?.status === 'exited') out = shell.output.output;
    }
    assert.equal(out?.trim(), `ROOT=${join(dir, '.opencode', 'myco')}`);
  });

  test('a global install runs one plugin instance per location, each knowing its own directory', (t) => {
    // The merge gate reads the project profile from the directory its plugin instance runs in. That is
    // only right if a session located elsewhere, such as an isolated worktree, is served by an instance
    // whose directory is that location. A probe plugin beside ours records where each instance runs.
    const sb = sandbox(t);
    const config = join(sb.home, '.config', 'opencode');
    install({ target: config });
    mkdirSync(join(config, 'plugins', 'locprobe'), { recursive: true });
    writeFileSync(join(config, 'plugins', 'locprobe', 'index.js'),
      'import { appendFileSync } from "node:fs";\n' +
      'export default { id: "locprobe", async setup(ctx) { appendFileSync(process.env.HOME + "/loc.log", ctx.location.directory + "\\n"); } };\n');
    const dir = join(sb.root, 'proj');
    mkdirSync(dir, { recursive: true });
    const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: 90000, env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, XDG_CONFIG_HOME: join(sb.home, '.config'), XDG_DATA_HOME: join(sb.home, '.local', 'share') } });
    const git = (...a) => run('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...a]);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const api = (...args) => JSON.parse(run('opencode', ['api', '--standalone', ...args]).stdout);
    const shellOutput = (session) => {
      for (let i = 0; i < 20; i++) {
        const m = api('GET', `/api/session/${session}/message`).data.find((x) => x.type === 'shell');
        if (m?.status === 'exited') return m.output.output;
      }
      return undefined;
    };

    const main = api('POST', '/api/session', '-d', '{"title":"main"}').data.id;
    run('opencode', ['api', '--standalone', 'POST', `/api/session/${main}/shell`, '-d', '{"command":"echo main"}']);
    assert.ok(shellOutput(main) !== undefined);
    const project = api('GET', '/api/project').find((p) => realpathSync(p.canonical || '.') === realpathSync(dir));
    const worktree = api('POST', '/api/worktree', '-d', JSON.stringify({ projectID: project.id, name: 'wt' })).directory;
    const located = api('POST', '/api/session', '-d', JSON.stringify({ title: 'wt', location: { directory: worktree } })).data.id;
    run('opencode', ['api', '--standalone', 'POST', `/api/session/${located}/shell`, '-d', JSON.stringify({ command: 'echo ROOT=$MYCO_ROOT' })]);
    const out = shellOutput(located);

    const seen = new Set(readFileSync(join(sb.home, 'loc.log'), 'utf8').split('\n').filter(Boolean).map((p) => realpathSync(p)));
    assert.ok(seen.has(realpathSync(dir)), 'an instance runs in the project directory');
    assert.ok(seen.has(realpathSync(worktree)), 'a session located in a worktree gets an instance in the worktree');
    assert.match(out, /ROOT=.*[\\/]myco/, 'and that instance is the one serving it');
  });
});
