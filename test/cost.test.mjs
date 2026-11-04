// End to end for cost reporting: the hooks snapshot usage when a session or subagent
// ends, and `cost.mjs` reports it by unit of work. The numbers are checked by hand
// against the price table (opus-5-5: $4/M in, $20/M out; sonnet-5-5: $2/M in, $10/M out).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sandbox, runHook, runNode, script, writeProfile, writeSession, assistant, startWork, usage, readJsonl, opsFile } from './helpers.mjs';

const USAGE_HOOK = script('team-ops', 'usage.mjs');
const COST = script('team-ops', 'cost.mjs');
const LEAD = 'design-team:product-lead';
const M = 1_000_000;

function project(t) {
  const sb = sandbox(t);
  writeProfile(sb.project, { stream: 'alpha-stream' });
  return sb;
}
const usageLog = (sb) => readJsonl(opsFile(sb.home, 'alpha-stream', 'usage.jsonl'));

/**
 * A product-lead session across two rounds with an architect subagent:
 *   round-1  lead on opus:   1M in + 100K out = $4 + $2   = $6
 *   round-2  lead on sonnet: 1M in + 1M out   = $2 + $10  = $12
 *   arch     architect, opus, 1M out                      = $20
 */
function leadSession(sb, sessionId = 's-lead') {
  return writeSession({
    home: sb.home,
    sessionId,
    lead: LEAD,
    rows: [
      startWork(1, 'order-exceptions/round-1'),
      assistant({ at: 2, usage: usage({ input: M, output: 100_000 }), model: 'claude-opus-5-5' }),
      startWork(10, 'order-exceptions/round-2'),
      assistant({ at: 11, usage: usage({ input: M, output: M }), model: 'claude-sonnet-5-5' }),
    ],
    subagents: [{ id: 'arch', agentType: 'design-team:architect', description: '[order-exceptions/arch] draft architecture', rows: [assistant({ at: 5, usage: usage({ output: M }), sidechain: true })] }],
  });
}

/** Tells the event stream a session exists, as capture.mjs would have. */
function knowSession(sb, session) {
  const p = opsFile(sb.home, 'alpha-stream', 'events.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), event: 'SessionEnd', session, agent: LEAD }) + '\n');
}

// These tests read Claude Code transcripts; OpenCode's are in usage-opencode.test.mjs.
const report = (sb, args = []) => runNode(COST, { args: ['--json', '--source', 'claude', ...args], cwd: sb.project, env: sb.env }).then((r) => ({ ...r, json: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null }));
const group = (json, key) => json.groups.find((g) => g.key === key);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} is not about ${expected}`);

describe('usage hook', () => {
  test('SessionEnd of a lead session records the lead and every subagent', async (t) => {
    const sb = project(t);
    const { transcriptPath } = leadSession(sb);
    const r = await runHook(USAGE_HOOK, { hook_event_name: 'SessionEnd', agent_type: LEAD, session_id: 's-lead', transcript_path: transcriptPath, cwd: sb.project }, { env: sb.env });
    assert.equal(r.status, 0);
    const recs = usageLog(sb);
    assert.deepEqual([...new Set(recs.map((x) => x.agent))].sort(), ['design-team:architect', LEAD]);
    assert.deepEqual([...new Set(recs.map((x) => x.work))].sort(), ['order-exceptions/arch', 'order-exceptions/round-1', 'order-exceptions/round-2']);
  });

  test('SubagentStop records just that subagent', async (t) => {
    const sb = project(t);
    const { transcriptPath } = leadSession(sb);
    await runHook(USAGE_HOOK, { hook_event_name: 'SubagentStop', agent_id: 'arch', session_id: 's-lead', transcript_path: transcriptPath, cwd: sb.project }, { env: sb.env });
    assert.deepEqual(usageLog(sb).map((x) => x.agent_id), ['arch']);
  });

  test('an ad-hoc session that dispatched no team agent leaves no record', async (t) => {
    const sb = project(t);
    const { transcriptPath } = writeSession({ home: sb.home, sessionId: 'adhoc', rows: [assistant({ at: 1, usage: usage({ output: 500 }) })] });
    await runHook(USAGE_HOOK, { hook_event_name: 'SessionEnd', agent_type: 'main', session_id: 'adhoc', transcript_path: transcriptPath, cwd: sb.project }, { env: sb.env });
    assert.equal(existsSync(opsFile(sb.home, 'alpha-stream', 'usage.jsonl')), false);
  });

  test('a second SessionEnd (a resumed session) supersedes the first rather than adding to it', async (t) => {
    const sb = project(t);
    const { transcriptPath } = leadSession(sb);
    const payload = { hook_event_name: 'SessionEnd', agent_type: LEAD, session_id: 's-lead', transcript_path: transcriptPath, cwd: sb.project };
    await runHook(USAGE_HOOK, payload, { env: sb.env });
    await new Promise((r) => setTimeout(r, 15)); // snapshots are ordered by timestamp
    await runHook(USAGE_HOOK, payload, { env: sb.env });
    const r = await report(sb);
    near(r.json.total_usd, 38);
  });

  test('never fails a run', async (t) => {
    const sb = project(t);
    for (const payload of ['', 'garbage', '{}', JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'x', transcript_path: 'C:/missing.jsonl', agent_type: LEAD })]) {
      assert.equal((await runHook(USAGE_HOOK, payload, { env: sb.env })).status, 0);
    }
  });
});

describe('cost.mjs', () => {
  test('reports each unit of work and the total, from a session the hooks never saw', async (t) => {
    // A headless run killed before SessionEnd: the report backfills from the transcript.
    const sb = project(t);
    leadSession(sb);
    knowSession(sb, 's-lead');
    const r = await report(sb);
    assert.equal(r.status, 0, r.stderr);
    near(group(r.json, 'order-exceptions/round-1').usd, 6);
    near(group(r.json, 'order-exceptions/round-2').usd, 12);
    near(group(r.json, 'order-exceptions/arch').usd, 20);
    near(r.json.total_usd, 38);
    assert.equal(r.json.backfilled_sessions, 1);
  });

  test('is idempotent: reporting twice does not double the cost', async (t) => {
    const sb = project(t);
    leadSession(sb);
    knowSession(sb, 's-lead');
    await report(sb);
    const second = await report(sb);
    near(second.json.total_usd, 38);
    assert.equal(second.json.backfilled_sessions, 0);
  });

  test('--work matches by prefix: a package covers all its rounds; a round only itself', async (t) => {
    const sb = project(t);
    leadSession(sb);
    knowSession(sb, 's-lead');
    near((await report(sb, ['--work', 'order-exceptions'])).json.total_usd, 38);
    const round2 = await report(sb, ['--work', 'order-exceptions/round-2']);
    near(round2.json.total_usd, 12);
    assert.deepEqual(round2.json.groups.map((g) => g.key), ['order-exceptions/round-2']);
    assert.equal((await report(sb, ['--work', 'something-else'])).json.groups.length, 0);
  });

  test('--work also finds a subagent by the work its lead was on', async (t) => {
    // The architect is tagged "arch", but it ran during round-1: asking for round-1 should
    // include it through parent_work.
    const sb = project(t);
    leadSession(sb);
    knowSession(sb, 's-lead');
    const r = await report(sb, ['--work', 'order-exceptions/round-1']);
    near(r.json.total_usd, 6 + 20);
  });

  test('--by agent, model and session regroup the same money', async (t) => {
    const sb = project(t);
    leadSession(sb);
    knowSession(sb, 's-lead');
    const byAgent = await report(sb, ['--by', 'agent']);
    near(group(byAgent.json, LEAD).usd, 18);
    near(group(byAgent.json, 'design-team:architect').usd, 20);
    const byModel = await report(sb, ['--by', 'model']);
    near(group(byModel.json, 'claude-opus-5-5').usd, 26);
    near(group(byModel.json, 'claude-sonnet-5-5').usd, 12);
    assert.deepEqual((await report(sb, ['--by', 'session'])).json.groups.map((g) => g.key), ['s-lead']);
  });

  test('names the lead among the biggest spenders and sorts work by cost', async (t) => {
    const sb = project(t);
    leadSession(sb);
    knowSession(sb, 's-lead');
    const r = await report(sb);
    assert.equal(r.json.groups[0].key, 'order-exceptions/arch');
    assert.ok('design-team:architect' in r.json.groups[0].by_agent);
  });

  test('--since leaves out work that ended before the date', async (t) => {
    const sb = project(t);
    leadSession(sb); // rows are timestamped 2026-10-12
    knowSession(sb, 's-lead');
    assert.equal((await report(sb, ['--since', '2026-10-12'])).json.groups.length, 3);
    assert.equal((await report(sb, ['--since', '2026-10-13'])).json.groups.length, 0);
  });

  test('a model with no price is reported as unpriced, not as free', async (t) => {
    const sb = project(t);
    writeSession({
      home: sb.home,
      sessionId: 's-new',
      lead: LEAD,
      rows: [startWork(1, 'pkg/round-1'), assistant({ at: 2, usage: usage({ input: M }), model: 'claude-future-9' })],
    });
    knowSession(sb, 's-new');
    const r = await report(sb);
    assert.equal(group(r.json, 'pkg/round-1').unpriced_models, true);
    const text = await runNode(COST, { args: ['--source', 'claude'], cwd: sb.project, env: sb.env });
    assert.match(text.stdout, /unpriced/);
  });

  test('the default output is a markdown table with a total', async (t) => {
    const sb = project(t);
    leadSession(sb);
    knowSession(sb, 's-lead');
    const r = await runNode(COST, { args: ['--source', 'claude'], cwd: sb.project, env: sb.env });
    assert.match(r.stdout, /^# Cost, by work/m);
    assert.match(r.stdout, /\| order-exceptions\/arch \| \$20\.00 \|/);
    assert.match(r.stdout, /\*\*Total\*\* \| \*\*\$38\.00\*\*/);
    assert.match(r.stdout, /API-equivalent estimate/);
  });

  test('says so when nothing has been recorded', async (t) => {
    const sb = project(t);
    const r = await runNode(COST, { args: ['--source', 'claude'], cwd: sb.project, env: sb.env });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No usage recorded yet/);
  });

  test('--no-backfill reports only what the hooks recorded', async (t) => {
    const sb = project(t);
    leadSession(sb);
    knowSession(sb, 's-lead');
    assert.equal((await report(sb, ['--no-backfill'])).json.groups.length, 0);
  });

  test('--export without an endpoint says how to set one up', async (t) => {
    const sb = project(t);
    const r = await runNode(COST, { args: ['--source', 'claude', '--export'], cwd: sb.project, env: sb.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TEAM_OPS_OTLP_ENDPOINT/);
  });
});
