// The event stream as OpenCode feeds it. The record itself is covered with the Claude Code hook
// (capture.test.mjs), which shares its core; these cover what is specific to OpenCode: which of its
// events become which records, that only team agents are recorded, that the work a session named
// reaches the record, and that nothing here ever fails the call it observes. Event shapes are the
// ones recorded from live runs: a rule denial arrives as a Tool.Error whose own error is the
// Permission.BlockedError.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { install } from '../scripts/install.mjs';
import { registerCapture } from '../opencode-plugin/myco/capture.js';
import { registerGuards } from '../opencode-plugin/myco/guards.js';
import { createWorkTracker } from '../opencode-plugin/myco/work.js';

const LEAD = 'engineering-team/tech-lead';
const IC = 'engineering-team/ic-generalist';
const COACH = 'team-ops/agent-coach';

/**
 * Installs the teams and registers capture on a stand-in plugin context. HOME is the sandbox for the
 * test, because the event stream lives under it.
 */
async function capture(t, { root, withGuards = false, noSessionHook = false } = {}) {
  const sb = sandbox(t);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ENDPOINT: process.env.TEAM_OPS_OTLP_ENDPOINT };
  process.env.HOME = sb.home;
  process.env.USERPROFILE = sb.home;
  delete process.env.TEAM_OPS_OTLP_ENDPOINT;
  t.after(() => {
    for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['TEAM_OPS_OTLP_ENDPOINT', saved.ENDPOINT]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const target = join(sb.root, 'oc');
  install({ target });
  mkdirSync(join(sb.project, '.claude', 'team'), { recursive: true });
  writeFileSync(join(sb.project, '.claude', 'team', 'project.md'), '---\nstream: alpha-stream\n---\n');

  /** @type {Record<string, Function>} */
  const tool = {};
  const session = {};
  // A stand-in event stream the test feeds, ended by the signal the plugin passes.
  const queue = [];
  let wake = () => {};
  let signal;
  const ctx = {
    location: { directory: sb.project },
    tool: { hook: async (name, fn) => { tool[name] = fn; } },
    session: noSessionHook ? {} : { hook: async (name, fn) => { session[name] = fn; } },
    event: {
      subscribe: (opts) => {
        signal = opts.signal;
        return { async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (!queue.length) await new Promise((r) => { wake = r; signal.addEventListener('abort', r, { once: true }); });
            while (queue.length) yield queue.shift();
          }
        } };
      },
    },
  };
  const work = createWorkTracker(ctx);
  const installRoot = root ?? join(target, 'myco');
  const cap = await registerCapture(ctx, installRoot, work);
  if (withGuards) await registerGuards(ctx, installRoot, { onBlock: cap.recordBlock });

  const file = () => join(sb.home, '.claude', 'ops', 'alpha-stream', 'events.jsonl');
  /** Records are written without being waited for, so wait for the count a test expects. */
  const events = async (n = 1) => {
    for (let i = 0; i < 100; i++) {
      const rows = existsSync(file()) ? readFileSync(file(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      if (rows.length >= n) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return existsSync(file()) ? readFileSync(file(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  /** Fire hooks the way the host does: before, then after. */
  const before = (e) => tool['execute.before']({ messageID: 'm', id: 'c', ...e });
  const after = (e) => tool['execute.after']({ messageID: 'm', id: 'c', ...e });
  const quiet = () => new Promise((r) => setTimeout(r, 150));
  /** Delivers an event to the plugin, as the host's stream does. */
  const send = (ev) => { queue.push(ev); wake(); };
  return { cap, work, before, after, raw: tool, session, events, quiet, send, signal: () => signal, sb, file };
}

/** The event OpenCode sent for a write refused by a permission rule, as recorded. */
const DENIED = {
  tool: 'write',
  agent: COACH,
  sessionID: 'ses_1',
  input: { path: 'a.txt', content: 'x' },
  status: 'error',
  error: { _tag: 'Tool.Error', message: 'Unable to write a.txt', error: { _tag: 'Permission.BlockedError', rules: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'edit', resource: '*', effect: 'deny' }] } },
};

describe('tool failures and denials', () => {
  test('a refused call is a PermissionDenied, with the rule that refused it', async (t) => {
    const c = await capture(t);
    c.after(DENIED);
    const [e] = await c.events();
    assert.equal(e.event, 'PermissionDenied');
    assert.equal(e.agent, COACH);
    assert.equal(e.session, 'ses_1');
    assert.equal(e.tool, 'write');
    assert.equal(e.target, 'a.txt');
    assert.match(e.reason, /^Unable to write a\.txt; \[\{"action":"\*"/);
    assert.match(e.reason, /"effect":"deny"/);
    assert.equal('error' in e, false);
    assert.match(e.ts, /^\d{4}-\d\d-\d\dT/);
  });

  test('any other failure is a PostToolUseFailure, with the command and the error', async (t) => {
    const c = await capture(t);
    c.after({ tool: 'shell', agent: IC, sessionID: 'ses_2', input: { command: 'npm test -- --runInBand' }, status: 'error', error: { _tag: 'Tool.Error', message: 'sh: jest: command not found' } });
    const [e] = await c.events();
    assert.equal(e.event, 'PostToolUseFailure');
    assert.equal(e.agent, IC);
    assert.equal(e.tool, 'shell');
    assert.equal(e.target, 'npm test -- --runInBand');
    assert.equal(e.error, 'sh: jest: command not found');
    assert.equal('reason' in e, false);
  });

  test('the most telling argument per tool is the target, under OpenCode\'s field names', async (t) => {
    const c = await capture(t);
    const fail = (tool, input) => c.after({ tool, agent: IC, sessionID: 's', input, status: 'error', error: { message: 'x' } });
    fail('read', { path: 'src/app.ts' });
    fail('grep', { pattern: 'TODO' });
    fail('webfetch', { url: 'https://example.com/docs' });
    fail('edit', { path: 'src/b.ts', oldString: 'a', newString: 'b' });
    assert.deepEqual((await c.events(4)).map((e) => e.target), ['src/app.ts', 'TODO', 'https://example.com/docs', 'src/b.ts']);
  });

  test('successful calls are not recorded, and neither is anyone who is not a team agent', async (t) => {
    const c = await capture(t);
    c.after({ tool: 'shell', agent: IC, sessionID: 's', input: { command: 'ls' }, status: 'completed', result: {} });
    c.after({ ...DENIED, agent: 'build' });
    c.after({ ...DENIED, agent: undefined });
    c.after({ tool: 'shell', agent: 'explore', sessionID: 's', input: { command: 'x' }, status: 'error', error: { message: 'x' } });
    await c.quiet();
    assert.deepEqual(await c.events(0), []);
  });

  test('a very long error is truncated, so one runaway failure cannot bloat the log', async (t) => {
    const c = await capture(t);
    c.after({ tool: 'shell', agent: IC, sessionID: 's', input: { command: 'x'.repeat(2000) }, status: 'error', error: { message: 'e'.repeat(5000) } });
    const [e] = await c.events();
    assert.equal(e.error.length, 601);
    assert.equal(e.target.length, 301);
  });
});

describe('the work a session named', () => {
  test('reaches the record', async (t) => {
    const c = await capture(t);
    await c.work.set('ses_1', 'CLOUD-1');
    c.after({ ...DENIED });
    c.after({ ...DENIED, sessionID: 'ses_other' });
    const rows = await c.events(2);
    assert.deepEqual(rows.map((r) => r.work), ['CLOUD-1', undefined]);
  });
});

describe('dispatching agents', () => {
  const START = { tool: 'subagent', agent: LEAD, sessionID: 'ses_lead', input: { agent: IC, description: '[CLOUD-9] implement retry', prompt: 'do it' } };

  test('a team agent being dispatched, and returning its report, are SubagentStart and SubagentStop', async (t) => {
    const c = await capture(t);
    await c.work.set('ses_lead', 'order-exceptions/phase-1');
    c.before(START);
    c.after({ ...START, status: 'completed', result: { output: { sessionID: 'ses_child', status: 'completed', output: 'Done: retry added, tests pass.' } } });
    const [start, stop] = await c.events(2);
    assert.equal(start.event, 'SubagentStart');
    assert.equal(start.agent, IC);
    assert.equal(start.session, 'ses_lead');
    assert.equal(start.task, '[CLOUD-9] implement retry');
    assert.equal(start.work, 'CLOUD-9', 'a [TAG] on the task names its own work');
    assert.equal(start.parent_work, 'order-exceptions/phase-1');
    assert.equal(stop.event, 'SubagentStop');
    assert.equal(stop.agent, IC);
    assert.equal(stop.agent_id, 'ses_child');
    assert.equal(stop.report, 'Done: retry added, tests pass.');
    assert.equal(stop.work, 'CLOUD-9');
  });

  test('without a [TAG] the dispatched agent is on its lead\'s work', async (t) => {
    const c = await capture(t);
    await c.work.set('ses_lead', 'CLOUD-5');
    const plain = { ...START, input: { agent: IC, description: 'implement retry', prompt: 'x' } };
    c.before(plain);
    assert.equal((await c.events())[0].work, 'CLOUD-5');
  });

  test('a dispatch that failed is a SubagentStop carrying the error', async (t) => {
    const c = await capture(t);
    c.after({ ...START, status: 'error', error: { message: 'agent not found' } });
    const [stop] = await c.events();
    assert.equal(stop.event, 'SubagentStop');
    assert.equal(stop.error, 'agent not found');
    assert.equal('agent_id' in stop, false);
    await c.quiet();
    assert.equal((await c.events(0)).length, 1, 'the failure is not recorded a second time as a tool failure');
  });

  test('a dispatch to an agent that is not a team agent is not recorded', async (t) => {
    const c = await capture(t);
    const other = { ...START, input: { agent: 'explore', description: 'find it', prompt: 'x' } };
    c.before(other);
    c.after({ ...other, status: 'completed', result: { output: { sessionID: 's', output: 'x' } } });
    await c.quiet();
    assert.deepEqual(await c.events(0), []);
  });

  test('a human dispatching a team agent is still recorded, since the child is team activity', async (t) => {
    const c = await capture(t);
    c.before({ ...START, agent: 'build' });
    assert.equal((await c.events())[0].event, 'SubagentStart');
  });
});

describe('compaction', () => {
  test('a team agent\'s compaction is a PreCompact; anyone else\'s is not recorded', async (t) => {
    const c = await capture(t);
    await c.work.set('ses_1', 'CLOUD-1');
    c.session.compaction({ sessionID: 'ses_1', agent: LEAD, messages: [] });
    c.session.compaction({ sessionID: 'ses_2', agent: 'build', messages: [] });
    const rows = await c.events();
    await c.quiet();
    assert.equal((await c.events(0)).length, 1);
    assert.equal(rows[0].event, 'PreCompact');
    assert.equal(rows[0].agent, LEAD);
    assert.equal(rows[0].work, 'CLOUD-1');
  });

  test('a host without the compaction hook still gets everything else', async (t) => {
    const c = await capture(t, { noSessionHook: true });
    c.after({ ...DENIED });
    assert.equal((await c.events())[0].event, 'PermissionDenied');
  });
});

describe('sessions and events', () => {
  const FAILED = { type: 'session.execution.failed', data: { sessionID: 'ses_lead', error: { type: 'provider.transport', message: 'Timed out waiting for response headers' } } };
  /** A model request, which is how an instance learns it serves a session, and as which agent. */
  const serve = (c, sessionID, agent) => c.session.context({ sessionID, agent, messages: [] });

  test('a run that ends on an error is a StopFailure, with the error', async (t) => {
    const c = await capture(t);
    serve(c, 'ses_lead', LEAD);
    await c.work.set('ses_lead', 'CLOUD-1');
    c.send(FAILED);
    const [e] = await c.events();
    assert.equal(e.event, 'StopFailure');
    assert.equal(e.agent, LEAD);
    assert.equal(e.session, 'ses_lead');
    assert.equal(e.work, 'CLOUD-1');
    assert.equal(e.error, 'Timed out waiting for response headers');
  });

  test('only sessions this instance serves, and only team agents', async (t) => {
    const c = await capture(t);
    serve(c, 'ses_human', 'build');
    c.send({ ...FAILED, data: { ...FAILED.data, sessionID: 'ses_human' } });
    c.send({ ...FAILED, data: { ...FAILED.data, sessionID: 'ses_nobody_told_us_about' } });
    c.send({ type: 'session.execution.failed', data: {} });
    c.send({ type: 'session.execution.failed' });
    c.send(undefined);
    await c.quiet();
    assert.deepEqual(await c.events(0), []);
  });

  test('a lead\'s run ending well is a SessionEnd; a dispatched agent\'s is not, since that is its SubagentStop', async (t) => {
    const c = await capture(t);
    serve(c, 'ses_lead', LEAD);
    serve(c, 'ses_child', IC);
    c.send({ type: 'session.created', location: { directory: c.sb.project }, data: { sessionID: 'ses_child', parentID: 'ses_lead', title: 'implement retry', agent: IC, location: { directory: c.sb.project } } });
    c.send({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
    c.send({ type: 'session.execution.succeeded', data: { sessionID: 'ses_lead' } });
    const rows = await c.events();
    await c.quiet();
    assert.equal((await c.events(0)).length, 1);
    assert.equal(rows[0].event, 'SessionEnd');
    assert.equal(rows[0].agent, LEAD);
    assert.equal(rows[0].session, 'ses_lead');
  });

  test('a dispatched agent starts on its lead\'s work, or on the [TAG] its task begins with', async (t) => {
    const c = await capture(t);
    await c.work.set('ses_lead', 'order-exceptions/phase-1');
    const created = (id, title) => c.send({ type: 'session.created', data: { sessionID: id, parentID: 'ses_lead', title, agent: IC, location: { directory: c.sb.project } } });
    created('ses_a', 'implement retry');
    created('ses_b', '[CLOUD-9] implement retry');
    // Let the stream deliver before the calls that depend on it.
    await c.quiet();
    const fail = (sessionID) => c.after({ tool: 'shell', agent: IC, sessionID, input: { command: 'x' }, status: 'error', error: { message: 'x' } });
    fail('ses_a');
    fail('ses_b');
    const rows = await c.events(2);
    assert.deepEqual(rows.map((r) => [r.session, r.work, r.parent_work]), [
      ['ses_a', 'order-exceptions/phase-1', 'order-exceptions/phase-1'],
      ['ses_b', 'CLOUD-9', 'order-exceptions/phase-1'],
    ]);
  });

  test('work a dispatched agent names itself wins over what it inherited', async (t) => {
    const c = await capture(t);
    await c.work.set('ses_lead', 'CLOUD-1');
    c.send({ type: 'session.created', data: { sessionID: 'ses_a', parentID: 'ses_lead', title: 'x', agent: IC, location: { directory: c.sb.project } } });
    await c.quiet();
    await c.work.set('ses_a', 'CLOUD-2');
    c.after({ tool: 'shell', agent: IC, sessionID: 'ses_a', input: { command: 'x' }, status: 'error', error: { message: 'x' } });
    assert.equal((await c.events())[0].work, 'CLOUD-2');
  });

  test('a session created at another location is not this instance\'s to track', async (t) => {
    const c = await capture(t);
    await c.work.set('ses_lead', 'CLOUD-1');
    c.send({ type: 'session.created', data: { sessionID: 'ses_far', parentID: 'ses_lead', title: '[OTHER-1] x', agent: IC, location: { directory: '/somewhere/else' } } });
    await c.quiet();
    c.after({ tool: 'shell', agent: IC, sessionID: 'ses_far', input: { command: 'x' }, status: 'error', error: { message: 'x' } });
    assert.equal((await c.events())[0].work, undefined);
  });

  test('disposing stops listening, and a host with no event stream is fine', async (t) => {
    const c = await capture(t);
    assert.equal(c.signal().aborted, false);
    c.cap.dispose();
    assert.equal(c.signal().aborted, true);
    serve(c, 'ses_lead', LEAD);
    c.send(FAILED);
    await c.quiet();
    assert.deepEqual(await c.events(0), [], 'nothing is recorded once it has been disposed');

    const bare = { location: { directory: '/x' }, tool: { hook: async () => {} }, session: { hook: async () => {} } };
    const cap = await registerCapture(bare, '/nowhere/myco');
    assert.doesNotThrow(() => cap.dispose());
  });
});

describe('the guards', () => {
  test('a call a guard stops never reaches execute.after, so the guard reports it', async (t) => {
    const c = await capture(t, { withGuards: true });
    assert.throws(() => c.before({ tool: 'shell', agent: COACH, sessionID: 'ses_g', input: { command: 'echo x > c.txt' } }), /propose-only/);
    const [e] = await c.events();
    assert.equal(e.event, 'PermissionDenied');
    assert.equal(e.agent, COACH);
    assert.equal(e.session, 'ses_g');
    assert.equal(e.tool, 'shell');
    assert.equal(e.target, 'echo x > c.txt');
    assert.match(e.reason, /^Blocked: agent-coach is propose-only/);
  });

  test('a merge the gate stops is recorded too, and one it allows is not', async (t) => {
    const c = await capture(t, { withGuards: true });
    assert.throws(() => c.before({ tool: 'shell', agent: LEAD, sessionID: 'ses_g', input: { command: 'gh pr merge 5' } }), /merge_policy/);
    c.before({ tool: 'shell', agent: LEAD, sessionID: 'ses_g', input: { command: 'gh pr view 5' } });
    const rows = await c.events();
    await c.quiet();
    assert.equal((await c.events(0)).length, 1);
    assert.equal(rows[0].event, 'PermissionDenied');
    assert.match(rows[0].reason, /merge_policy/);
  });

  test('recording a block cannot change it or stop it', async (t) => {
    const c = await capture(t, { withGuards: true });
    // A broken recorder: the guard still stops the call.
    const broken = { ...c.cap, recordBlock: () => { throw new Error('disk full'); } };
    assert.equal(typeof broken.recordBlock, 'function');
    assert.doesNotThrow(() => c.cap.recordBlock(undefined, 'x'));
    assert.doesNotThrow(() => c.cap.recordBlock({ agent: COACH, get input() { throw new Error('boom'); } }, 'x'));
  });
});

describe('telemetry never breaks a run', () => {
  test('malformed events are ignored', async (t) => {
    const c = await capture(t);
    for (const e of [{}, { tool: 'subagent' }, { tool: 'subagent', agent: LEAD, input: null }, { agent: IC, status: 'error' }]) {
      assert.doesNotThrow(() => c.before(e));
      assert.doesNotThrow(() => c.after(e));
    }
    // Called directly: the getter must be read by the hook, not by a helper that spreads the event.
    const hostile = { agent: IC, status: 'error', get input() { throw new Error('boom'); } };
    assert.doesNotThrow(() => c.raw['execute.before'](hostile));
    assert.doesNotThrow(() => c.raw['execute.after'](hostile));
    assert.doesNotThrow(() => c.session.compaction({}));
    assert.doesNotThrow(() => c.session.compaction(undefined));
  });

  test('a stream that cannot be written does not fail the call', async (t) => {
    const c = await capture(t);
    writeFileSync(join(c.sb.home, '.claude'), 'not a directory');
    assert.doesNotThrow(() => c.after({ ...DENIED }));
    await c.quiet();
  });

  test('without team-ops installed there is nothing to record and nothing breaks', async (t) => {
    const c = await capture(t, { root: '/nowhere/myco' });
    assert.equal(c.cap.recorded, false);
    assert.doesNotThrow(() => c.after({ ...DENIED }));
    assert.doesNotThrow(() => c.cap.recordBlock({ agent: COACH }, 'x'));
  });
});
