// The plugins are mostly markdown that agents follow, so structural mistakes fail
// quietly: a skill an agent is told to invoke that doesn't exist, a template path with a
// typo, a hook pointing at a renamed script, a model with no price. These tests check the
// references between the pieces, which is what breaks when one of them is renamed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, sandbox } from './helpers.mjs';

const PLUGINS_DIR = join(ROOT, 'plugins');
const read = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

/** @returns {string[]} the plugin directory names */
const pluginNames = () => readdirSync(PLUGINS_DIR).filter((n) => statSync(join(PLUGINS_DIR, n)).isDirectory());

/** @param {string} dir @param {(f: string) => boolean} [keep] @returns {string[]} files below dir */
function walk(dir, keep = () => true) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '.git' || e.name === 'node_modules' ? [] : walk(p, keep);
    return keep(p) ? [p] : [];
  });
}

/** @param {string} text @returns {Record<string, string>} flat frontmatter keys */
function frontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const plugins = pluginNames();
const manifest = (name) => readJson(join(PLUGINS_DIR, name, 'meta.json'));
const agentsOf = (name) => walk(join(PLUGINS_DIR, name, 'agents'), (f) => f.endsWith('.md'));
const skillsOf = (name) => walk(join(PLUGINS_DIR, name, 'skills'), (f) => f.endsWith('SKILL.md'));
const markdownOf = (name) => walk(join(PLUGINS_DIR, name), (f) => f.endsWith('.md'));

describe('manifests', () => {
  test('every plugin directory has a meta.json that names it', () => {
    assert.deepEqual([...plugins].sort(), ['design-team', 'engineering-team', 'team-ops']);
    for (const name of plugins) {
      assert.ok(existsSync(join(PLUGINS_DIR, name, 'meta.json')), `${name} has no meta.json`);
      assert.equal(manifest(name).name, name, `${name}'s meta.json names itself differently`);
    }
  });

  test('no Claude Code plugin or marketplace manifest is left behind', () => {
    assert.equal(existsSync(join(ROOT, '.claude-plugin')), false);
    for (const name of plugins) assert.equal(existsSync(join(PLUGINS_DIR, name, '.claude-plugin')), false, name);
  });

  for (const name of plugins) {
    test(`${name}: a valid meta.json, with a version and only dependencies that exist`, () => {
      const m = manifest(name);
      assert.match(m.version, /^\d+\.\d+\.\d+$/, 'version');
      assert.ok(m.description);
      for (const dep of m.dependencies || []) assert.ok(plugins.includes(dep), `depends on unknown plugin "${dep}"`);
      assert.equal((m.dependencies || []).includes(name), false, 'depends on itself');
    });
  }

  test('both teams depend on team-ops, which provides the capture, usage and cost tracking', () => {
    for (const team of ['design-team', 'engineering-team']) assert.ok(manifest(team).dependencies.includes('team-ops'), team);
  });
});

describe('no Claude Code hooks', () => {
  test('no plugin ships a hooks manifest: enforcement and capture are the OpenCode plugin\'s', () => {
    for (const name of plugins) assert.equal(existsSync(join(PLUGINS_DIR, name, 'hooks')), false, `${name}/hooks`);
  });
});

describe('agents', () => {
  // The frontmatter itself (only OpenCode's keys and tier, a valid mode and tier, the read-only roles' rules) is
  // checked in install.test.mjs; here, that each agent says what it is for.
  for (const name of plugins) {
    for (const file of agentsOf(name)) {
      const base = relative(PLUGINS_DIR, file).split('\\').join('/');
      test(`${base}: described well enough to be chosen`, () => {
        const fm = frontmatter(read(file));
        assert.ok(fm.description && fm.description.length > 30, 'description is how the agent gets chosen');
      });
    }
  }
});

describe('skills', () => {
  for (const name of plugins) {
    for (const file of skillsOf(name)) {
      const dir = file.split(/[\\/]/).slice(-2)[0];
      test(`${name}/${dir}: named after its directory, with a description that says when to use it`, () => {
        const fm = frontmatter(read(file));
        assert.equal(fm.name, dir);
        assert.ok(fm.description && fm.description.length > 40);
      });
    }
  }
});

describe('references between the pieces', () => {
  // Agents are named team/role and skills by their bare name, as OpenCode names them.
  // READMEs are skipped until they are rewritten for OpenCode.
  const agentIds = new Set(plugins.flatMap((p) => agentsOf(p).map((f) => `${p}/${f.split(/[\\/]/).pop().replace(/\.md$/, '')}`)));
  const skillIds = new Set(plugins.flatMap((p) => skillsOf(p).map((f) => f.split(/[\\/]/).slice(-2)[0])));
  const prose = plugins.flatMap(markdownOf).filter((f) => !f.endsWith('README.md'));
  // Hook-simulation payloads in the setup skills still carry Claude Code's namespaced agent_type.
  const lines = (f) => read(f).split('\n').filter((l) => !l.includes('"agent_type"'));
  /** Directories that follow a plugin name in a path, which are not agent roles. */
  const DIRS = new Set(['scripts', 'templates', 'agents', 'skills', 'telemetry', 'hooks']);
  /** Skills of the host rather than of these plugins (the `design` skill is Claude Design's). */
  const EXTERNAL_SKILLS = new Set(['design']);

  test('no plugin:name reference in the old Claude Code form is left', () => {
    const left = [];
    for (const f of prose) {
      for (const l of lines(f)) {
        for (const m of l.matchAll(new RegExp(`\\b(${plugins.join('|')}):[a-z*]`, 'g'))) left.push(`${relative(ROOT, f)}: ${m[0]}`);
      }
    }
    assert.deepEqual(left, []);
  });

  test('every team/role an agent, skill or doc mentions is an agent that exists', () => {
    const missing = [];
    for (const f of prose) {
      for (const l of lines(f)) {
        for (const m of l.matchAll(new RegExp(`\\b(${plugins.join('|')})/(\\*|[a-z][a-z-]*)(?![\\w/.-])`, 'g'))) {
          if (m[2] === '*' || DIRS.has(m[2])) continue;
          if (!agentIds.has(`${m[1]}/${m[2]}`)) missing.push(`${relative(ROOT, f)} → ${m[0]}`);
        }
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });

  test('every skill a doc tells an agent to use exists', () => {
    const missing = [];
    for (const f of prose) {
      for (const m of read(f).matchAll(/`([a-z][a-z0-9-]*)` skill\b|\bskill `([a-z][a-z0-9-]*)`/g)) {
        const name = m[1] || m[2];
        if (!skillIds.has(name) && !EXTERNAL_SKILLS.has(name)) missing.push(`${relative(ROOT, f)} → ${name}`);
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });

  test('every $MYCO_ROOT/<team>/ path points at a file in that team, and no plugin-root variable of the old form is left', () => {
    const missing = [];
    const old = [];
    for (const f of prose) {
      const text = read(f);
      if (text.includes('CLAUDE_PLUGIN_ROOT')) old.push(relative(ROOT, f));
      for (const m of text.matchAll(/\$MYCO_ROOT\/([\w.-]+)\/([\w./-]*[\w-])/g)) {
        if (!existsSync(join(PLUGINS_DIR, m[1], m[2]))) missing.push(`${relative(ROOT, f)} → ${m[1]}/${m[2]}`);
      }
    }
    assert.deepEqual(old, []);
    assert.deepEqual([...new Set(missing)], []);
  });

  test('relative links between markdown files resolve', () => {
    const broken = [];
    // Templates are copied into a project or a package, so their relative links are
    // written for where they end up, not where they are shipped.
    const files = [join(ROOT, 'README.md'), ...plugins.flatMap(markdownOf)].filter((f) => !f.includes(`${sep}templates${sep}`));
    for (const f of files) {
      for (const m of read(f).matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
        const href = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // http:, mailto:
        if (!existsSync(resolve(dirname(f), href))) broken.push(`${relative(ROOT, f)} → ${href}`);
      }
    }
    assert.deepEqual(broken, []);
  });

  test('every key the hooks read from a profile is in the profile template', () => {
    // A hook that reads `merge_policy` is only as good as the template that tells
    // /init-team to write it.
    const templates = [
      frontmatter(read(join(PLUGINS_DIR, 'engineering-team', 'templates', 'team', 'project.md'))),
      frontmatter(read(join(PLUGINS_DIR, 'design-team', 'templates', 'design-profile.md'))),
    ];
    const used = new Set();
    for (const p of plugins) {
      for (const f of walk(join(PLUGINS_DIR, p, 'scripts'), (x) => x.endsWith('.mjs'))) {
        for (const m of read(f).matchAll(/profileKey\([^,)]+,\s*'(\w+)'/g)) used.add(m[1]);
      }
    }
    assert.ok(used.has('merge_policy') && used.has('trunk_branch') && used.has('stream'), `found ${[...used]}`);
    for (const key of used) assert.ok(templates.some((t) => key in t), `no profile template has "${key}"`);
  });
});

describe('data files', () => {
  test('prices.json has every rate for every model, and a date', () => {
    const p = readJson(join(PLUGINS_DIR, 'team-ops', 'scripts', 'prices.json'));
    assert.match(p.as_of, /^\d{4}-\d{2}-\d{2}$/);
    for (const [model, rates] of Object.entries(p.models)) {
      for (const k of ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read']) {
        assert.ok(typeof rates[k] === 'number' && rates[k] > 0, `${model}.${k}`);
      }
      assert.ok(rates.cache_read < rates.input, `${model}: a cache read should cost less than fresh input`);
      assert.ok(rates.cache_write_1h >= rates.cache_write_5m, `${model}: a longer cache lifetime should not cost less`);
    }
    assert.equal(typeof p.speed_multiplier.fast, 'number');
  });

  test('every JSON file in the repository parses', () => {
    for (const f of walk(ROOT, (x) => x.endsWith('.json'))) {
      assert.doesNotThrow(() => JSON.parse(read(f)), relative(ROOT, f));
    }
  });

  test('the example telemetry stack ships the files its README tells people to use', () => {
    const stack = join(PLUGINS_DIR, 'team-ops', 'telemetry', 'stack');
    for (const f of ['docker-compose.yml', 'otel-collector.yaml', 'prometheus.yml', 'loki.yaml', 'grafana/dashboards/agent-teams.json']) {
      assert.ok(existsSync(join(stack, f)), f);
    }
  });
});

describe('scripts', () => {
  test('every script parses (a syntax error in a hook fails silently at runtime)', () => {
    for (const f of [...walk(PLUGINS_DIR, (x) => x.endsWith('.mjs')), ...walk(join(ROOT, 'scripts'), (x) => x.endsWith('.mjs'))]) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${relative(ROOT, f)}: ${r.stderr}`);
    }
  });

  test('plugin scripts use only the standard library, as the README promises', () => {
    const bad = [];
    for (const f of walk(PLUGINS_DIR, (x) => x.endsWith('.mjs'))) {
      for (const m of read(f).matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        if (!m[1].startsWith('node:') && !m[1].startsWith('.')) bad.push(`${relative(ROOT, f)} imports ${m[1]}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('plugins do not import from each other, since they install independently', () => {
    const bad = [];
    for (const p of plugins) {
      for (const f of walk(join(PLUGINS_DIR, p, 'scripts'), (x) => x.endsWith('.mjs'))) {
        for (const m of read(f).matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
          const target = resolve(dirname(f), m[1]);
          if (!target.startsWith(join(PLUGINS_DIR, p))) bad.push(`${relative(ROOT, f)} reaches ${m[1]}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });
});
