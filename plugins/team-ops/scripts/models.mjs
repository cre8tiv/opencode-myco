#!/usr/bin/env node
// Maps the user's own models onto the team agents.
//
// Which models exist differs per user, so none is named anywhere in the teams. Agents
// are grouped into tiers by what they need from a model (see opencode-agents.json):
// lead, reasoning, worker. The mapping is one file, <install root>/models.json:
//
//   { "tiers": { "lead": "provider/model#variant", ... }, "agents": { "team/role": "provider/model" } }
//
// An agent with no mapped model carries no `model:` line and runs on the user's default.
// The installer applies the mapping when it installs; this script applies it afterwards:
//
//   node models.mjs show                                            the mapping and each agent's model
//   node models.mjs set [--lead <ref>] [--reasoning <ref>] [--worker <ref>] [--agent <team/role>=<ref>]...
//                                                                   replace the mapping, apply it, report warnings
//   node models.mjs check                                           warnings for the current mapping
//
// <ref> is provider/model or provider/model#variant, the form `opencode run --model` takes.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL_MAP = JSON.parse(readFileSync(join(HERE, 'opencode-agents.json'), 'utf8'));
/** @type {Record<string, {mode: string, tier: string, permission?: object}>} */
export const AGENT_MAP = INSTALL_MAP.agents;
/** @type {Record<string, Record<string, string>>} permission rules every agent gets unless merging is allowed */
export const MERGE_BACKSTOP = Object.fromEntries(Object.entries(INSTALL_MAP.mergeBackstop).filter(([k]) => !k.startsWith('_')));
export const TIERS = [...new Set(Object.values(AGENT_MAP).map((a) => a.tier))];

/** Tokens a conversation needs beyond the agent's own prompt: tool schemas, instructions, work in progress. */
const HEADROOM_TOKENS = 12000;
/** Roles whose value is reviewing code they did not write, and the roles that write it. */
const REVIEWERS = ['engineering-team/code-reviewer', 'engineering-team/qa-specialist'];
const WRITERS = ['engineering-team/ic-generalist', 'engineering-team/ic-specialist-backend'];

/**
 * "provider/model" or "provider/model#variant", the form `opencode run --model` takes.
 * @param {string} ref @returns {{model: string, variant?: string}}
 */
export function parseModelRef(ref) {
  const m = String(ref).match(/^([^/\s#]+\/[^\s#]+)(?:#([^\s#]+))?$/);
  if (!m) throw new Error(`model "${ref}" is not provider/model or provider/model#variant`);
  return m[2] ? { model: m[1], variant: m[2] } : { model: m[1] };
}

/** JSON strings are valid YAML double-quoted scalars, so model ids with odd characters are safe. */
const q = (v) => JSON.stringify(v);

/** @param {string} ref @returns {string[]} the frontmatter lines that set an agent's model */
export function modelLines(ref) {
  const { model, variant } = parseModelRef(ref);
  return variant ? [`model: ${q(model)}`, `variant: ${q(variant)}`] : [`model: ${q(model)}`];
}

/**
 * Validates a mapping and fills in its empty parts.
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

/** @returns {string | undefined} the model reference an agent gets from a mapping: its own entry, else its tier's */
export const refFor = (models, id) => models.agents[id] || models.tiers[AGENT_MAP[id]?.tier];

/**
 * An installed agent's text with its model set from `ref`, or with no model when ref is
 * undefined. Only the frontmatter is touched.
 * @param {string} text @param {string | undefined} ref @returns {string}
 */
export function setModel(text, ref) {
  const m = text.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!m) throw new Error('agent has no frontmatter');
  const lines = m[2].split('\n').filter((l) => !/^(model|variant):/.test(l));
  if (ref) {
    const at = lines.findIndex((l) => l.startsWith('mode:'));
    lines.splice(at < 0 ? lines.length : at + 1, 0, ...modelLines(ref));
  }
  return m[1] + lines.join('\n') + m[3] + m[4];
}

/**
 * Applies a mapping to the installed agents.
 * @param {{agentsDir: string, models: ReturnType<typeof checkModels>}} p
 * @returns {string[]} the agents whose file changed
 */
export function applyModels({ agentsDir, models }) {
  const changed = [];
  for (const id of Object.keys(AGENT_MAP)) {
    const file = join(agentsDir, `${id}.md`);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = setModel(before, refFor(models, id));
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(id);
    }
  }
  return changed;
}

/**
 * Problems with a mapping, as one-line warnings. Warnings never stop anything: the user
 * knows their setup better than this does.
 * @param {{models: ReturnType<typeof checkModels>, agentsDir?: string, catalog?: any[] | null}} p
 *   catalog: the models OpenCode knows (GET /api/model), or null when it could not be read
 * @returns {string[]}
 */
export function warnings({ models, agentsDir, catalog }) {
  const out = [];
  const known = new Map((catalog || []).map((m) => [`${m.providerID}/${m.modelID}`, m]));

  if (catalog) {
    const seen = new Set();
    for (const [where, ref] of [...Object.entries(models.tiers), ...Object.entries(models.agents)]) {
      const { model, variant } = parseModelRef(ref);
      if (seen.has(ref)) continue;
      seen.add(ref);
      const entry = known.get(model);
      if (!entry) out.push(`${where}: "${model}" is not a model OpenCode lists (see \`opencode models\`)`);
      else if (variant && !(entry.variants || []).some((v) => v.id === variant)) {
        out.push(`${where}: "${model}" has no variant "${variant}" (it has ${(entry.variants || []).map((v) => v.id).join(', ') || 'none'})`);
      }
    }
    // The largest agent prompt on each model, against the context the model declares.
    const biggest = new Map();
    for (const id of Object.keys(AGENT_MAP)) {
      const ref = refFor(models, id);
      const file = agentsDir && join(agentsDir, `${id}.md`);
      if (!ref || !file || !existsSync(file)) continue;
      const tokens = Math.ceil(readFileSync(file, 'utf8').length / 3.5);
      const model = parseModelRef(ref).model;
      if (!biggest.has(model) || tokens > biggest.get(model).tokens) biggest.set(model, { id, tokens });
    }
    for (const [model, { id, tokens }] of biggest) {
      const context = known.get(model)?.limit?.context;
      if (context && context < tokens + HEADROOM_TOKENS) {
        out.push(`${model}: declares a context of ${context} tokens, but ${id} alone is about ${tokens} and a working session needs about ${HEADROOM_TOKENS} more`);
      }
    }
  }

  const ref = (id) => refFor(models, id) || '(your default model)';
  const writers = new Set(WRITERS.map(ref));
  const same = REVIEWERS.filter((id) => writers.has(ref(id)));
  if (same.length) {
    out.push(`${same.map((id) => id.split('/')[1]).join(' and ')} use the same model as the ICs (${ref(same[0])}), so review loses its independence; map the reasoning tier to a different model`);
  }
  return out;
}

/**
 * @returns {any[] | null} the models OpenCode knows, or null when `opencode` can't be asked.
 *   MYCO_MODELS_CATALOG names a JSON file to use instead (offline use, tests), or "none".
 */
export function readCatalog() {
  const override = process.env.MYCO_MODELS_CATALOG;
  if (override) {
    if (override === 'none') return null;
    const j = JSON.parse(readFileSync(override, 'utf8'));
    return Array.isArray(j) ? j : j.data || null;
  }
  const r = spawnSync('opencode', ['api', 'GET', '/api/model', '--standalone'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    return Array.isArray(j) ? j : j.data || null;
  } catch {
    return null;
  }
}

/** @param {string[]} argv */
function main(argv) {
  const root = resolve(HERE, '..', '..');
  const agentsDir = join(root, '..', 'agents');
  const file = join(root, 'models.json');
  if (!existsSync(agentsDir)) {
    console.error(`This is not an installed copy (no ${agentsDir}). Run it from <config>/myco/team-ops/scripts/ after scripts/install.mjs.`);
    process.exit(2);
  }
  const load = () => (existsSync(file) ? checkModels(JSON.parse(readFileSync(file, 'utf8'))) : checkModels({}));
  const report = (models) => {
    const catalog = readCatalog();
    const list = warnings({ models, agentsDir, catalog });
    if (!catalog) console.log('(could not ask OpenCode which models exist, so model, variant and context checks were skipped)');
    for (const w of list) console.log(`warning: ${w}`);
    if (!list.length) console.log('no warnings');
  };
  const cmd = argv[0];
  if (cmd === 'show') {
    const models = load();
    for (const id of Object.keys(AGENT_MAP)) console.log(`${id.padEnd(40)} ${AGENT_MAP[id].tier.padEnd(10)} ${refFor(models, id) || '(your default model)'}`);
  } else if (cmd === 'check') {
    report(load());
  } else if (cmd === 'set') {
    const get = (f) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined;
    const tiers = {};
    for (const t of TIERS) if (get(`--${t}`)) tiers[t] = get(`--${t}`);
    const agents = {};
    argv.forEach((a, i) => {
      if (a !== '--agent') return;
      const [id, ref] = String(argv[i + 1]).split('=');
      agents[id] = ref;
    });
    const models = checkModels({ tiers, agents });
    writeFileSync(file, JSON.stringify(models, null, 2) + '\n');
    const changed = applyModels({ agentsDir, models });
    console.log(`saved ${file}; ${changed.length} agent file(s) updated`);
    report(models);
  } else {
    console.error('usage: models.mjs show | check | set [--lead <ref>] [--reasoning <ref>] [--worker <ref>] [--agent <team/role>=<ref>]...');
    process.exit(2);
  }
}

/** Whether this file is the one being run. Both sides are resolved: a symlinked path (a macOS temp directory, a dotfiles-managed config) differs from the real one, and the script would silently do nothing. */
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
