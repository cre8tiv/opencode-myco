// The model mapping is the one place a user's own models meet the teams. These tests pin
// how a mapping is validated and applied to installed agents, what the warnings say, and
// that the script works from an installed copy, which is where users run it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { install } from '../scripts/install.mjs';
import { AGENT_MAP, applyModels, checkModels, modelLines, parseModelRef, refFor, setModel, warnings } from '../plugins/team-ops/scripts/models.mjs';

const read = (p) => readFileSync(p, 'utf8');
const AGENT = '---\ndescription: "An agent."\nmode: subagent\n---\n\nBody.\n';

/** A catalog entry shaped like GET /api/model. */
const entry = (providerID, modelID, context, variants = ['low', 'medium']) => ({ providerID, modelID, limit: { context, output: 8000 }, variants: variants.map((id) => ({ id })) });

describe('references and mappings', () => {
  test('model references are provider/model or provider/model#variant', () => {
    assert.deepEqual(parseModelRef('a/b-c.d#high'), { model: 'a/b-c.d', variant: 'high' });
    assert.deepEqual(parseModelRef('a/b/c'), { model: 'a/b/c' });
    for (const bad of ['nomodel', 'a/', '/b', 'a/b#', 'a b/c']) assert.throws(() => parseModelRef(bad), /not provider\/model/, bad);
    assert.deepEqual(modelLines('p/m#low'), ['model: "p/m"', 'variant: "low"']);
  });

  test('tiers and agents in a mapping must exist, and an empty mapping is valid', () => {
    assert.throws(() => checkModels({ tiers: { nope: 'a/b' } }), /unknown tier/);
    assert.throws(() => checkModels({ agents: { 'x/y': 'a/b' } }), /unknown agent/);
    assert.throws(() => checkModels({ tiers: { lead: 'bad' } }), /not provider\/model/);
    assert.deepEqual(checkModels(undefined), { tiers: {}, agents: {} });
  });

  test('an agent takes its own entry, else its tier, else nothing', () => {
    const m = checkModels({ tiers: { worker: 'p/w' }, agents: { 'engineering-team/ic-generalist': 'q/own' } });
    assert.equal(refFor(m, 'engineering-team/ic-generalist'), 'q/own');
    assert.equal(refFor(m, 'engineering-team/ic-specialist-backend'), 'p/w');
    assert.equal(refFor(m, 'engineering-team/tech-lead'), undefined);
  });

  test('the install map has the three tiers the skill talks about', () => {
    assert.deepEqual(new Set(Object.values(AGENT_MAP).map((a) => a.tier)), new Set(['lead', 'reasoning', 'worker']));
  });
});

describe('setModel', () => {
  test('puts the model after the mode, replaces an earlier one, and removes it', () => {
    const set = setModel(AGENT, 'p/m#low');
    assert.equal(set, '---\ndescription: "An agent."\nmode: subagent\nmodel: "p/m"\nvariant: "low"\n---\n\nBody.\n');
    assert.equal(setModel(set, 'q/n'), '---\ndescription: "An agent."\nmode: subagent\nmodel: "q/n"\n---\n\nBody.\n', 'the old variant must not survive');
    assert.equal(setModel(set, undefined), AGENT);
  });

  test('touches only the frontmatter', () => {
    const body = '\nmodel: not-a-key\n---\nstill body\n';
    assert.ok(setModel(`---\ndescription: "x"\nmode: all\n---\n${body}`, 'p/m').endsWith(`---\n${body}`));
  });
});

describe('applyModels', () => {
  test('rewrites installed agents from the mapping and reports only the ones that changed', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    const agentsDir = join(target, 'agents');
    const m1 = checkModels({ tiers: { worker: 'p/w#low', reasoning: 'p/r' } });
    const changed = applyModels({ agentsDir, models: m1 });
    assert.ok(changed.includes('engineering-team/ic-generalist') && changed.includes('team-ops/agent-coach'));
    assert.ok(!changed.includes('engineering-team/tech-lead'), 'the lead tier is unmapped');
    assert.match(read(join(agentsDir, 'engineering-team', 'ic-generalist.md')), /^model: "p\/w"\nvariant: "low"$/m);
    assert.deepEqual(applyModels({ agentsDir, models: m1 }), [], 'applying the same mapping twice changes nothing');

    const changed2 = applyModels({ agentsDir, models: checkModels({ tiers: { worker: 'q/x' } }) });
    assert.ok(changed2.includes('engineering-team/ic-generalist') && changed2.includes('team-ops/agent-coach'));
    assert.doesNotMatch(read(join(agentsDir, 'team-ops', 'agent-coach.md')), /^model:/m, 'an unmapped tier goes back to the default');
    assert.doesNotMatch(read(join(agentsDir, 'engineering-team', 'ic-generalist.md')), /variant/);
  });
});

describe('warnings', () => {
  const agentsDir = (t) => {
    const sb = sandbox(t);
    install({ target: join(sb.root, 'out') });
    return join(sb.root, 'out', 'agents');
  };

  test('a model or variant OpenCode does not know is named', (t) => {
    const w = warnings({ models: checkModels({ tiers: { lead: 'p/ghost', worker: 'p/real#nope' } }), agentsDir: agentsDir(t), catalog: [entry('p', 'real', 200000)] });
    assert.ok(w.some((x) => /lead: "p\/ghost" is not a model OpenCode lists/.test(x)), w.join('\n'));
    assert.ok(w.some((x) => /worker: "p\/real" has no variant "nope" \(it has low, medium\)/.test(x)), w.join('\n'));
  });

  test('a context window smaller than the largest prompt on the model is flagged, a roomy one is not', (t) => {
    const dir = agentsDir(t);
    const models = checkModels({ tiers: { lead: 'p/small', worker: 'p/big', reasoning: 'p/big' } });
    const w = warnings({ models, agentsDir: dir, catalog: [entry('p', 'small', 8000), entry('p', 'big', 1000000)] });
    assert.equal(w.filter((x) => /declares a context/.test(x)).length, 1, w.join('\n'));
    assert.match(w.find((x) => /declares a context/.test(x)), /^p\/small: declares a context of 8000 tokens, but (design-team\/product-lead|engineering-team\/tech-lead) alone is about \d+/);
  });

  test('reviewers on the same model as the ICs lose independence, including when both use the default', (t) => {
    const dir = agentsDir(t);
    const same = warnings({ models: checkModels({ tiers: { worker: 'p/a', reasoning: 'p/a' } }), agentsDir: dir, catalog: null });
    assert.match(same.join('\n'), /code-reviewer and qa-specialist use the same model as the ICs \(p\/a\)/);
    const defaults = warnings({ models: checkModels({}), agentsDir: dir, catalog: null });
    assert.match(defaults.join('\n'), /\(your default model\)/);
    assert.deepEqual(warnings({ models: checkModels({ tiers: { worker: 'p/a', reasoning: 'p/b' } }), agentsDir: dir, catalog: null }), []);
  });

  test('a per-agent override can restore independence for one reviewer', (t) => {
    const dir = agentsDir(t);
    const models = checkModels({ tiers: { worker: 'p/a', reasoning: 'p/a' }, agents: { 'engineering-team/code-reviewer': 'p/b' } });
    const w = warnings({ models, agentsDir: dir, catalog: null }).join('\n');
    assert.match(w, /qa-specialist use the same model/);
    assert.doesNotMatch(w, /code-reviewer/);
  });
});

describe('models.mjs from an installed copy', () => {
  /** Installs into a sandbox and returns a runner for the installed script. */
  function installed(t, catalog = 'none') {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    let catalogEnv = catalog;
    if (catalog !== 'none') {
      catalogEnv = join(sb.root, 'catalog.json');
      writeFileSync(catalogEnv, JSON.stringify(catalog));
    }
    const run = (...args) => spawnSync(process.execPath, [join(target, 'myco', 'team-ops', 'scripts', 'models.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...sb.env, MYCO_MODELS_CATALOG: catalogEnv } });
    return { target, run };
  }

  test('set saves the mapping, updates the agents, and reports warnings; show reflects it', (t) => {
    const { target, run } = installed(t);
    const r = run('set', '--lead', 'p/lead#high', '--reasoning', 'p/big', '--worker', 'p/big', '--agent', 'engineering-team/code-reviewer=p/other');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(read(join(target, 'myco', 'models.json'))), { tiers: { lead: 'p/lead#high', reasoning: 'p/big', worker: 'p/big' }, agents: { 'engineering-team/code-reviewer': 'p/other' } });
    assert.match(read(join(target, 'agents', 'engineering-team', 'tech-lead.md')), /^model: "p\/lead"\nvariant: "high"$/m);
    assert.match(read(join(target, 'agents', 'engineering-team', 'code-reviewer.md')), /^model: "p\/other"$/m);
    assert.match(r.stdout, /could not ask OpenCode which models exist/);
    assert.match(r.stdout, /warning: qa-specialist use the same model as the ICs/);
    const show = run('show').stdout;
    assert.match(show, /engineering-team\/code-reviewer\s+reasoning\s+p\/other/);
    assert.match(show, /engineering-team\/ic-generalist\s+worker\s+p\/big/);
  });

  test('a later set replaces the mapping, and a reinstall keeps and applies it', (t) => {
    const { target, run } = installed(t);
    run('set', '--worker', 'p/w');
    run('set', '--lead', 'p/l');
    assert.doesNotMatch(read(join(target, 'agents', 'engineering-team', 'ic-generalist.md')), /^model:/m);
    install({ target, models: JSON.parse(read(join(target, 'myco', 'models.json'))) });
    assert.match(read(join(target, 'agents', 'engineering-team', 'tech-lead.md')), /^model: "p\/l"$/m);
  });

  test('check uses the catalog OpenCode reports', (t) => {
    const { run } = installed(t, [entry('p', 'known', 500000)]);
    run('set', '--worker', 'p/known', '--reasoning', 'p/ghost');
    const out = run('check').stdout;
    assert.match(out, /warning: reasoning: "p\/ghost" is not a model OpenCode lists/);
    assert.doesNotMatch(out, /could not ask OpenCode/);
  });

  test('a bad mapping is refused and changes nothing', (t) => {
    const { target, run } = installed(t);
    const before = read(join(target, 'agents', 'engineering-team', 'tech-lead.md'));
    const r = run('set', '--lead', 'not-a-model');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not provider\/model/);
    assert.equal(read(join(target, 'agents', 'engineering-team', 'tech-lead.md')), before);
    assert.equal(existsSync(join(target, 'myco', 'models.json')), false);
  });

  test('refuses to run from the source tree, where there is nothing installed', () => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'plugins', 'team-ops', 'scripts', 'models.mjs'), 'show'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not an installed copy/);
  });
});
