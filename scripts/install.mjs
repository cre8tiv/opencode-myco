#!/usr/bin/env node
// Installs the myco teams into OpenCode.
//
//   node scripts/install.mjs --global | --project [--target <dir>] [--models <file>] [--allow-autonomous-merge]
//
// OpenCode has no plugin marketplace and its plugins cannot add agents, so the agents
// and skills are copied into its config directory as files:
//
//   <target>/agents/<team>/<role>.md   agents, with their frontmatter rewritten for OpenCode
//   <target>/skills/<name>/            skills
//   <target>/myco/<team>/              each team's scripts and templates ($MYCO_ROOT/<team>)
//   <target>/myco/install.json         what was installed, for the doctor (<target>/myco/team-ops/scripts/doctor.mjs)
//   <target>/plugins/myco/             the plugin that provides $MYCO_ROOT
//
// Every agent is installed with a native rule denying `gh pr merge`. It holds even if the
// myco plugin fails to load, which OpenCode survives with a single warning, but it is static:
// it cannot read a project's merge_policy, and it matches the command as the last plugin to
// rewrite it left it, so a merge behind a wrapper such as rtk gets past it; the plugin's guard
// looks through wrappers, and is the real check. Projects that set `merge_policy: autonomous` need
// --allow-autonomous-merge, which leaves the rule out and leaves merging to the plugin's gate.
// The flag applies to the whole install, so give it on every reinstall.
//
// --global installs into OpenCode's user config (~/.config/opencode), --project into
// ./.opencode. Prefer --global: OpenCode resolves agents and plugins per directory, so a
// git worktree sees a project install only if .opencode is committed.
//
// The sources write the install root as $MYCO_ROOT (for example
// $MYCO_ROOT/team-ops/scripts/friction.mjs). OpenCode doesn't substitute variables in
// agent or skill text, and a model's `read` call can't expand one, so this script writes
// the real absolute path into the installed copies.
//
// The agent sources keep their Claude Code frontmatter, so they stay identical to
// upstream; this script is where it becomes OpenCode's. Only what the script owns is
// replaced on a reinstall: a user's own agents, skills and models.json are left alone.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_MAP, MERGE_BACKSTOP, checkModels, modelLines, refFor } from '../plugins/team-ops/scripts/models.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
 * An agent's permission rules: its own, plus the merge backstop unless merging is allowed.
 * Rules for the same action are combined, the agent's first.
 * @param {Record<string, any> | undefined} own @param {boolean} backstop
 * @returns {Record<string, any> | null}
 */
function permissionFor(own, backstop) {
  const out = { ...(own || {}) };
  if (backstop) {
    for (const [action, rules] of Object.entries(MERGE_BACKSTOP)) {
      out[action] = typeof out[action] === 'object' ? { ...out[action], ...rules } : rules;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * An agent as OpenCode wants it: description kept; mode, model, variant and permission
 * from the install map and the user's model mapping; every other Claude Code key
 * dropped. OpenCode ignores keys it doesn't know and forwards them to the provider as
 * request parameters, so `isolation` and `disallowedTools` must not survive.
 * @param {{id: string, text: string, models?: ReturnType<typeof checkModels>, mergeBackstop?: boolean}} p id is "team/role"
 * @returns {string}
 */
export function transformAgent({ id, text, models = { tiers: {}, agents: {} }, mergeBackstop = true }) {
  const entry = AGENT_MAP[id];
  if (!entry) throw new Error(`${id}: not in plugins/team-ops/scripts/opencode-agents.json`);
  const { keys, body } = splitAgent(text, id);
  const description = keys.get('description');
  if (!description) throw new Error(`${id}: no description`);
  const ref = refFor(models, id);
  const fm = [`description: ${q(description)}`, `mode: ${entry.mode}`];
  if (ref) fm.push(...modelLines(ref));
  const permission = permissionFor(entry.permission, mergeBackstop);
  if (permission) fm.push(...permissionLines(permission));
  return `---\n${fm.join('\n')}\n---\n${body}`;
}

/** The install root as written into agent and skill text: forward slashes on every platform. */
const rootText = (target) => join(target, 'myco').split(sep).join('/');

/** @param {string} text @param {string} root @returns {string} text with $MYCO_ROOT replaced by the real path */
export const withRoot = (text, root) => text.replaceAll('$MYCO_ROOT', root);

/** @param {string} dir @param {(text: string) => string} fn rewrites every markdown file below dir in place */
function rewriteMarkdown(dir, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rewriteMarkdown(p, fn);
    else if (e.name.endsWith('.md')) writeFileSync(p, fn(readFileSync(p, 'utf8')));
  }
}

/** @param {string} dir @returns {string[]} names of the entries below dir */
const ls = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

/** @returns {string[]} the team plugin directories, by name */
const teamsIn = (repo) => ls(join(repo, 'plugins')).filter((n) => existsSync(join(repo, 'plugins', n, 'meta.json'))).sort();

/**
 * Installs every team under target.
 * @param {{target: string, models?: any, repo?: string, mergeBackstop?: boolean}} p mergeBackstop: deny `gh pr merge` in every agent (default true)
 * @returns {{agents: string[], skills: string[], teams: string[]}}
 */
export function install({ target, models, repo = ROOT, mergeBackstop = true }) {
  const mapping = checkModels(models);
  const teams = teamsIn(repo);
  const found = teams.flatMap((t) => ls(join(repo, 'plugins', t, 'agents')).filter((f) => f.endsWith('.md')).map((f) => `${t}/${f.replace(/\.md$/, '')}`));
  const unmapped = found.filter((id) => !AGENT_MAP[id]);
  const orphaned = Object.keys(AGENT_MAP).filter((id) => !found.includes(id));
  if (unmapped.length || orphaned.length) {
    throw new Error(`plugins/team-ops/scripts/opencode-agents.json is out of step with plugins/: no entry for [${unmapped}], no agent file for [${orphaned}]`);
  }

  const root = rootText(target);
  const skills = [];
  for (const team of teams) {
    const base = join(repo, 'plugins', team);
    rmSync(join(target, 'agents', team), { recursive: true, force: true });
    mkdirSync(join(target, 'agents', team), { recursive: true });
    for (const id of found.filter((i) => i.startsWith(`${team}/`))) {
      const text = readFileSync(join(base, 'agents', `${id.split('/')[1]}.md`), 'utf8');
      writeFileSync(join(target, 'agents', `${id}.md`), withRoot(transformAgent({ id, text, models: mapping, mergeBackstop }), root));
    }
    for (const name of ls(join(base, 'skills'))) {
      rmSync(join(target, 'skills', name), { recursive: true, force: true });
      cpSync(join(base, 'skills', name), join(target, 'skills', name), { recursive: true });
      rewriteMarkdown(join(target, 'skills', name), (text) => withRoot(text, root));
      skills.push(name);
    }
    rmSync(join(target, 'myco', team), { recursive: true, force: true });
    for (const dir of TEAM_ASSETS) {
      if (existsSync(join(base, dir))) cpSync(join(base, dir), join(target, 'myco', team, dir), { recursive: true });
    }
  }

  rmSync(join(target, 'plugins', 'myco'), { recursive: true, force: true });
  cpSync(join(repo, 'opencode-plugin', 'myco'), join(target, 'plugins', 'myco'), { recursive: true });

  // What was installed, for `myco doctor`: the merge backstop is the one choice recorded nowhere else.
  const versions = Object.fromEntries(teams.map((t) => [t, JSON.parse(readFileSync(join(repo, 'plugins', t, 'meta.json'), 'utf8')).version]));
  let source = null;
  try {
    source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Not installed from a git checkout.
  }
  mkdirSync(join(target, 'myco'), { recursive: true });
  writeFileSync(join(target, 'myco', 'install.json'), JSON.stringify({ installedAt: new Date().toISOString(), source, teams: versions, agents: found, skills, mergeBackstop }, null, 2) + '\n');
  return { agents: found, skills, teams };
}

/** @param {string[]} argv */
function main(argv) {
  const get = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const mode = argv.includes('--global') ? 'global' : argv.includes('--project') ? 'project' : null;
  if (!mode && !get('--target')) {
    console.error('usage: install.mjs --global | --project [--target <dir>] [--models <file>] [--allow-autonomous-merge]');
    process.exit(2);
  }
  const target = resolve(
    get('--target') || (mode === 'global' ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode') : join(process.cwd(), '.opencode')),
  );
  const modelsFile = get('--models') || (existsSync(join(target, 'myco', 'models.json')) ? join(target, 'myco', 'models.json') : null);
  const mergeBackstop = !argv.includes('--allow-autonomous-merge');
  const result = install({ target, models: modelsFile ? JSON.parse(readFileSync(modelsFile, 'utf8')) : undefined, mergeBackstop });
  // A mapping given with --models becomes the install's own, so reinstalling and models.mjs agree with it.
  const saved = join(target, 'myco', 'models.json');
  if (modelsFile && resolve(modelsFile) !== resolve(saved)) copyFileSync(modelsFile, saved);
  console.log(
    `Installed ${result.agents.length} agents, ${result.skills.length} skills and the myco plugin into ${target}` +
      (modelsFile ? ` (models from ${modelsFile})` : ' (no model mapping: agents use your default model)') +
      (mergeBackstop ? '' : '; agents may run `gh pr merge` where a project\'s merge_policy allows it'),
  );
  console.log(`Check it from any project, at any time: node "${join(target, 'myco', 'team-ops', 'scripts', 'doctor.mjs')}"`);
}

/** Whether this file is the one being run. Both sides are resolved: a symlinked path (a macOS temp directory, a dotfiles-managed config) differs from the real one, and the script would silently do nothing. */
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) main(process.argv.slice(2));
