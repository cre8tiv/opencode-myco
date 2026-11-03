// The eval cases are run by `claude plugin eval`, which is slow, costs money and is
// noisy, so mistakes in the cases themselves should be caught here, for free. The one
// that matters most: the eval sandbox loads only the plugins a case lists, and a plugin
// whose dependency isn't listed is skipped entirely, silently scoring 0 on every run.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT } from './helpers.mjs';

const EVALS = join(ROOT, 'evals');
const read = (p) => readFileSync(p, 'utf8');
const GRADER_TYPES = new Set(['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline']);

/** @param {string} text @returns {Record<string, string>} flat frontmatter */
function frontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** @param {string | undefined} v an inline list, `[a, b]` or `["a", "b"]` @returns {string[]} */
const list = (v) => (v ? v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []);

/** @param {string} dir @returns {string[]} directories below dir that hold a case */
function caseDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (!e.isDirectory() || e.name === 'results') return [];
    const p = join(dir, e.name);
    return existsSync(join(p, 'prompt.md')) || existsSync(join(p, 'case.yaml')) ? [p] : caseDirs(p);
  });
}

const pluginDirs = readdirSync(join(ROOT, 'plugins')).map((n) => join(ROOT, 'plugins', n));
const manifestOf = (dir) => JSON.parse(read(join(dir, 'meta.json')));
const skillsOf = (dir) => (existsSync(join(dir, 'skills')) ? readdirSync(join(dir, 'skills')) : []);

/** Everything about one case that the checks below need. */
function load(dir) {
  const prompt = existsSync(join(dir, 'prompt.md')) ? frontmatter(read(join(dir, 'prompt.md'))) : {};
  const gradersDir = join(dir, 'graders');
  const graders = existsSync(gradersDir)
    ? readdirSync(gradersDir).filter((f) => f.endsWith('.md')).map((f) => ({ file: f, ...frontmatter(read(join(gradersDir, f))) }))
    : [];
  return {
    dir,
    name: relative(EVALS, dir).split('\\').join('/'),
    prompt,
    graders,
    plugins: list(prompt.plugins).map((p) => resolve(dir, p)),
    tags: list(prompt.tags),
    tools: list(prompt.allowed_tools),
  };
}

const cases = caseDirs(EVALS).map(load);

test('there are eval cases to check', () => {
  assert.ok(cases.length >= 10, `found ${cases.length}`);
});

describe('every case', () => {
  for (const c of cases) {
    test(`${c.name}: loads real plugins, and every plugin they depend on`, () => {
      assert.ok(c.plugins.length > 0, 'list the plugins to load in `plugins:`; with none, nothing under test is loaded');
      for (const p of c.plugins) assert.ok(existsSync(join(p, 'meta.json')), `${relative(ROOT, p)} is not a plugin`);
      const loaded = new Set(c.plugins.map((p) => manifestOf(p).name));
      for (const p of c.plugins) {
        for (const dep of manifestOf(p).dependencies || []) {
          assert.ok(loaded.has(dep), `${manifestOf(p).name} depends on ${dep}, which this case does not load, so the plugin would be skipped and every run would score 0`);
        }
      }
    });

    test(`${c.name}: has graders that exist and are of a known type`, () => {
      assert.ok(c.graders.length > 0, 'a case with no grader fails to load');
      for (const g of c.graders) assert.ok(GRADER_TYPES.has(g.type), `${g.file}: type "${g.type}"`);
    });

    test(`${c.name}: is tagged portable or shell, matching the tools it is granted`, () => {
      // Shell tools can't be granted where the OS sandbox is unavailable (Windows, today),
      // so a case needing one must be tagged so that platform can leave it out.
      const portable = c.tags.includes('portable');
      const shell = c.tags.includes('shell');
      assert.equal(portable !== shell, true, 'tag it with exactly one of: portable, shell');
      const grantsShell = c.tools.some((t) => /^(Bash|PowerShell)/.test(t));
      assert.equal(grantsShell, shell, grantsShell ? 'grants a shell tool but is not tagged shell' : 'is tagged shell but grants no shell tool');
    });

    test(`${c.name}: its scaffold script, if any, exists`, () => {
      const yaml = existsSync(join(c.dir, 'case.yaml')) ? read(join(c.dir, 'case.yaml')) : '';
      const m = yaml.match(/scaffold_script:\s*(\S+)/);
      if (m) assert.ok(existsSync(join(c.dir, m[1])), m[1]);
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
      .filter((g) => g.type === 'tool_used' && g.tool === 'Skill' && g.input_match)
      .map((g) => ({ c, skill: g.input_match.match(/\)\?([\w-]+)"/)?.[1], fires: g.max !== '0' })),
  );

  test('every grader names a skill that exists in a plugin the case loads', () => {
    for (const { c, skill } of skillGraders) {
      assert.ok(skill, `${c.name}: could not read a skill name from input_match`);
      const known = c.plugins.flatMap(skillsOf);
      assert.ok(known.includes(skill), `${c.name}: no skill "${skill}" in ${c.plugins.map((p) => relative(ROOT, p))}`);
    }
  });

  test('every skill in the repository has a case that expects it to fire, and a description to trigger on', () => {
    const missing = [];
    for (const dir of pluginDirs) {
      for (const skill of skillsOf(dir)) {
        if (!skillGraders.some((g) => g.skill === skill && g.fires)) missing.push(`${relative(ROOT, dir)}: ${skill}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test("positive prompts do not borrow the skill's own words", () => {
    // A model matches a prompt to a skill by its description, but also by its name. A
    // prompt that says "friction" for a skill called log-friction passes even when the
    // description is replaced with nonsense (checked, once, by doing exactly that), so
    // it measures nothing about the description it is meant to protect.
    for (const { c, skill, fires } of skillGraders) {
      if (!fires) continue;
      // Markdown checks out with CRLF line endings on Windows.
      const prompt = read(join(c.dir, 'prompt.md')).replace(/\r\n/g, '\n').replace(/^---[\s\S]*?\n---\n/, '').toLowerCase();
      for (const word of skill.split('-').filter((w) => w.length > 3)) {
        assert.equal(new RegExp(`\\b${word}\\b`).test(prompt), false, `${c.name}: the prompt says "${word}", part of the skill name "${skill}"`);
      }
    }
  });
});
