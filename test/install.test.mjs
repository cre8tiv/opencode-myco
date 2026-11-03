// The installer turns Claude Code agent files into OpenCode ones. OpenCode ignores
// frontmatter keys it doesn't know and forwards them to the model provider, so a key
// that slips through is sent over the wire; these tests pin what the installed agents
// may contain, and that a reinstall touches only what the installer owns.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, sandbox } from './helpers.mjs';
import { install, transformAgent, parseModelRef, checkModels } from '../scripts/install.mjs';

const INSTALL = join(ROOT, 'scripts', 'install.mjs');
const ALLOWED_KEYS = new Set(['description', 'mode', 'model', 'variant', 'permission']);
const read = (p) => readFileSync(p, 'utf8');

/** Top-level keys of an installed agent's frontmatter. */
const topKeys = (text) => [...text.match(/^---\n([\s\S]*?)\n---/)[1].matchAll(/^([A-Za-z_][\w-]*):/gm)].map((m) => m[1]);

const SOURCE = '---\nname: x\ndescription: Does a thing: with a colon, and "quotes".\nmodel: claude-opus-5-5\nisolation: worktree\ndisallowedTools: Edit, Write\n---\n\nBody line one.\n\n```sh\necho "$HOME"\n```\n';

describe('transformAgent', () => {
  test('keeps the description and body exactly, drops every Claude Code key, adds the mode', () => {
    const out = transformAgent({ id: 'engineering-team/ic-generalist', text: SOURCE });
    assert.deepEqual(topKeys(out), ['description', 'mode']);
    assert.match(out, /^mode: subagent$/m);
    // The description is written as a JSON string, which YAML reads as a double-quoted scalar.
    assert.equal(JSON.parse(out.match(/^description: (.*)$/m)[1]), 'Does a thing: with a colon, and "quotes".');
    assert.equal(out.slice(out.indexOf('\n---\n') + 5), SOURCE.slice(SOURCE.indexOf('\n---\n', 4) + 5), 'body must be byte-identical');
  });

  test('read-only roles get permission rules instead of disallowedTools', () => {
    const reviewer = transformAgent({ id: 'engineering-team/code-reviewer', text: SOURCE });
    assert.match(reviewer, /^permission:\n {2}edit: deny$/m);
    assert.doesNotMatch(reviewer, /disallowedTools/);
  });

  test('agent-coach may write reports under a relative or an absolute path, and nowhere else', () => {
    const coach = transformAgent({ id: 'team-ops/agent-coach', text: SOURCE });
    // "*" first, then the allows: the last matching rule wins.
    const rules = [...coach.matchAll(/^ {4}"([^"]+)": (\w+)$/gm)].map((m) => [m[1], m[2]]);
    assert.deepEqual(rules, [['*', 'deny'], ['.claude/ops/reports/**', 'allow'], ['*/.claude/ops/reports/**', 'allow']]);
  });

  test('a model mapping sets model and variant by tier, and a per-agent entry wins', () => {
    const models = checkModels({ tiers: { worker: 'p/small#low', reasoning: 'p/big' }, agents: { 'engineering-team/code-reviewer': 'q/other#high' } });
    const worker = transformAgent({ id: 'engineering-team/ic-generalist', text: SOURCE, models });
    assert.match(worker, /^model: "p\/small"$/m);
    assert.match(worker, /^variant: "low"$/m);
    const reviewer = transformAgent({ id: 'engineering-team/code-reviewer', text: SOURCE, models });
    assert.match(reviewer, /^model: "q\/other"$/m);
    assert.match(reviewer, /^variant: "high"$/m);
    const architect = transformAgent({ id: 'design-team/architect', text: SOURCE, models });
    assert.match(architect, /^model: "p\/big"$/m);
    assert.doesNotMatch(architect, /variant/);
  });

  test('without a mapping no model is written, so the agent uses the user\'s default', () => {
    assert.doesNotMatch(transformAgent({ id: 'design-team/architect', text: SOURCE }), /^model:/m);
  });

  test('refuses what it cannot translate faithfully', () => {
    assert.throws(() => transformAgent({ id: 'design-team/unknown', text: SOURCE }), /not in scripts\/opencode-agents/);
    assert.throws(() => transformAgent({ id: 'design-team/architect', text: '---\nname: a\n---\nbody' }), /no description/);
    assert.throws(() => transformAgent({ id: 'design-team/architect', text: '---\ndescription: a\ntools:\n  - Read\n---\n' }), /unsupported frontmatter/);
    assert.throws(() => transformAgent({ id: 'design-team/architect', text: 'no frontmatter' }), /no frontmatter/);
  });

  test('model references and tiers are validated', () => {
    assert.deepEqual(parseModelRef('a/b-c.d#high'), { model: 'a/b-c.d', variant: 'high' });
    assert.deepEqual(parseModelRef('a/b/c'), { model: 'a/b/c' });
    for (const bad of ['nomodel', 'a/', '/b', 'a/b#', 'a b/c']) assert.throws(() => parseModelRef(bad), /not provider\/model/, bad);
    assert.throws(() => checkModels({ tiers: { nope: 'a/b' } }), /unknown tier/);
    assert.throws(() => checkModels({ agents: { 'x/y': 'a/b' } }), /unknown agent/);
  });
});

describe('install', () => {
  test('every agent in plugins/ is in the install map and the map has nothing extra', (t) => {
    // install() enforces this; a rename that forgets the map must fail here, not at a user's machine.
    const sb = sandbox(t);
    assert.doesNotThrow(() => install({ target: join(sb.root, 'out') }));
  });

  test('lays out agents, skills, team assets and the plugin', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    const result = install({ target });
    assert.equal(result.agents.length, 11);
    assert.equal(result.skills.length, 7);
    for (const id of result.agents) assert.ok(existsSync(join(target, 'agents', `${id}.md`)), id);
    for (const s of result.skills) assert.ok(existsSync(join(target, 'skills', s, 'SKILL.md')), s);
    assert.ok(existsSync(join(target, 'myco', 'team-ops', 'scripts', 'friction.mjs')));
    assert.ok(existsSync(join(target, 'myco', 'design-team', 'templates', 'prd-template.md')));
    assert.ok(existsSync(join(target, 'plugins', 'myco', 'index.js')));
  });

  test('every installed agent contains only keys OpenCode understands', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    for (const team of readdirSync(join(target, 'agents'))) {
      for (const f of readdirSync(join(target, 'agents', team))) {
        const text = read(join(target, 'agents', team, f));
        for (const k of topKeys(text)) assert.ok(ALLOWED_KEYS.has(k), `${team}/${f} carries "${k}"`);
        assert.match(text, /^description: ".{30,}"$/m, `${team}/${f}`);
      }
    }
  });

  test('a reinstall replaces what it owns and leaves everything else alone', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    // The user's own files, and a stale file in a directory the installer owns.
    mkdirSync(join(target, 'agents'), { recursive: true });
    writeFileSync(join(target, 'agents', 'mine.md'), 'mine');
    mkdirSync(join(target, 'skills', 'mine'), { recursive: true });
    writeFileSync(join(target, 'skills', 'mine', 'SKILL.md'), 'mine');
    writeFileSync(join(target, 'myco', 'models.json'), '{"tiers":{"worker":"p/m"}}');
    writeFileSync(join(target, 'agents', 'team-ops', 'stale.md'), 'stale');
    writeFileSync(join(target, 'myco', 'team-ops', 'scripts', 'stale.mjs'), 'stale');

    install({ target, models: JSON.parse(read(join(target, 'myco', 'models.json'))) });
    assert.equal(read(join(target, 'agents', 'mine.md')), 'mine');
    assert.equal(read(join(target, 'skills', 'mine', 'SKILL.md')), 'mine');
    assert.equal(read(join(target, 'myco', 'models.json')), '{"tiers":{"worker":"p/m"}}');
    assert.equal(existsSync(join(target, 'agents', 'team-ops', 'stale.md')), false);
    assert.equal(existsSync(join(target, 'myco', 'team-ops', 'scripts', 'stale.mjs')), false);
    assert.match(read(join(target, 'agents', 'engineering-team', 'ic-generalist.md')), /^model: "p\/m"$/m);
  });

  test('an installed agent that was never mapped carries no model, even after remapping others', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target, models: { tiers: { lead: 'p/m' } } });
    assert.match(read(join(target, 'agents', 'engineering-team', 'tech-lead.md')), /^model: "p\/m"$/m);
    assert.doesNotMatch(read(join(target, 'agents', 'engineering-team', 'ic-generalist.md')), /^model:/m);
  });
});

describe('install CLI', () => {
  test('installs into --target, reading models from --models', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    const models = join(sb.root, 'models.json');
    writeFileSync(models, JSON.stringify({ tiers: { reasoning: 'p/big#medium' } }));
    const r = spawnSync(process.execPath, [INSTALL, '--target', target, '--models', models], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Installed 11 agents, 7 skills/);
    assert.match(read(join(target, 'agents', 'design-team', 'architect.md')), /^variant: "medium"$/m);
  });

  test('picks up <target>/myco/models.json when no --models is given', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    mkdirSync(join(target, 'myco'), { recursive: true });
    writeFileSync(join(target, 'myco', 'models.json'), JSON.stringify({ tiers: { lead: 'p/lead' } }));
    const r = spawnSync(process.execPath, [INSTALL, '--target', target], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(read(join(target, 'agents', 'design-team', 'product-lead.md')), /^model: "p\/lead"$/m);
  });

  test('needs somewhere to install, and says so', () => {
    const r = spawnSync(process.execPath, [INSTALL], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: install\.mjs/);
  });

  test('a bad mapping fails before anything is written', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    const models = join(sb.root, 'models.json');
    writeFileSync(models, JSON.stringify({ tiers: { lead: 'not-a-model' } }));
    const r = spawnSync(process.execPath, [INSTALL, '--target', target, '--models', models], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not provider\/model/);
    assert.equal(existsSync(target), false);
  });
});
