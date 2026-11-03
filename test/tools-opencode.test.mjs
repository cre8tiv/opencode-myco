// start_work and log_friction, the OpenCode tools behind the start-work and log-friction
// skills. The host hands a tool the real session and agent; these cover what the tools do
// with them: the work a session names, the friction record written to the event stream,
// and that a tool which cannot do its job says so and never throws.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { install } from '../scripts/install.mjs';
import { registerTools } from '../opencode-plugin/myco/tools.js';
import { FRICTION_KINDS } from '../plugins/team-ops/scripts/friction-core.mjs';

const read = (p) => readFileSync(p, 'utf8');
const LEAD = 'engineering-team/tech-lead';
const IC = 'engineering-team/ic-generalist';

/**
 * Installs the teams, registers the tools on a stand-in plugin context, and returns a way to call them.
 * HOME is the sandbox for the test, because the event stream lives under it.
 */
async function tools(t, { profile, storage, root } = {}) {
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
  if (profile) {
    mkdirSync(join(sb.project, '.claude', 'team'), { recursive: true });
    writeFileSync(join(sb.project, '.claude', 'team', 'project.md'), `---\n${profile}\n---\n`);
  }
  const defs = {};
  const ctx = { location: { directory: sb.project }, storage, tool: { transform: async (fn) => fn({ add: (d) => { defs[d.name] = d; } }) } };
  const loaded = await registerTools(ctx, root ?? join(target, 'myco'));
  /** @returns {Promise<string>} the text a tool returns */
  const call = async (name, input, context) => (await defs[name].execute(input, context)).content;
  const friction = (stream = 'alpha-stream') => {
    const file = join(sb.home, '.claude', 'ops', stream, 'friction.jsonl');
    return existsSync(file) ? read(file).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { defs, call, friction, loaded, sb, target };
}

/** A storage like the host's: durable JSON by key. */
const memoryStorage = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), data: m };
};

describe('registration', () => {
  test('registers both tools as JSON-schema tools the model sees directly', async (t) => {
    const { defs, loaded } = await tools(t);
    assert.deepEqual(Object.keys(defs).sort(), ['log_friction', 'start_work']);
    assert.equal(loaded.friction, true);
    for (const d of Object.values(defs)) {
      assert.equal(d.options.codemode, false, d.name);
      assert.equal(d.input.type, 'object');
      assert.equal(d.input.additionalProperties, false);
      assert.ok(d.description.length > 80, d.name);
      assert.equal(typeof d.execute, 'function');
    }
    assert.deepEqual(defs.start_work.input.required, ['tag']);
    assert.deepEqual(defs.log_friction.input.required, ['kind', 'note']);
    assert.deepEqual(defs.log_friction.input.properties.kind.enum, FRICTION_KINDS);
  });

  test('the skills that tell agents to use them name the tools', () => {
    const skill = (n) => read(join(import.meta.dirname, '..', 'plugins', 'team-ops', 'skills', n, 'SKILL.md'));
    assert.match(skill('start-work'), /`start_work`/);
    assert.match(skill('log-friction'), /`log_friction`/);
    for (const kind of FRICTION_KINDS) assert.match(skill('log-friction'), new RegExp(`\`${kind}\``), kind);
  });
});

describe('start_work', () => {
  test('names the work for the session, and friction reported afterwards carries it', async (t) => {
    const { call, friction } = await tools(t, { profile: 'stream: alpha-stream' });
    assert.equal(await call('start_work', { tag: 'order-exceptions/round-2' }, { sessionID: 's1', agent: LEAD }), 'Work is now order-exceptions/round-2.');
    assert.equal(await call('log_friction', { kind: 'tooling', note: 'the test script is not named' }, { sessionID: 's1', agent: IC }), 'friction logged');
    assert.equal(friction()[0].work, 'order-exceptions/round-2');
  });

  test('is per session, and the latest tag wins', async (t) => {
    const { call, friction } = await tools(t, { profile: 'stream: alpha-stream' });
    await call('start_work', { tag: 'CLOUD-1' }, { sessionID: 's1', agent: LEAD });
    await call('start_work', { tag: 'CLOUD-2' }, { sessionID: 's2', agent: LEAD });
    await call('start_work', { tag: 'CLOUD-1/phase-2' }, { sessionID: 's1', agent: LEAD });
    await call('log_friction', { kind: 'scope', note: 'a' }, { sessionID: 's1', agent: IC });
    await call('log_friction', { kind: 'scope', note: 'b' }, { sessionID: 's2', agent: IC });
    await call('log_friction', { kind: 'scope', note: 'c' }, { sessionID: 's3', agent: IC });
    assert.deepEqual(friction().map((r) => r.work), ['CLOUD-1/phase-2', 'CLOUD-2', undefined]);
  });

  test('wants one tag with no spaces, and records nothing otherwise', async (t) => {
    const { call, friction } = await tools(t, { profile: 'stream: alpha-stream' });
    for (const tag of ['', '   ', 'two words', 'a\tb', undefined, 42, null]) {
      assert.match(await call('start_work', { tag }, { sessionID: 's1', agent: LEAD }), /needs one tag with no spaces/, String(tag));
    }
    await call('log_friction', { kind: 'scope', note: 'x' }, { sessionID: 's1', agent: IC });
    assert.equal(friction()[0].work, undefined);
  });

  test('says so when it cannot tell which session this is', async (t) => {
    const { call } = await tools(t);
    assert.match(await call('start_work', { tag: 'CLOUD-1' }, {}), /could not tell which session/);
    assert.match(await call('start_work', { tag: 'CLOUD-1' }, undefined), /could not tell which session/);
  });

  test('survives a restart through the host\'s storage, and does not need it', async (t) => {
    const storage = memoryStorage();
    const first = await tools(t, { profile: 'stream: alpha-stream', storage });
    await first.call('start_work', { tag: 'CLOUD-9' }, { sessionID: 's1', agent: LEAD });
    assert.equal(storage.data.get('work/s1'), 'CLOUD-9');

    // A new plugin instance with the same storage, as after the server restarts mid-session.
    const sb = first.sb;
    const defs = {};
    await registerTools({ location: { directory: sb.project }, storage, tool: { transform: async (fn) => fn({ add: (d) => { defs[d.name] = d; } }) } }, join(first.target, 'myco'));
    await defs.log_friction.execute({ kind: 'handoff', note: 'after restart' }, { sessionID: 's1', agent: IC });
    assert.equal(first.friction().at(-1).work, 'CLOUD-9');

    const broken = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
    const second = await tools(t, { profile: 'stream: alpha-stream', storage: broken });
    assert.equal(await second.call('start_work', { tag: 'CLOUD-3' }, { sessionID: 's1', agent: LEAD }), 'Work is now CLOUD-3.');
    await second.call('log_friction', { kind: 'scope', note: 'x' }, { sessionID: 's1', agent: IC });
    assert.equal(second.friction()[0].work, 'CLOUD-3');
  });
});

describe('log_friction', () => {
  test('writes a record in the event stream the coach reads, with the real agent and session', async (t) => {
    const { call, friction, sb } = await tools(t, { profile: 'stream: alpha-stream' });
    await call('log_friction', { kind: 'instructions', note: 'the definition names no verification command' }, { sessionID: 'ses_abc', agent: IC });
    const [rec] = friction();
    assert.equal(rec.agent, IC);
    assert.equal(rec.session, 'ses_abc');
    assert.equal(rec.kind, 'instructions');
    assert.equal(rec.note, 'the definition names no verification command');
    assert.equal(rec.cwd, sb.project);
    assert.match(rec.ts, /^\d{4}-\d\d-\d\dT/);
    assert.equal('work' in rec, false, 'no work tag was named, so none is written');
  });

  test('the stream is the one the project profile names', async (t) => {
    const { call, friction } = await tools(t, { profile: 'stream: team-x' });
    await call('log_friction', { kind: 'tooling', note: 'x' }, { sessionID: 's', agent: IC });
    assert.equal(friction('team-x').length, 1);
    assert.equal(friction('alpha-stream').length, 0);
  });

  test('work belongs to different work when the agent says so', async (t) => {
    const { call, friction } = await tools(t, { profile: 'stream: alpha-stream' });
    await call('start_work', { tag: 'CLOUD-1' }, { sessionID: 's', agent: LEAD });
    await call('log_friction', { kind: 'handoff', note: 'the design is wrong', work: 'order-exceptions' }, { sessionID: 's', agent: LEAD });
    assert.equal(friction()[0].work, 'order-exceptions');
  });

  test('truncates a rambling note, and names an agent it was not told as unknown', async (t) => {
    const { call, friction } = await tools(t, { profile: 'stream: alpha-stream' });
    await call('log_friction', { kind: 'scope', note: 'x'.repeat(5000) }, {});
    const [rec] = friction();
    assert.equal(rec.note.length, 1000);
    assert.equal(rec.agent, 'unknown');
  });

  test('refuses an unknown kind or an empty note, and writes nothing', async (t) => {
    const { call, friction } = await tools(t, { profile: 'stream: alpha-stream' });
    assert.match(await call('log_friction', { kind: 'annoying', note: 'x' }, { sessionID: 's', agent: IC }), /kind must be one of instructions, tooling/);
    assert.match(await call('log_friction', { kind: 'scope', note: '   ' }, { sessionID: 's', agent: IC }), /needs a note/);
    assert.match(await call('log_friction', { kind: 'scope' }, { sessionID: 's', agent: IC }), /needs a note/);
    assert.deepEqual(friction(), []);
  });
});

describe('telemetry never blocks delivery', () => {
  test('a report that cannot be written is reported to the agent, not thrown', async (t) => {
    const { call, sb } = await tools(t, { profile: 'stream: alpha-stream' });
    // Where the stream lives is a file, so the directory cannot be made.
    writeFileSync(join(sb.home, '.claude'), 'not a directory');
    const out = await call('log_friction', { kind: 'tooling', note: 'x' }, { sessionID: 's', agent: IC });
    assert.match(out, /could not be written/);
    assert.match(out, /carry on/);
  });

  test('without team-ops installed, friction says so and start_work still works', async (t) => {
    const { call, defs, loaded, sb } = await tools(t, { root: '/nowhere/myco' });
    assert.equal(loaded.friction, false);
    assert.match(await call('log_friction', { kind: 'tooling', note: 'x' }, { sessionID: 's', agent: IC }), /not installed/);
    assert.equal(await call('start_work', { tag: 'CLOUD-1' }, { sessionID: 's', agent: LEAD }), 'Work is now CLOUD-1.');
    assert.ok(defs.start_work && sb);
  });
});
