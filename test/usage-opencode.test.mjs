// Usage and cost from OpenCode sessions: the records OpenCode's messages turn into, and
// `cost.mjs` reporting them. The numbers are checked by hand against the price table
// (opus-5-5: $4/M in, $20/M out).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, runNode, script, writeProfile } from './helpers.mjs';
import { usageRecords, workTagsOf, dispatchesOf } from '../plugins/team-ops/scripts/usage-opencode.mjs';

const COST = script('team-ops', 'cost.mjs');
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-opencode.mjs');
const M = 1_000_000;
const LEAD = 'design-team/product-lead';

const tokens = (input = 0, output = 0, extra = {}) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 }, ...extra });
const msg = (at, content = [], t = tokens(), agent = LEAD, model = 'claude-opus-5-5') => ({ type: 'assistant', agent, model: { id: model, providerID: 'anthropic' }, tokens: t, time: { created: at }, content });
const tool = (name, input, metadata) => ({ type: 'tool', name, state: { input, metadata } });

/** A lead on two rounds of one package, one architect it dispatched, and 10K tokens no message shows. */
function fixture() {
  const t0 = Date.parse('2026-03-01T10:00:00Z');
  const lead = [
    msg(t0 + 1000, [tool('start_work', { tag: 'order-exceptions/round-1' })]),
    msg(t0 + 2000, [], tokens(M, 100_000)),
    msg(t0 + 3000, [tool('subagent', { agent: 'design-team/architect', description: '[order-exceptions/arch] draft architecture' }, { sessionID: 'ses_arch' })]),
    msg(t0 + 9000, [tool('start_work', { tag: 'order-exceptions/round-2' })]),
    msg(t0 + 10000, [], tokens(M, M), LEAD, 'claude-sonnet-5-5'),
  ];
  const arch = [msg(t0 + 4000, [], tokens(0, M), 'design-team/architect')];
  const sum = (ms) => ms.reduce((s, m) => ({ input: s.input + m.tokens.input, output: s.output + m.tokens.output }), { input: 0, output: 0 });
  const l = sum(lead);
  return {
    info: { id: 'ses_lead', agent: LEAD, project: 'proj-1', time: { created: t0, updated: t0 + 10000 }, tokens: tokens(l.input + 10_000, l.output) },
    archInfo: { id: 'ses_arch', agent: 'design-team/architect', parentID: 'ses_lead', project: 'proj-1', time: { created: t0 + 3000, updated: t0 + 4000 }, tokens: tokens(0, M) },
    lead,
    arch,
  };
}

describe('reading OpenCode messages', () => {
  test('start_work calls and subagent calls are found in time order', () => {
    const f = fixture();
    assert.deepEqual(workTagsOf(f.lead).map((x) => x.tag), ['order-exceptions/round-1', 'order-exceptions/round-2']);
    assert.deepEqual(dispatchesOf(f.lead).map((d) => d.sessionID), ['ses_arch']);
  });

  test('usage lands on the work it belongs to, per agent and model', () => {
    const f = fixture();
    const recs = usageRecords({ lead: { id: 'ses_lead', info: f.info, messages: f.lead }, children: new Map([['ses_arch', { info: f.archInfo, messages: f.arch }]]) });
    const find = (agent, work) => recs.find((r) => r.agent === agent && r.work === work);
    assert.equal(find(LEAD, 'order-exceptions/round-1').input, M);
    assert.equal(find(LEAD, 'order-exceptions/round-1').output, 100_000);
    assert.equal(find(LEAD, 'order-exceptions/round-2').model, 'claude-sonnet-5-5');
    const arch = find('design-team/architect', 'order-exceptions/arch');
    assert.equal(arch.output, M);
    assert.equal(arch.parent_work, 'order-exceptions/round-1', 'it was dispatched during round 1');
    assert.equal(arch.agent_id, 'ses_arch');
    assert.equal(arch.session, 'ses_lead');
  });

  test('tokens no message accounts for are reported as internal, so totals reconcile', () => {
    const f = fixture();
    const recs = usageRecords({ lead: { id: 'ses_lead', info: f.info, messages: f.lead }, children: new Map([['ses_arch', { info: f.archInfo, messages: f.arch }]]) });
    const internal = recs.filter((r) => r.agent === 'internal');
    assert.equal(internal.length, 1);
    assert.equal(internal[0].input, 10_000);
    assert.equal(internal[0].output, 0);
    assert.equal(recs.reduce((s, r) => s + r.input, 0), f.info.tokens.input);
  });

  test('reasoning counts as output and cache writes as 5-minute writes', () => {
    const lead = { id: 's', info: { agent: LEAD, tokens: tokens(0, 7, { reasoning: 3, cache: { read: 5, write: 9 } }) }, messages: [msg(1, [], tokens(0, 7, { reasoning: 3, cache: { read: 5, write: 9 } }))] };
    const [r] = usageRecords({ lead });
    assert.equal(r.output, 10);
    assert.equal(r.cache_write_5m, 9);
    assert.equal(r.cache_write_1h, 0);
    assert.equal(r.cache_read, 5);
  });

  test('a session that is not a team agent records nothing, nor does what it dispatched unless it is one', () => {
    const f = fixture();
    const human = { ...f.info, agent: 'build' };
    const plain = { ...f.archInfo, agent: 'general' };
    const recs = usageRecords({
      lead: { id: 'ses_lead', info: human, messages: f.lead },
      children: new Map([['ses_arch', { info: plain, messages: [msg(1, [], tokens(0, 50), 'general')] }]]),
    });
    assert.deepEqual(recs, []);
  });

  test('a dispatched agent whose session is missing is skipped, not fatal', () => {
    const f = fixture();
    const recs = usageRecords({ lead: { id: 'ses_lead', info: f.info, messages: f.lead } });
    assert.ok(recs.every((r) => r.agent !== 'design-team/architect'));
  });
});

describe('cost.mjs over OpenCode', () => {
  function setup(t, mutate = (db) => db) {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'alpha-stream' });
    const f = fixture();
    const dbFile = join(sb.root, 'db.json');
    const write = (db) => writeFileSync(dbFile, JSON.stringify(db));
    const db = mutate({ sessions: [f.info, f.archInfo], contexts: { ses_lead: f.lead, ses_arch: f.arch } });
    write(db);
    const env = { ...sb.env, MYCO_OPENCODE: FAKE, FAKE_OPENCODE_DB: dbFile };
    const report = (args = []) => runNode(COST, { args: ['--json', ...args], cwd: sb.project, env }).then((r) => ({ ...r, json: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null }));
    return { sb, f, db, write, report, env };
  }
  const group = (json, key) => json.groups.find((g) => g.key === key);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} is not about ${expected}`);

  test('reports the cost of each unit of work, agent spend included', async (t) => {
    const { report } = setup(t);
    const r = await report();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.source, 'opencode');
    assert.equal(r.json.backfilled_sessions, 1);
    near(group(r.json, 'order-exceptions/round-1').usd, 6); // 1M in + 100K out on opus
    near(group(r.json, 'order-exceptions/round-2').usd, 12.02); // sonnet: 1M in + 1M out, plus the 10K internal input
    near(group(r.json, 'order-exceptions/arch').usd, 20); // architect: 1M out on opus
    assert.ok(group(r.json, 'order-exceptions/round-1').sessions >= 1);
  });

  test('--work covers a package by prefix, including what it dispatched', async (t) => {
    const { report } = setup(t);
    const r = await report(['--work', 'order-exceptions']);
    near(r.json.total_usd, 6 + 12.02 + 20);
  });

  test('a second report records nothing again, and a changed session is recorded in place of its earlier snapshot', async (t) => {
    const { report, db, write } = setup(t);
    const first = await report();
    const second = await report();
    assert.equal(second.json.backfilled_sessions, 0);
    assert.equal(second.json.total_usd, first.json.total_usd);

    db.sessions[0].time.updated += 60_000;
    db.contexts.ses_lead.push(msg(Date.parse('2026-03-01T10:05:00Z'), [], tokens(0, M / 10)));
    db.sessions[0].tokens.output += M / 10;
    write(db);
    const third = await report();
    assert.equal(third.json.backfilled_sessions, 1);
    near(third.json.total_usd, first.json.total_usd + 2.02, 'a snapshot supersedes the last: the new output, and the internal input now priced at the last model');
  });

  test('sessions of other projects and non-team sessions are left out', async (t) => {
    const { report } = setup(t, (db) => {
      db.sessions.push({ ...db.sessions[0], id: 'ses_other', project: 'proj-2' }, { ...db.sessions[0], id: 'ses_human', agent: 'build' });
      db.contexts.ses_other = db.contexts.ses_lead;
      db.contexts.ses_human = db.contexts.ses_lead;
      return db;
    });
    const r = await report(['--by', 'session']);
    assert.deepEqual(r.json.groups.map((g) => g.key), ['ses_lead']);
  });

  test('a model with no list price is shown as unpriced, not as free', async (t) => {
    const { report } = setup(t, (db) => {
      db.contexts.ses_lead = [{ ...db.contexts.ses_lead[1], model: { id: 'qwen3-coder', providerID: 'ollama' } }, ...db.contexts.ses_lead.slice(2)];
      return db;
    });
    const r = await report(['--by', 'model']);
    assert.ok(group(r.json, 'qwen3-coder').unpriced_models);
  });

  test('when OpenCode cannot be asked, the report says so and still shows what was recorded', async (t) => {
    const { sb, report } = setup(t);
    await report();
    const r = await runNode(COST, { args: ['--json'], cwd: sb.project, env: { ...sb.env, MYCO_OPENCODE: join(sb.root, 'missing.mjs') } }).then((x) => ({ ...x, json: JSON.parse(x.stdout) }));
    assert.equal(r.status, 0);
    assert.ok(r.json.refresh_error, 'the failure is reported');
    near(r.json.total_usd, 38.02);
  });

  test('an unknown --source is refused', async (t) => {
    const { sb, env } = setup(t);
    const r = await runNode(COST, { args: ['--source', 'nope'], cwd: sb.project, env });
    assert.equal(r.status, 2);
  });
});
