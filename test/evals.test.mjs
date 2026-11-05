// The eval cases are run by `claude plugin eval`, which is slow, costs money and is
// noisy, so mistakes in the cases themselves should be caught here, for free. The one
// that matters most: the eval sandbox loads only the plugins a case lists, and a plugin
// whose dependency isn't listed is skipped entirely, silently scoring 0 on every run.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './helpers.mjs';
import { caseDirs, loadCase } from '../scripts/eval-lib.mjs';

const EVALS = join(ROOT, 'evals');
const GRADER_TYPES = new Set(['regex', 'tool_used', 'llm']);
const TOOLS = new Set(['read', 'glob', 'grep', 'skill', 'subagent', 'delegate', 'edit', 'write', 'shell', 'webfetch', 'websearch']);
const read = (p) => readFileSync(p, 'utf8');

const pluginDirs = readdirSync(join(ROOT, 'plugins')).map((n) => join(ROOT, 'plugins', n));
const skillsOf = (dir) => (existsSync(join(dir, 'skills')) ? readdirSync(join(dir, 'skills')) : []);
const allSkills = pluginDirs.flatMap(skillsOf);

const cases = caseDirs(EVALS).map((d) => loadCase(d, EVALS));

test('there are eval cases to check', () => {
  assert.ok(cases.length >= 10, `found ${cases.length}`);
});

describe('every case', () => {
  for (const c of cases) {
    test(`${c.name}: has a prompt and graders of a known type, and only names tools OpenCode has`, () => {
      assert.ok(c.prompt.length > 20, 'a case needs a prompt');
      assert.ok(c.graders.length > 0, 'a case with no grader scores nothing');
      for (const g of c.graders) {
        assert.ok(GRADER_TYPES.has(g.type), `${g.file}: type "${g.type}"`);
        if (g.type === 'tool_used') assert.ok(g.tool, `${g.file}: tool_used needs a tool`);
        if (g.type === 'regex') assert.doesNotThrow(() => new RegExp(g.pattern, g.flags || ''), `${g.file}: the pattern`);
        if (g.input_match) assert.doesNotThrow(() => new RegExp(g.input_match), `${g.file}: input_match`);
        if (g.type === 'llm') assert.ok(g.text.length > 20, `${g.file}: an llm grader needs a rubric`);
      }
      for (const t of c.tools) assert.ok(TOOLS.has(t), `tools: "${t}" is not an OpenCode tool`);
    });

    test(`${c.name}: no Claude Code names are left in the prompt or graders`, () => {
      const claude = /\b(Skill|Agent|Write|Bash)\b(?=\s*(tool|:))|\b(design-team|engineering-team|team-ops):[a-z]/;
      assert.doesNotMatch(c.prompt, claude);
      for (const g of c.graders) assert.doesNotMatch(`${g.tool || ''} ${g.input_match || ''}`, /^(Skill|Agent|Write|Bash)\b/, g.file);
    });

    test(`${c.name}: its scaffold script, if any, exists`, () => {
      const yaml = existsSync(join(c.dir, 'case.yaml')) ? read(join(c.dir, 'case.yaml')) : '';
      if (c.scaffold) assert.ok(existsSync(c.scaffold), relative(ROOT, c.scaffold));
      if (yaml) assert.equal(yaml.match(/^name:\s*(\S+)/m)?.[1], c.dir.split(/[\\/]/).pop(), 'case.yaml name should match its directory');
    });
  }

  test('case names are unique', () => {
    const names = cases.map((c) => c.dir.split(/[\\/]/).pop());
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  });
});

describe('skill-trigger cases', () => {
  /** The skill a tool_used grader names, and whether it expects the skill to fire. */
  const skillGraders = cases.flatMap((c) =>
    c.graders
      .filter((g) => g.type === 'tool_used' && /^skill\b/.test(g.tool) && g.input_match)
      .map((g) => ({ c, skill: g.input_match.match(/"id"\\s\*:\\s\*"([\w-]+)"/)?.[1], fires: g.max !== '0' })),
  );

  test('every grader names a skill that exists', () => {
    for (const { c, skill } of skillGraders) {
      assert.ok(skill, `${c.name}: could not read a skill name from input_match`);
      assert.ok(allSkills.includes(skill), `${c.name}: no skill "${skill}"`);
    }
  });

  test('every skill in the repository has a case that expects it to fire', () => {
    const missing = allSkills.filter((skill) => !skillGraders.some((g) => g.skill === skill && g.fires));
    assert.deepEqual(missing, []);
  });

  test("positive prompts do not borrow the skill's own words", () => {
    // A model matches a prompt to a skill by its description, but also by its name. A
    // prompt that says "friction" for a skill called log-friction passes even when the
    // description is replaced with nonsense (checked, once, by doing exactly that), so
    // it measures nothing about the description it is meant to protect.
    for (const { c, skill, fires } of skillGraders) {
      if (!fires) continue;
      const prompt = c.prompt.toLowerCase();
      for (const word of skill.split('-').filter((w) => w.length > 3)) {
        assert.equal(new RegExp(`\\b${word}\\b`).test(prompt), false, `${c.name}: the prompt says "${word}", part of the skill name "${skill}"`);
      }
    }
  });
});
