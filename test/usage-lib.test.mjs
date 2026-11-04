// What the usage reports are built on: attributing work, the usage log, and pricing. The failure
// modes that matter are silent ones: attributing a ticket's spend to the wrong work, a stale
// snapshot added to a newer one, pricing a model at its neighbor's rate. How OpenCode's sessions
// become records is in usage-opencode.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox, ts, readJsonl as readJsonlFile } from './helpers.mjs';
import { appendUsage, currentUsage, costOf, pricesAsOf, tagAt, bracketTag } from '../plugins/team-ops/scripts/usage-lib.mjs';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

describe('work tags', () => {
  test('tagAt: usage before the first tag belongs to the first tag; later usage to the latest in effect', () => {
    const tags = [{ at: ts(10), tag: 'A' }, { at: ts(20), tag: 'B' }];
    assert.equal(tagAt(tags, ts(1)), 'A');
    assert.equal(tagAt(tags, ts(10)), 'A');
    assert.equal(tagAt(tags, ts(19)), 'A');
    assert.equal(tagAt(tags, ts(20)), 'B');
    assert.equal(tagAt(tags, ts(999)), 'B');
    assert.equal(tagAt([], ts(1)), null);
  });

  test('bracketTag takes only a leading [TAG]', () => {
    assert.equal(bracketTag('[CLOUD-123] implement retry'), 'CLOUD-123');
    assert.equal(bracketTag('  [order-exceptions/phase-1] build it'), 'order-exceptions/phase-1');
    assert.equal(bracketTag('implement [CLOUD-123] retry'), null);
    assert.equal(bracketTag('[two words] nope'), null);
    assert.equal(bracketTag(''), null);
    assert.equal(bracketTag(undefined), null);
  });
});

describe('the current view of the usage log', () => {
  const rec = (over) => ({ session: 's1', agent_id: 'main', agent: 'x:lead', work: 'w', model: OPUS, speed: 'standard', input: 0, output: 1, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, requests: 1, first: ts(1), last: ts(2), ...over });

  test('a later snapshot supersedes an earlier one for the same session and agent', (t) => {
    const sb = sandbox(t);
    appendUsage(sb.home, [rec({ snap: '2026-10-12T10:00:00Z', output: 100 })]);
    appendUsage(sb.home, [rec({ snap: '2026-10-12T11:00:00Z', output: 250 })]);
    const now = currentUsage(sb.home);
    assert.equal(now.length, 1);
    assert.equal(now[0].output, 250);
  });

  test('every record of the latest snapshot is kept, across models and work', (t) => {
    const sb = sandbox(t);
    appendUsage(sb.home, [rec({ snap: 'S1', work: 'a', output: 1 }), rec({ snap: 'S1', work: 'b', output: 2 })]);
    appendUsage(sb.home, [rec({ snap: 'S2', work: 'a', output: 10 }), rec({ snap: 'S2', work: 'b', output: 20 })]);
    assert.deepEqual(currentUsage(sb.home).map((r) => r.output).sort((x, y) => x - y), [10, 20]);
  });

  test('agents and sessions are superseded independently', (t) => {
    const sb = sandbox(t);
    appendUsage(sb.home, [rec({ snap: 'S1', agent_id: 'main', output: 1 }), rec({ snap: 'S1', agent_id: 'sub', output: 2 })]);
    appendUsage(sb.home, [rec({ snap: 'S2', agent_id: 'main', output: 10 })]); // sub has no newer snapshot
    appendUsage(sb.home, [rec({ snap: 'S1', session: 's2', output: 5 })]);
    const now = currentUsage(sb.home);
    assert.deepEqual(now.map((r) => `${r.session}/${r.agent_id}=${r.output}`).sort(), ['s1/main=10', 's1/sub=2', 's2/main=5']);
  });

  test('an empty or missing log is empty', (t) => {
    const sb = sandbox(t);
    assert.deepEqual(currentUsage(sb.home), []);
    appendUsage(sb.home, []);
    assert.deepEqual(currentUsage(sb.home), []);
  });

  test('appendUsage writes one JSON object per line', (t) => {
    const sb = sandbox(t);
    appendUsage(sb.home, [rec({ snap: 'S1' }), rec({ snap: 'S1', work: 'other' })]);
    assert.equal(readJsonlFile(join(sb.home, 'usage.jsonl')).length, 2);
  });
});

describe('pricing', () => {
  const million = (over) => ({ model: OPUS, speed: 'standard', input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, ...over });

  test('prices every token class at its own rate', () => {
    // opus-5-5 per million: input 4, output 20, 5m write 5, 1h write 8, read 0.2
    assert.equal(costOf(million({ input: 1e6, output: 1e5 })), 4 + 2);
    assert.ok(Math.abs(costOf(million({ input: 1e6, output: 1e6, cache_write_5m: 1e6, cache_write_1h: 1e6, cache_read: 1e6 })) - 37.2) < 1e-9);
  });

  test('fast mode doubles every class', () => {
    assert.equal(costOf(million({ input: 1e6, output: 1e5, speed: 'fast' })), 12);
  });

  test('the longest matching model prefix wins, so a point release is not priced as its major', () => {
    // opus-5-5 is $4 in; opus-5 is $5 in. Matching "claude-opus-5" first would overcharge.
    assert.equal(costOf(million({ model: 'claude-opus-5-5', input: 1e6 })), 4);
    assert.equal(costOf(million({ model: 'claude-opus-5-1', input: 1e6 })), 5);
    // fable-5-1 and fable-5 differ only in cache-read price.
    assert.equal(costOf(million({ model: 'claude-fable-5-1', cache_read: 1e6 })), 0.25);
    assert.equal(costOf(million({ model: 'claude-fable-5', cache_read: 1e6 })), 1);
  });

  test('model ids with a date or a context suffix still match', () => {
    assert.equal(costOf(million({ model: 'claude-opus-5-5-20260301', input: 1e6 })), 4);
    assert.equal(costOf(million({ model: 'claude-opus-5-5[1m]', input: 1e6 })), 4);
  });

  test('provider-prefixed ids with dotted versions, as OpenRouter names them, match', () => {
    assert.equal(costOf(million({ model: 'anthropic/claude-opus-5.5', input: 1e6 })), 4);
    assert.equal(costOf(million({ model: 'anthropic/claude-sonnet-5.5', output: 1e6 })), 10);
    assert.equal(costOf(million({ model: 'anthropic/claude-haiku-5.5', input: 1e6 })), 0.1);
  });

  test('a model with no price is unpriced, never free', () => {
    assert.equal(costOf(million({ model: 'claude-future-9', input: 1e6 })), null);
  });

  test('records the date of the price table it used', () => {
    assert.match(pricesAsOf(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
