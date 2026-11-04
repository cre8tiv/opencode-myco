// `cost.mjs` reports the usage log by unit of work. The log is seeded here directly; how OpenCode's
// sessions become records, and the refresh that precedes a report, are covered in
// usage-opencode.test.mjs. The numbers are checked by hand against the price table
// (opus-5-5: $4/M in, $20/M out; sonnet-5-5: $2/M in, $10/M out).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, runNode, script, writeProfile, opsFile } from './helpers.mjs';
import { appendUsage } from '../plugins/team-ops/scripts/usage-lib.mjs';

const COST = script('team-ops', 'cost.mjs');
const LEAD = 'design-team/product-lead';
const ARCH = 'design-team/architect';
const M = 1_000_000;

function project(t) {
  const sb = sandbox(t);
  writeProfile(sb.project, { stream: 'alpha-stream' });
  return sb;
}

const rec = (over) => ({
  snap: '2026-10-12T12:00:00.000Z', session: 's-lead', agent_id: 'main', agent: LEAD, speed: 'standard',
  input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, requests: 1,
  first: '2026-10-12T10:00:00.000Z', last: '2026-10-12T10:30:00.000Z', ...over,
});

/**
 * A product-lead session across two rounds with an architect it dispatched:
 *   round-1  lead on opus:   1M in + 100K out = $4 + $2   = $6
 *   round-2  lead on sonnet: 1M in + 1M out   = $2 + $10  = $12
 *   arch     architect, opus, 1M out                      = $20 (ran during round-1)
 */
function seed(sb) {
  mkdirSync(join(sb.home, '.claude', 'ops', 'alpha-stream'), { recursive: true });
  appendUsage(join(sb.home, '.claude', 'ops', 'alpha-stream'), [
    rec({ work: 'order-exceptions/round-1', parent_work: 'order-exceptions/round-1', model: 'claude-opus-5-5', input: M, output: 100_000 }),
    rec({ work: 'order-exceptions/round-2', parent_work: 'order-exceptions/round-2', model: 'claude-sonnet-5-5', input: M, output: M }),
    rec({ agent_id: 'ses_arch', agent: ARCH, work: 'order-exceptions/arch', parent_work: 'order-exceptions/round-1', model: 'claude-opus-5-5', output: M }),
  ]);
}

// No OpenCode is asked: --no-refresh reports the log as it is.
const report = (sb, args = []) => runNode(COST, { args: ['--json', '--no-refresh', ...args], cwd: sb.project, env: sb.env }).then((r) => ({ ...r, json: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null }));
const group = (json, key) => json.groups.find((g) => g.key === key);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} is not about ${expected}`);

describe('cost.mjs', () => {
  test('reports each unit of work and the total', async (t) => {
    const sb = project(t);
    seed(sb);
    const r = await report(sb);
    assert.equal(r.status, 0, r.stderr);
    near(group(r.json, 'order-exceptions/round-1').usd, 6);
    near(group(r.json, 'order-exceptions/round-2').usd, 12);
    near(group(r.json, 'order-exceptions/arch').usd, 20);
    near(r.json.total_usd, 38);
  });

  test('--work matches by prefix: a package covers all its rounds; a round only itself', async (t) => {
    const sb = project(t);
    seed(sb);
    near((await report(sb, ['--work', 'order-exceptions'])).json.total_usd, 38);
    const round2 = await report(sb, ['--work', 'order-exceptions/round-2']);
    near(round2.json.total_usd, 12);
    assert.deepEqual(round2.json.groups.map((g) => g.key), ['order-exceptions/round-2']);
    assert.equal((await report(sb, ['--work', 'something-else'])).json.groups.length, 0);
  });

  test('--work also finds a dispatched agent by the work its lead was on', async (t) => {
    // The architect is tagged "arch", but it ran during round-1: asking for round-1 should
    // include it through parent_work.
    const sb = project(t);
    seed(sb);
    near((await report(sb, ['--work', 'order-exceptions/round-1'])).json.total_usd, 6 + 20);
  });

  test('--by agent, model and session regroup the same money', async (t) => {
    const sb = project(t);
    seed(sb);
    const byAgent = await report(sb, ['--by', 'agent']);
    near(group(byAgent.json, LEAD).usd, 18);
    near(group(byAgent.json, ARCH).usd, 20);
    const byModel = await report(sb, ['--by', 'model']);
    near(group(byModel.json, 'claude-opus-5-5').usd, 26);
    near(group(byModel.json, 'claude-sonnet-5-5').usd, 12);
    assert.deepEqual((await report(sb, ['--by', 'session'])).json.groups.map((g) => g.key), ['s-lead']);
  });

  test('names the lead among the biggest spenders and sorts work by cost', async (t) => {
    const sb = project(t);
    seed(sb);
    const r = await report(sb);
    assert.equal(r.json.groups[0].key, 'order-exceptions/arch');
    assert.ok(ARCH in r.json.groups[0].by_agent);
    const text = await runNode(COST, { args: ['--no-refresh', '--work', 'order-exceptions/round-2'], cwd: sb.project, env: sb.env });
    assert.match(text.stdout, new RegExp(`${LEAD} \\(lead\\)`));
  });

  test('--since leaves out work that ended before the date', async (t) => {
    const sb = project(t);
    seed(sb); // records are timestamped 2026-10-12
    assert.equal((await report(sb, ['--since', '2026-10-12'])).json.groups.length, 3);
    assert.equal((await report(sb, ['--since', '2026-10-13'])).json.groups.length, 0);
  });

  test('a model with no price is reported as unpriced, not as free', async (t) => {
    const sb = project(t);
    mkdirSync(join(sb.home, '.claude', 'ops', 'alpha-stream'), { recursive: true });
    appendUsage(join(sb.home, '.claude', 'ops', 'alpha-stream'), [rec({ work: 'pkg/round-1', parent_work: 'pkg/round-1', model: 'claude-future-9', input: M })]);
    const r = await report(sb);
    assert.equal(group(r.json, 'pkg/round-1').unpriced_models, true);
    const text = await runNode(COST, { args: ['--no-refresh'], cwd: sb.project, env: sb.env });
    assert.match(text.stdout, /unpriced/);
  });

  test('the default output is a markdown table with a total', async (t) => {
    const sb = project(t);
    seed(sb);
    const r = await runNode(COST, { args: ['--no-refresh'], cwd: sb.project, env: sb.env });
    assert.match(r.stdout, /^# Cost, by work/m);
    assert.match(r.stdout, /\| order-exceptions\/arch \| \$20\.00 \|/);
    assert.match(r.stdout, /\*\*Total\*\* \| \*\*\$38\.00\*\*/);
    assert.match(r.stdout, /API-equivalent estimate/);
  });

  test('says so when nothing has been recorded', async (t) => {
    const sb = project(t);
    const r = await runNode(COST, { args: ['--no-refresh'], cwd: sb.project, env: sb.env });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No usage recorded yet/);
  });

  test('--export without an endpoint says how to set one up', async (t) => {
    const sb = project(t);
    const r = await runNode(COST, { args: ['--no-refresh', '--export'], cwd: sb.project, env: sb.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TEAM_OPS_OTLP_ENDPOINT/);
  });
});
