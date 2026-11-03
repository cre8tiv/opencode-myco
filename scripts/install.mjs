#!/usr/bin/env node
// Installs the myco teams into OpenCode.
//
//   node scripts/install.mjs --global | --project [--target <dir>] [--models <file>]
//
// OpenCode has no plugin marketplace and its plugins cannot add agents, so the agents
// and skills are copied into its config directory as files:
//
//   <target>/agents/<team>/<role>.md   agents, with their frontmatter rewritten for OpenCode
//   <target>/skills/<name>/            skills, copied as they are
//   <target>/myco/<team>/              each team's scripts and templates ($MYCO_ROOT/<team>)
//   <target>/plugins/myco/             the plugin that provides $MYCO_ROOT
//
// --global installs into OpenCode's user config (~/.config/opencode), --project into
// ./.opencode. Prefer --global: OpenCode resolves agents and plugins per directory, so a
// git worktree sees a project install only if .opencode is committed.
//
// The agent sources keep their Claude Code frontmatter, so they stay identical to
// upstream; this script is where it becomes OpenCode's. Only what the script owns is
// replaced on a reinstall: a user's own agents, skills and models.json are left alone.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_MAP = JSON.parse(readFileSync(join(ROOT, 'scripts', 'opencode-agents.json'), 'utf8')).agents;
const TIERS = [...new Set(Object.values(AGENT_MAP).map((a) => a.tier))];
/** Team directories copied under <target>/myco/<team>. */
const TEAM_ASSETS = ['scripts', 'templates'];

/**
 * Splits an agent file into its flat frontmatter keys and its body, which is kept
 * exactly. Agent frontmatter is flat `key: value` lines; anything else is refused
 * rather than guessed at.
 * @param {string} text @param {string} label for error messages
 * @returns {{keys: Map<string, string>, body: string}}
 */
export function splitAgent(text, label) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${label}: no frontmatter`);
  const keys = new Map();
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!kv) throw new Error(`${label}: unsupported frontmatter line "${line}"`);
    keys.set(kv[1], kv[2].trim().replace(/^["']|["']$/g, ''));
  }
  return { keys, body: m[2] };
}

/** JSON strings are valid YAML double-quoted scalars, so descriptions with colons are safe. */
const q = (v) => JSON.stringify(v);

/** @param {Record<string, any>} perm @returns {string[]} the `permission:` block */
function permissionLines(perm) {
  const out = ['permission:'];
  for (const [action, rule] of Object.entries(perm)) {
    if (typeof rule === 'string') out.push(`  ${action}: ${rule}`);
    else {
      out.push(`  ${action}:`);
      for (const [pattern, effect] of Object.entries(rule)) out.push(`    ${q(pattern)}: ${effect}`);
    }
  }
  return out;
}

/**
 * "provider/model" or "provider/model#variant", the form `opencode run --model` takes.
 * @param {string} ref @returns {{model: string, variant?: string}}
 */
export function parseModelRef(ref) {
  const m = String(ref).match(/^([^/\s#]+\/[^\s#]+)(?:#([^\s#]+))?$/);
  if (!m) throw new Error(`model "${ref}" is not provider/model or provider/model#variant`);
  return m[2] ? { model: m[1], variant: m[2] } : { model: m[1] };
}

/**
 * The user's model mapping: tiers, with optional per-agent overrides.
 *   { "tiers": { "lead": "provider/model#variant", ... }, "agents": { "team/role": "provider/model" } }
 * @param {any} raw @returns {{tiers: Record<string, string>, agents: Record<string, string>}}
 */
export function checkModels(raw) {
  const tiers = raw?.tiers || {};
  const agents = raw?.agents || {};
  for (const t of Object.keys(tiers)) if (!TIERS.includes(t)) throw new Error(`models: unknown tier "${t}" (tiers are ${TIERS.join(', ')})`);
  for (const a of Object.keys(agents)) if (!AGENT_MAP[a]) throw new Error(`models: unknown agent "${a}"`);
  for (const ref of [...Object.values(tiers), ...Object.values(agents)]) parseModelRef(ref);
  return { tiers, agents };
}

/**
 * An agent as OpenCode wants it: description kept; mode, model, variant and permission
 * from the install map and the user's model mapping; every other Claude Code key
 * dropped. OpenCode ignores keys it doesn't know and forwards them to the provider as
 * request parameters, so `isolation` and `disallowedTools` must not survive.
 * @param {{id: string, text: string, models?: ReturnType<typeof checkModels>}} p id is "team/role"
 * @returns {string}
 */
export function transformAgent({ id, text, models = { tiers: {}, agents: {} } }) {
  const entry = AGENT_MAP[id];
  if (!entry) throw new Error(`${id}: not in scripts/opencode-agents.json`);
  const { keys, body } = splitAgent(text, id);
  const description = keys.get('description');
  if (!description) throw new Error(`${id}: no description`);
  const ref = models.agents[id] || models.tiers[entry.tier];
  const fm = [`description: ${q(description)}`, `mode: ${entry.mode}`];
  if (ref) {
    const { model, variant } = parseModelRef(ref);
    fm.push(`model: ${q(model)}`);
    if (variant) fm.push(`variant: ${q(variant)}`);
  }
  if (entry.permission) fm.push(...permissionLines(entry.permission));
  return `---\n${fm.join('\n')}\n---\n${body}`;
}

/** @param {string} dir @returns {string[]} names of the entries below dir */
const ls = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

/** @returns {string[]} the team plugin directories, by name */
const teamsIn = (repo) => ls(join(repo, 'plugins')).filter((n) => existsSync(join(repo, 'plugins', n, 'meta.json'))).sort();

/**
 * Installs every team under target.
 * @param {{target: string, models?: any, repo?: string}} p
 * @returns {{agents: string[], skills: string[], teams: string[]}}
 */
export function install({ target, models, repo = ROOT }) {
  const mapping = checkModels(models);
  const teams = teamsIn(repo);
  const found = teams.flatMap((t) => ls(join(repo, 'plugins', t, 'agents')).filter((f) => f.endsWith('.md')).map((f) => `${t}/${f.replace(/\.md$/, '')}`));
  const unmapped = found.filter((id) => !AGENT_MAP[id]);
  const orphaned = Object.keys(AGENT_MAP).filter((id) => !found.includes(id));
  if (unmapped.length || orphaned.length) {
    throw new Error(`scripts/opencode-agents.json is out of step with plugins/: no entry for [${unmapped}], no agent file for [${orphaned}]`);
  }

  const skills = [];
  for (const team of teams) {
    const base = join(repo, 'plugins', team);
    rmSync(join(target, 'agents', team), { recursive: true, force: true });
    mkdirSync(join(target, 'agents', team), { recursive: true });
    for (const id of found.filter((i) => i.startsWith(`${team}/`))) {
      const text = readFileSync(join(base, 'agents', `${id.split('/')[1]}.md`), 'utf8');
      writeFileSync(join(target, 'agents', `${id}.md`), transformAgent({ id, text, models: mapping }));
    }
    for (const name of ls(join(base, 'skills'))) {
      rmSync(join(target, 'skills', name), { recursive: true, force: true });
      cpSync(join(base, 'skills', name), join(target, 'skills', name), { recursive: true });
      skills.push(name);
    }
    rmSync(join(target, 'myco', team), { recursive: true, force: true });
    for (const dir of TEAM_ASSETS) {
      if (existsSync(join(base, dir))) cpSync(join(base, dir), join(target, 'myco', team, dir), { recursive: true });
    }
  }

  rmSync(join(target, 'plugins', 'myco'), { recursive: true, force: true });
  cpSync(join(repo, 'opencode-plugin', 'myco'), join(target, 'plugins', 'myco'), { recursive: true });
  return { agents: found, skills, teams };
}

/** @param {string[]} argv */
function main(argv) {
  const get = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const mode = argv.includes('--global') ? 'global' : argv.includes('--project') ? 'project' : null;
  if (!mode && !get('--target')) {
    console.error('usage: install.mjs --global | --project [--target <dir>] [--models <file>]');
    process.exit(2);
  }
  const target = resolve(
    get('--target') || (mode === 'global' ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode') : join(process.cwd(), '.opencode')),
  );
  const modelsFile = get('--models') || (existsSync(join(target, 'myco', 'models.json')) ? join(target, 'myco', 'models.json') : null);
  const result = install({ target, models: modelsFile ? JSON.parse(readFileSync(modelsFile, 'utf8')) : undefined });
  console.log(
    `Installed ${result.agents.length} agents, ${result.skills.length} skills and the myco plugin into ${target}` +
      (modelsFile ? ` (models from ${modelsFile})` : ' (no model mapping: agents use your default model)'),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2));
