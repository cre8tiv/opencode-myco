// scripts/migrate-paths.mjs: moves the team files off .claude/ and nothing else.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, runNode } from './helpers.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'migrate-paths.mjs');
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
const git = (cwd, ...a) => execFileSync('git', [...GIT, ...a], { cwd, encoding: 'utf8' });
const put = (root, rel, text = 'x') => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** A committed project with a profile naming its stream, a QA library, a report, one file that is not ours, and an old stream. */
function project(t, { commit = true } = {}) {
  const sb = sandbox(t);
  const p = sb.project;
  git(p, 'init', '-q', '-b', 'main');
  put(p, '.claude/team/project.md', '---\nstream: alpha-stream\n---\n');
  put(p, '.claude/team/knowledge.md');
  put(p, '.claude/qa/INDEX.md');
  put(p, '.claude/qa/runs/r1/report.md', 'Verdict: Pass');
  put(p, '.claude/ops/reports/2026-01-01-agent-health.md');
  put(p, '.claude/settings.json', '{}');
  if (commit) {
    git(p, 'add', '-A');
    git(p, 'commit', '-q', '-m', 'init');
  }
  const stream = join(sb.home, '.claude', 'ops', 'alpha-stream');
  put(stream, 'events.jsonl', '{"a":1}\n');
  put(stream, 'usage.jsonl', '{"b":2}\n');
  const env = { ...sb.env, XDG_DATA_HOME: join(sb.home, '.local', 'share') };
  const run = (...args) => runNode(SCRIPT, { args: ['--project', p, ...args], env });
  return { sb, p, stream, newStream: join(env.XDG_DATA_HOME, 'myco', 'ops', 'alpha-stream'), env, run };
}

describe('migrate-paths', () => {
  test('moves the team files, the QA library, the reports and the stream, and says what to do next', async (t) => {
    const { p, stream, newStream, run } = project(t);
    const r = await run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const f of ['.myco/team/project.md', '.myco/team/knowledge.md', '.myco/qa/INDEX.md', '.myco/qa/runs/r1/report.md', '.myco/ops/reports/2026-01-01-agent-health.md']) {
      assert.ok(existsSync(join(p, f)), f);
    }
    for (const gone of ['.claude/team', '.claude/qa', '.claude/ops']) assert.ok(!existsSync(join(p, gone)), gone);
    assert.equal(readFileSync(join(newStream, 'usage.jsonl'), 'utf8'), '{"b":2}\n');
    assert.ok(existsSync(join(stream, 'usage.jsonl')), 'the old stream is left for the person to delete');
    assert.match(r.stdout, /Commit the renames/);
    assert.match(r.stdout, /Delete it yourself/);
  });

  test('tracked files move as renames, so history follows them', async (t) => {
    const { p, run } = project(t);
    await run();
    assert.match(git(p, 'status', '--porcelain'), /R {2}\.claude\/team\/project\.md -> \.myco\/team\/project\.md/);
  });

  test('leaves everything else in .claude alone', async (t) => {
    const { p, run } = project(t);
    await run();
    assert.equal(readFileSync(join(p, '.claude/settings.json'), 'utf8'), '{}');
  });

  test('a project that was never committed is moved with a plain rename', async (t) => {
    const { p, run } = project(t, { commit: false });
    const r = await run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(p, '.myco/team/project.md')));
    assert.ok(!existsSync(join(p, '.claude/team')));
  });

  test('--dry-run says what would move and moves nothing', async (t) => {
    const { p, newStream, run } = project(t);
    const r = await run('--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would move \.claude\/team -> \.myco\/team/);
    assert.match(r.stdout, /would copy /);
    assert.ok(existsSync(join(p, '.claude/team/project.md')));
    assert.ok(!existsSync(join(p, '.myco')));
    assert.ok(!existsSync(newStream));
  });

  test('a second run finds nothing to do', async (t) => {
    const { run } = project(t);
    await run();
    const r = await run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing to migrate/);
  });

  test('stops, changing nothing, when a destination already exists', async (t) => {
    const { p, run } = project(t);
    put(p, '.myco/team/project.md', 'newer');
    const r = await run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /\.myco\/team already exists/);
    assert.ok(existsSync(join(p, '.claude/qa/INDEX.md')), 'the other moves did not happen either');
    assert.equal(readFileSync(join(p, '.myco/team/project.md'), 'utf8'), 'newer');
  });

  test('stops when a tracked file to be moved has uncommitted changes', async (t) => {
    const { p, run } = project(t);
    put(p, '.claude/qa/INDEX.md', 'edited');
    const r = await run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /\.claude\/qa has uncommitted changes/);
    assert.ok(existsSync(join(p, '.claude/team/project.md')));
  });

  test('an untracked file inside a tracked directory moves with it', async (t) => {
    const { p, run } = project(t);
    put(p, '.claude/qa/runs/r2/notes.md', 'new');
    const r = await run();
    assert.equal(r.status, 0, r.stdout);
    assert.ok(existsSync(join(p, '.myco/qa/runs/r2/notes.md')));
  });

  test('names the stream by the profile, or by the directory when the profile names none', async (t) => {
    const { p, sb, env } = project(t);
    put(p, '.claude/team/project.md', '---\ntrunk_branch: main\n---\n');
    git(p, 'add', '-A');
    git(p, 'commit', '-q', '-m', 'no stream key');
    put(sb.home, '.claude/ops/proj-alpha/events.jsonl');
    const r = await runNode(SCRIPT, { args: ['--project', p], env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(env.XDG_DATA_HOME, 'myco', 'ops', 'proj-alpha', 'events.jsonl')));
    assert.ok(!existsSync(join(env.XDG_DATA_HOME, 'myco', 'ops', 'alpha-stream')), 'the other stream is not this project\'s');
  });

  test('defaults the new stream to ~/.local/share when XDG_DATA_HOME is unset', async (t) => {
    const { sb, p } = project(t);
    const r = await runNode(SCRIPT, { args: ['--project', p], env: { ...sb.env, XDG_DATA_HOME: '' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(sb.home, '.local', 'share', 'myco', 'ops', 'alpha-stream', 'events.jsonl')));
  });

  test('a project with no team files and no stream is a clean no-op', async (t) => {
    const sb = sandbox(t);
    git(sb.project, 'init', '-q', '-b', 'main');
    const r = await runNode(SCRIPT, { args: ['--project', sb.project], env: { ...sb.env, XDG_DATA_HOME: join(sb.home, 'x') } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing to migrate/);
  });
});
