// The installer turns Claude Code agent files into OpenCode ones. OpenCode ignores
// frontmatter keys it doesn't know and forwards them to the model provider, so a key
// that slips through is sent over the wire; these tests pin what the installed agents
// may contain, and that a reinstall touches only what the installer owns.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, sandbox } from './helpers.mjs';
import { install, transformAgent } from '../scripts/install.mjs';
import { checkModels } from '../plugins/team-ops/scripts/models.mjs';

const INSTALL = join(ROOT, 'scripts', 'install.mjs');
const ALLOWED_KEYS = new Set(['description', 'mode', 'model', 'variant', 'permission']);
const read = (p) => readFileSync(p, 'utf8');

/** @returns {string} an installed agent's frontmatter; agent prompts mention gh pr merge in prose, so rules are checked here only */
const frontmatterOf = (text) => text.match(/^---\n([\s\S]*?)\n---/)[1];

/** Top-level keys of an installed agent's frontmatter. */
const topKeys = (text) => [...text.match(/^---\n([\s\S]*?)\n---/)[1].matchAll(/^([A-Za-z_][\w-]*):/gm)].map((m) => m[1]);

const SOURCE = '---\nname: x\ndescription: Does a thing: with a colon, and "quotes".\nmodel: claude-opus-5-5\nisolation: worktree\ndisallowedTools: Edit, Write\n---\n\nBody line one.\n\n```sh\necho "$HOME"\n```\n';

describe('transformAgent', () => {
  test('keeps the description and body exactly, drops every Claude Code key, adds the mode', () => {
    const out = transformAgent({ id: 'engineering-team/ic-generalist', text: SOURCE });
    // The merge backstop adds a permission block to every agent.
    assert.deepEqual(topKeys(out), ['description', 'mode', 'permission']);
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
    const editBlock = coach.match(/^ {2}edit:\n((?: {4}.*\n)+)/m)[1];
    const rules = [...editBlock.matchAll(/^ {4}"([^"]+)": (\w+)$/gm)].map((m) => [m[1], m[2]]);
    assert.deepEqual(rules, [['*', 'deny'], ['.claude/ops/reports/**', 'allow'], ['*/.claude/ops/reports/**', 'allow']]);
  });

  test('every agent denies gh pr merge, so the rule holds even if the plugin does not load', () => {
    for (const id of ['engineering-team/ic-generalist', 'design-team/architect', 'engineering-team/tech-lead']) {
      const out = transformAgent({ id, text: SOURCE });
      assert.match(out, /^permission:\n {2}shell:\n {4}"gh pr merge\*": deny\n {4}"gh \* pr merge\*": deny$/m, id);
    }
  });

  test('the backstop sits beside an agent\'s own rules, whichever actions they cover', () => {
    const reviewer = transformAgent({ id: 'engineering-team/code-reviewer', text: SOURCE });
    assert.match(reviewer, /^permission:\n {2}edit: deny\n {2}shell:\n {4}"gh pr merge\*": deny/m);
    const coach = transformAgent({ id: 'team-ops/agent-coach', text: SOURCE });
    assert.match(coach, /^ {2}edit:\n {4}"\*": deny/m);
    assert.match(coach, /^ {2}shell:\n {4}"gh pr merge\*": deny/m);
  });

  test('allowing autonomous merging leaves the backstop out and everything else as it was', () => {
    const open = transformAgent({ id: 'engineering-team/ic-generalist', text: SOURCE, mergeBackstop: false });
    assert.doesNotMatch(open, /permission|gh pr merge/);
    assert.equal(open, transformAgent({ id: 'engineering-team/ic-generalist', text: SOURCE }).replace(/permission:\n(?: {2,}.*\n)+/, ''));
    // An agent with rules of its own keeps them.
    assert.match(transformAgent({ id: 'engineering-team/code-reviewer', text: SOURCE, mergeBackstop: false }), /^permission:\n {2}edit: deny\n---/m);
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
    assert.throws(() => transformAgent({ id: 'design-team/unknown', text: SOURCE }), /not in plugins\/team-ops\/scripts\/opencode-agents/);
    assert.throws(() => transformAgent({ id: 'design-team/architect', text: '---\nname: a\n---\nbody' }), /no description/);
    assert.throws(() => transformAgent({ id: 'design-team/architect', text: '---\ndescription: a\ntools:\n  - Read\n---\n' }), /unsupported frontmatter/);
    assert.throws(() => transformAgent({ id: 'design-team/architect', text: 'no frontmatter' }), /no frontmatter/);
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
    assert.equal(result.skills.length, 8);
    for (const id of result.agents) assert.ok(existsSync(join(target, 'agents', `${id}.md`)), id);
    for (const s of result.skills) assert.ok(existsSync(join(target, 'skills', s, 'SKILL.md')), s);
    assert.ok(existsSync(join(target, 'myco', 'team-ops', 'scripts', 'friction-core.mjs')));
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

  test('installed agents and skills carry real paths, and every path they name exists', (t) => {
    // OpenCode doesn't substitute variables in agent or skill text, and a `read` call can't expand one.
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    const root = join(target, 'myco').split(sep).join('/');
    const files = [];
    const collect = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) collect(join(dir, e.name));
        else if (e.name.endsWith('.md')) files.push(join(dir, e.name));
      }
    };
    collect(join(target, 'agents'));
    collect(join(target, 'skills'));
    let named = 0;
    for (const f of files) {
      const text = read(f);
      assert.doesNotMatch(text, /\$MYCO_ROOT|CLAUDE_PLUGIN_ROOT/, f);
      // Every place the text names a path under the install root: take the path characters after it.
      for (let at = text.indexOf(`${root}/`); at >= 0; at = text.indexOf(`${root}/`, at + 1)) {
        // Up to whitespace or a closing quote or bracket (a Windows temp path can hold "~", as in RUNNER~1),
        // less any sentence punctuation that follows the path.
        const path = text.slice(at).match(/^[^\s"'`)\]]+/)[0].replace(/[.,;:]+$/, '');
        named++;
        assert.ok(existsSync(path), `${f} names ${path}, which was not installed`);
      }
    }
    assert.ok(named >= 20, `expected the agents and skills to name installed files, found ${named}`);
  });

  test('install writes the backstop into every agent by default, and not with mergeBackstop off', (t) => {
    const sb = sandbox(t);
    const gated = join(sb.root, 'gated');
    const open = join(sb.root, 'open');
    const { agents } = install({ target: gated });
    install({ target: open, mergeBackstop: false });
    assert.equal(agents.length, 11);
    for (const id of agents) {
      assert.match(frontmatterOf(read(join(gated, 'agents', `${id}.md`))), /^ {4}"gh pr merge\*": deny$/m, id);
      assert.doesNotMatch(frontmatterOf(read(join(open, 'agents', `${id}.md`))), /gh pr merge/, id);
    }
  });

  test('a reinstall without the option puts the backstop back, so the safe state is the default', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target, mergeBackstop: false });
    install({ target });
    assert.match(frontmatterOf(read(join(target, 'agents', 'engineering-team', 'ic-generalist.md'))), /gh pr merge/);
  });

  test('records what it installed, for the doctor', (t) => {
    const sb = sandbox(t);
    const target = join(sb.root, 'out');
    install({ target });
    const record = JSON.parse(read(join(target, 'myco', 'install.json')));
    assert.match(record.installedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(record.agents.length, 11);
    assert.equal(record.skills.length, 8);
    assert.equal(record.mergeBackstop, true);
    for (const team of ['design-team', 'engineering-team', 'team-ops']) {
      assert.equal(record.teams[team], JSON.parse(read(join(ROOT, 'plugins', team, 'meta.json'))).version, team);
    }
    assert.ok(record.source === null || /^[0-9a-f]{40}$/.test(record.source));
    // Rewritten on each install, so it follows the option.
    install({ target, mergeBackstop: false });
    assert.equal(JSON.parse(read(join(target, 'myco', 'install.json'))).mergeBackstop, false);
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
    assert.match(r.stdout, /Installed 11 agents, 8 skills/);
    assert.match(read(join(target, 'agents', 'design-team', 'architect.md')), /^variant: "medium"$/m);
    // The mapping becomes the install's own, so a later plain reinstall and models.mjs agree with it.
    assert.deepEqual(JSON.parse(read(join(target, 'myco', 'models.json'))), { tiers: { reasoning: 'p/big#medium' } });
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

  test('--allow-autonomous-merge leaves the backstop out, and says so', (t) => {
    const sb = sandbox(t);
    const gated = spawnSync(process.execPath, [INSTALL, '--target', join(sb.root, 'gated')], { encoding: 'utf8' });
    assert.equal(gated.status, 0, gated.stderr);
    assert.doesNotMatch(gated.stdout, /gh pr merge/);
    assert.match(frontmatterOf(read(join(sb.root, 'gated', 'agents', 'design-team', 'architect.md'))), /gh pr merge/);

    const open = spawnSync(process.execPath, [INSTALL, '--target', join(sb.root, 'open'), '--allow-autonomous-merge'], { encoding: 'utf8' });
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /agents may run `gh pr merge` where a project's merge_policy allows it/);
    assert.doesNotMatch(frontmatterOf(read(join(sb.root, 'open', 'agents', 'design-team', 'architect.md'))), /gh pr merge/);
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
