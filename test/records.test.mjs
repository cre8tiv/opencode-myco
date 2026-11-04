// The records every team agent leaves in the event stream: what capture-core and friction-core write,
// whichever host calls them. The OpenCode plugin decides which events become which records
// (capture-opencode.test.mjs); these cover the record itself, read back from ~/.claude/ops/<stream>/.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, writeProfile, readJsonl, opsFile } from './helpers.mjs';
import { recordEvent } from '../plugins/team-ops/scripts/capture-core.mjs';
import { recordFriction } from '../plugins/team-ops/scripts/friction-core.mjs';

const AGENT = 'engineering-team/ic-generalist';

/** A project with a committed profile naming its stream, and HOME pointed at the sandbox: the stream lives under it. */
function project(t, { profile = true } = {}) {
  const sb = sandbox(t);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ENDPOINT: process.env.TEAM_OPS_OTLP_ENDPOINT };
  process.env.HOME = sb.home;
  process.env.USERPROFILE = sb.home;
  delete process.env.TEAM_OPS_OTLP_ENDPOINT;
  t.after(() => {
    for (const [k, v] of Object.entries({ HOME: saved.HOME, USERPROFILE: saved.USERPROFILE, TEAM_OPS_OTLP_ENDPOINT: saved.ENDPOINT })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  if (profile) writeProfile(sb.project, { stream: 'alpha-stream' });
  return sb;
}

const events = (sb, stream = 'alpha-stream') => readJsonl(opsFile(sb.home, stream, 'events.jsonl'));
const friction = (sb) => readJsonl(opsFile(sb.home, 'alpha-stream', 'friction.jsonl'));

describe('events', () => {
  test('a tool failure records the agent, the tool, the target and the error', async (t) => {
    const sb = project(t);
    await recordEvent({ event: 'PostToolUseFailure', agent: AGENT, session: 's1', agentId: 'ic1', cwd: sb.project, tool: 'shell', input: { command: 'npm test -- --runInBand' }, error: 'sh: jest: command not found' });
    const [e] = events(sb);
    assert.equal(e.event, 'PostToolUseFailure');
    assert.equal(e.agent, AGENT);
    assert.equal(e.tool, 'shell');
    assert.equal(e.target, 'npm test -- --runInBand');
    assert.equal(e.error, 'sh: jest: command not found');
    assert.equal(e.session, 's1');
    assert.equal(e.agent_id, 'ic1');
    assert.match(e.ts, /^\d{4}-\d\d-\d\dT/);
  });

  test('picks the most telling argument per tool as the target', async (t) => {
    const sb = project(t);
    const base = { event: 'PostToolUseFailure', agent: AGENT, session: 's1', cwd: sb.project };
    await recordEvent({ ...base, tool: 'read', input: { path: 'src/app.ts' } });
    await recordEvent({ ...base, tool: 'grep', input: { pattern: 'TODO', path: 'src' } });
    await recordEvent({ ...base, tool: 'webfetch', input: { url: 'https://example.com/docs' } });
    await recordEvent({ ...base, tool: 'subagent', input: { agent: 'engineering-team/code-reviewer' } });
    assert.deepEqual(events(sb).map((e) => e.target), ['src/app.ts', 'TODO', 'https://example.com/docs', 'engineering-team/code-reviewer']);
  });

  test('long fields are truncated, so one runaway error cannot bloat the log', async (t) => {
    const sb = project(t);
    await recordEvent({ event: 'PostToolUseFailure', agent: AGENT, cwd: sb.project, tool: 'shell', input: { command: 'x'.repeat(5000) }, error: 'e'.repeat(5000) });
    const [e] = events(sb);
    assert.equal(e.target.length, 301);
    assert.equal(e.error.length, 601);
    assert.ok(e.target.endsWith('…'));
  });

  test('empty fields are left out rather than written as null', async (t) => {
    const sb = project(t);
    await recordEvent({ event: 'PreCompact', agent: AGENT, cwd: sb.project });
    assert.deepEqual(Object.keys(events(sb)[0]).sort(), ['agent', 'cwd', 'event', 'ts']);
  });

  test('events from every worktree of a project land in one stream', async (t) => {
    const sb = project(t);
    const wt = join(sb.project, '.claude', 'worktrees', 'agent-7');
    mkdirSync(wt, { recursive: true });
    for (const cwd of [sb.project, wt]) await recordEvent({ event: 'SessionEnd', agent: AGENT, cwd });
    assert.equal(events(sb).length, 2);
  });

  test('a project with no profile still gets a stream, named after its directory', async (t) => {
    const sb = project(t, { profile: false });
    await recordEvent({ event: 'SessionEnd', agent: AGENT, cwd: sb.project });
    assert.equal(events(sb, 'proj-alpha').length, 1);
  });
});

describe('friction', () => {
  test('records the note, kind, agent and work', async (t) => {
    const sb = project(t);
    await recordFriction({ cwd: sb.project, agent: AGENT, session: 's1', work: 'CLOUD-42', parentWork: 'CLOUD-1', kind: 'instructions', note: 'definition says run the test script but names none' });
    const [f] = friction(sb);
    assert.equal(f.agent, AGENT);
    assert.equal(f.kind, 'instructions');
    assert.equal(f.note, 'definition says run the test script but names none');
    assert.equal(f.work, 'CLOUD-42');
    assert.equal(f.parent_work, 'CLOUD-1');
    assert.equal(f.session, 's1');
  });

  test('defaults the kind and truncates a rambling note', async (t) => {
    const sb = project(t);
    await recordFriction({ cwd: sb.project, agent: 'engineering-team/qa-specialist', note: 'n'.repeat(3000) });
    const [f] = friction(sb);
    assert.equal(f.kind, 'unspecified');
    assert.equal(f.note.length, 1000);
  });

  test('lands in the same stream as the events', async (t) => {
    const sb = project(t);
    await recordEvent({ event: 'SessionEnd', agent: AGENT, cwd: sb.project });
    await recordFriction({ cwd: sb.project, agent: AGENT, note: 'y' });
    assert.equal(events(sb).length, 1);
    assert.equal(friction(sb).length, 1);
  });
});
