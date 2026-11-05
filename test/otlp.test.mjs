// OpenTelemetry export. The two things that matter: the data the backend receives is
// shaped so cost and friction can be joined by unit of work, and telemetry never breaks
// a run, never leaks free text it wasn't asked to, and never runs when it isn't set up.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, collector, writeProfile, readJsonl, opsFile, attrMap } from './helpers.mjs';
import { signalUrl, buildMetrics, buildEvent, eventName, exportSessions, exportEvent } from '../plugins/team-ops/scripts/otlp.mjs';
import { appendUsage } from '../plugins/team-ops/scripts/usage-lib.mjs';
import { recordEvent } from '../plugins/team-ops/scripts/capture-core.mjs';
import { recordFriction } from '../plugins/team-ops/scripts/friction-core.mjs';

const M = 1_000_000;
const ENV_KEYS = ['TEAM_OPS_OTLP_ENDPOINT', 'TEAM_OPS_OTLP_HEADERS', 'TEAM_OPS_OTLP_RESOURCE_ATTRIBUTES', 'TEAM_OPS_OTLP_LOG_CONTENT'];
const saved = {};
beforeEach(() => ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

const row = (over = {}) => ({
  session: 's1', agent_id: 'main', agent: 'design-team/product-lead', work: 'order-exceptions/round-1', parent_work: 'order-exceptions/round-1',
  model: 'claude-opus-5-5', speed: 'standard', input: M, output: 100_000, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, requests: 3,
  first: '2026-10-12T10:00:00.000Z', last: '2026-10-12T10:30:00.000Z', snap: '2026-10-12T11:00:00.000Z', ...over,
});

describe('endpoint configuration', () => {
  test('export is off unless an endpoint is set', () => {
    assert.equal(signalUrl('metrics'), null);
    assert.equal(signalUrl('logs'), null);
  });

  test('accepts a base URL, a trailing slash, or a full signal URL', () => {
    for (const e of ['http://localhost:4318', 'http://localhost:4318/', 'http://localhost:4318/v1/metrics', 'http://localhost:4318/v1/logs/']) {
      process.env.TEAM_OPS_OTLP_ENDPOINT = e;
      assert.equal(signalUrl('metrics'), 'http://localhost:4318/v1/metrics', e);
      assert.equal(signalUrl('logs'), 'http://localhost:4318/v1/logs', e);
    }
  });

  test('keeps a path prefix, as behind a gateway', () => {
    process.env.TEAM_OPS_OTLP_ENDPOINT = 'https://otel.example.com/team-a';
    assert.equal(signalUrl('logs'), 'https://otel.example.com/team-a/v1/logs');
  });
});

describe('metrics', () => {
  test('cost and token usage per unit of work, as cumulative monotonic sums', () => {
    const body = buildMetrics([row()], { session: 's1', stream: 'alpha' });
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
    assert.deepEqual(metrics.map((m) => m.name), ['team_ops.work.cost', 'team_ops.work.token.usage']);
    for (const m of metrics) {
      assert.equal(m.sum.aggregationTemporality, 2); // cumulative
      assert.equal(m.sum.isMonotonic, true);
    }
    const [cost] = metrics[0].sum.dataPoints;
    assert.equal(cost.asDouble, 6); // 1M in at $4 + 100K out at $20
    assert.deepEqual(attrMap(cost.attributes), {
      'team_ops.stream': 'alpha', agent: 'design-team/product-lead', work: 'order-exceptions/round-1', parent_work: 'order-exceptions/round-1', model: 'claude-opus-5-5', speed: 'standard',
    });
  });

  test('token usage has one point per token class', () => {
    const body = buildMetrics([row({ cache_write_5m: 300, cache_write_1h: 200, cache_read: 9000 })], { session: 's1', stream: 'alpha' });
    const points = body.resourceMetrics[0].scopeMetrics[0].metrics[1].sum.dataPoints;
    const byType = Object.fromEntries(points.map((p) => [attrMap(p.attributes).type, p.asInt]));
    assert.deepEqual(byType, { input: String(M), output: '100000', cacheRead: '9000', cacheCreation: '500' });
  });

  test('instances of one agent type on the same work are summed into one point', () => {
    const body = buildMetrics([row({ agent_id: 'a', output: 10 }), row({ agent_id: 'b', output: 30 })], { session: 's1', stream: 'alpha' });
    const points = body.resourceMetrics[0].scopeMetrics[0].metrics[1].sum.dataPoints.filter((p) => attrMap(p.attributes).type === 'output');
    assert.equal(points.length, 1);
    assert.equal(points[0].asInt, '40');
  });

  test('different work, model or speed stay separate points', () => {
    const body = buildMetrics([row(), row({ work: 'order-exceptions/arch' }), row({ speed: 'fast' }), row({ model: 'claude-sonnet-5-5' })], { session: 's1', stream: 'alpha' });
    assert.equal(body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints.length, 4);
  });

  test('untagged work is labeled rather than dropped', () => {
    const body = buildMetrics([row({ work: null, parent_work: null })], { session: 's1', stream: 'alpha' });
    const [p] = body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints;
    assert.equal(attrMap(p.attributes).work, '(untagged)');
  });

  test('the session is a resource attribute, and extra resource attributes come from the environment', () => {
    process.env.TEAM_OPS_OTLP_RESOURCE_ATTRIBUTES = 'team.id=platform,deployment.environment=ci';
    const { resource } = buildMetrics([row()], { session: 's1', stream: 'alpha' }).resourceMetrics[0];
    assert.deepEqual(attrMap(resource.attributes), { 'service.name': 'team-ops', 'service.instance.id': 's1', 'session.id': 's1', 'team.id': 'platform', 'deployment.environment': 'ci' });
  });

  test('a session with no rows exports nothing', () => {
    assert.equal(buildMetrics([], { session: 's1', stream: 'alpha' }), null);
  });
});

describe('events', () => {
  const failure = { ts: '2026-10-12T10:00:00.000Z', event: 'PostToolUseFailure', agent: 'engineering-team/ic-generalist', agent_id: 'ic1', session: 's1', work: 'CLOUD-1', tool: 'shell', mode: 'default', target: 'npm test', error: 'jest: not found with token sk-live-123', report: 'internal notes' };
  const note = { ts: '2026-10-12T10:00:00.000Z', agent: 'architect', session: 's1', work: 'pkg/round-1', kind: 'tooling', note: 'figma connector not authorized' };
  const logRecord = (body) => body.resourceLogs[0].scopeLogs[0].logRecords[0];

  test('names hook events and friction consistently', () => {
    assert.equal(eventName('PostToolUseFailure'), 'team_ops.tool_failure');
    assert.equal(eventName('SubagentStop'), 'team_ops.agent_stop');
    assert.equal(eventName('friction'), 'team_ops.friction');
    assert.equal(eventName('SomethingNew'), 'team_ops.SomethingNew');
  });

  test('carries the same fields as the cost metrics, so a backend can join them', () => {
    const rec = logRecord(buildEvent(failure, 'event', 'alpha'));
    const a = attrMap(rec.attributes);
    assert.equal(a['event.name'], 'team_ops.tool_failure');
    assert.equal(a['team_ops.stream'], 'alpha');
    assert.equal(a.agent, 'engineering-team/ic-generalist');
    assert.equal(a.work, 'CLOUD-1');
    assert.equal(a['tool.name'], 'shell');
    assert.equal(rec.eventName, 'team_ops.tool_failure');
  });

  test('failures and friction are warnings; the rest are info', () => {
    assert.equal(logRecord(buildEvent(failure, 'event', 'a')).severityText, 'WARN');
    assert.equal(logRecord(buildEvent(note, 'friction', 'a')).severityText, 'WARN');
    assert.equal(logRecord(buildEvent({ ...failure, event: 'SubagentStop' }, 'event', 'a')).severityText, 'INFO');
  });

  test('free text stays out by default: no commands, errors, reports or friction notes', () => {
    for (const [rec, kind] of [[failure, 'event'], [note, 'friction']]) {
      const out = logRecord(buildEvent(rec, kind, 'alpha'));
      const wire = JSON.stringify(out);
      assert.equal(out.body, undefined);
      for (const secret of ['npm test', 'sk-live-123', 'internal notes', 'figma connector']) assert.equal(wire.includes(secret), false, secret);
    }
    assert.equal(attrMap(logRecord(buildEvent(note, 'friction', 'alpha')).attributes)['friction.kind'], 'tooling');
  });

  test('free text is included only when asked for', () => {
    process.env.TEAM_OPS_OTLP_LOG_CONTENT = '1';
    const f = logRecord(buildEvent({ ...failure, report: undefined }, 'event', 'alpha'));
    assert.equal(attrMap(f.attributes)['tool.target'], 'npm test');
    assert.match(f.body.stringValue, /jest: not found/);
    assert.equal(logRecord(buildEvent(note, 'friction', 'alpha')).body.stringValue, 'figma connector not authorized');
  });

  test('a record with no session is still exportable', () => {
    const body = buildEvent({ ...failure, session: undefined }, 'event', 'alpha');
    assert.equal(attrMap(body.resourceLogs[0].resource.attributes)['session.id'], 'unknown');
  });
});

describe('exporting', () => {
  test('exportSessions posts a session’s current usage, with configured headers', async (t) => {
    const sb = sandbox(t);
    const c = await collector(t);
    process.env.TEAM_OPS_OTLP_ENDPOINT = c.url;
    process.env.TEAM_OPS_OTLP_HEADERS = 'Authorization=Bearer abc123,X-Team=platform';
    appendUsage(sb.home, [row(), row({ session: 's-other' })]);
    const result = await exportSessions(sb.home, 'alpha', ['s1']);
    assert.deepEqual(result, { exported: 1, error: undefined });
    assert.equal(c.requests.length, 1);
    assert.equal(c.requests[0].path, '/v1/metrics');
    assert.equal(c.requests[0].headers.authorization, 'Bearer abc123');
    assert.equal(c.requests[0].headers['x-team'], 'platform');
    assert.equal(attrMap(c.requests[0].body.resourceMetrics[0].resource.attributes)['session.id'], 's1');
  });

  test('is off, and does nothing, without an endpoint', async (t) => {
    const sb = sandbox(t);
    appendUsage(sb.home, [row()]);
    assert.equal(await exportSessions(sb.home, 'alpha', ['s1']), null);
    assert.equal(await exportEvent(sb.home, 'alpha', { ts: new Date().toISOString(), event: 'SessionEnd' }, 'event'), undefined);
    assert.equal(existsSync(join(sb.home, 'otlp-status.json')), false);
  });

  test('a backend error is reported and recorded, never thrown', async (t) => {
    const sb = sandbox(t);
    const c = await collector(t, { status: 503 });
    process.env.TEAM_OPS_OTLP_ENDPOINT = c.url;
    appendUsage(sb.home, [row()]);
    const result = await exportSessions(sb.home, 'alpha', ['s1']);
    assert.equal(result.exported, 0);
    assert.match(result.error, /HTTP 503/);
    const status = JSON.parse(readFileSync(join(sb.home, 'otlp-status.json'), 'utf8'));
    assert.equal(status.metrics.ok, false);
    assert.match(status.metrics.error, /503/);
  });

  test('an unreachable endpoint is reported quickly and never thrown', async (t) => {
    const sb = sandbox(t);
    process.env.TEAM_OPS_OTLP_ENDPOINT = 'http://127.0.0.1:1'; // nothing listens on port 1
    appendUsage(sb.home, [row()]);
    const started = Date.now();
    const result = await exportSessions(sb.home, 'alpha', ['s1'], { timeoutMs: 1500 });
    assert.ok(result.error, 'expected an error');
    assert.equal(result.exported, 0);
    assert.ok(Date.now() - started < 5000);
  });

  test('exportEvent sends one log record and notes success', async (t) => {
    const sb = sandbox(t);
    const c = await collector(t);
    process.env.TEAM_OPS_OTLP_ENDPOINT = c.url;
    const err = await exportEvent(sb.home, 'alpha', { ts: '2026-10-12T10:00:00.000Z', agent: 'architect', kind: 'tooling', note: 'secret note' }, 'friction');
    assert.equal(err, null);
    assert.equal(c.requests[0].path, '/v1/logs');
    assert.equal(JSON.stringify(c.requests[0].body).includes('secret note'), false);
  });
});

describe('through the recorders', () => {
  const AGENT = 'design-team/product-lead';

  /** Points HOME at the sandbox, where the stream lives, and the exporter at the collector. */
  function wired(t, sb, endpoint) {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = sb.home;
    process.env.USERPROFILE = sb.home;
    if (endpoint) process.env.TEAM_OPS_OTLP_ENDPOINT = endpoint;
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  test('a friction report reaches the backend, tied to its work, without its text', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'alpha-stream' });
    const c = await collector(t);
    wired(t, sb, c.url);
    await recordFriction({ cwd: sb.project, agent: AGENT, session: 's-f', work: 'pkg/round-2', kind: 'handoff', note: 'internal customer name Acme' });
    assert.equal(c.requests.length, 1);
    const rec = c.requests[0].body.resourceLogs[0].scopeLogs[0].logRecords[0];
    const a = attrMap(rec.attributes);
    assert.equal(a['event.name'], 'team_ops.friction');
    assert.equal(a['friction.kind'], 'handoff');
    assert.equal(a.work, 'pkg/round-2');
    assert.equal(JSON.stringify(c.requests[0].body).includes('Acme'), false);
    // The local record, which keeps the note, is the complete one.
    assert.equal(readJsonl(opsFile(sb.home, 'alpha-stream', 'friction.jsonl'))[0].note, 'internal customer name Acme');
  });

  test('an unreachable backend does not fail the recorder or lose the local record', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'alpha-stream' });
    wired(t, sb, 'http://127.0.0.1:1');
    await recordEvent({ event: 'PostToolUseFailure', agent: 'engineering-team/ic-generalist', cwd: sb.project, tool: 'shell', input: { command: 'x' } });
    assert.equal(readJsonl(opsFile(sb.home, 'alpha-stream', 'events.jsonl')).length, 1);
  });
});
