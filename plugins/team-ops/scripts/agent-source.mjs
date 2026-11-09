// What an agent's source file says about it, and the registry of every team agent.
//
// An agent source is a markdown file in OpenCode's own format: flat frontmatter, then the prompt.
//
//   description   what the agent is for (OpenCode shows it, and a lead reads it to choose)
//   mode          primary (chosen as the session agent) or subagent (dispatched)
//   permission    OpenCode permission rules, written as one JSON object so the line stays flat
//   tier          the one key OpenCode does not know: lead, reasoning or worker, which model tier of the user's
//                 mapping the agent takes. The installer removes it and writes `model:` in its place.
//
// The installer writes a registry of {id: {mode, tier}} beside what it installs (agents.json), because an
// installed agent no longer says its tier; a checkout reads the sources themselves. Either way an id is
// "team/role", the agent's path below the agents directory.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The model tiers a user maps their models onto; an agent's `tier` is one of them. */
export const TIER_NAMES = ['lead', 'reasoning', 'worker'];

/**
 * Splits an agent file into its flat frontmatter keys and its body, which is kept exactly. Frontmatter is flat
 * `key: value` lines; anything else is refused rather than guessed at.
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

/**
 * What an agent source declares, checked.
 * @param {string} id "team/role" @param {string} text
 * @returns {{id: string, description: string, mode: 'primary' | 'subagent', tier: string, permission?: Record<string, any>, body: string}}
 */
export function parseAgent(id, text) {
  const { keys, body } = splitAgent(text, id);
  const description = keys.get('description');
  if (!description) throw new Error(`${id}: no description`);
  const mode = keys.get('mode');
  if (mode !== 'primary' && mode !== 'subagent') throw new Error(`${id}: mode must be primary or subagent, not "${mode}"`);
  const tier = keys.get('tier');
  if (!tier) throw new Error(`${id}: no tier (${TIER_NAMES.join(', ')})`);
  if (!TIER_NAMES.includes(tier)) throw new Error(`${id}: tier must be one of ${TIER_NAMES.join(', ')}, not "${tier}"`);
  let permission;
  if (keys.has('permission')) {
    try {
      permission = JSON.parse(/** @type {string} */ (keys.get('permission')));
    } catch {
      throw new Error(`${id}: permission must be one JSON object on one line`);
    }
  }
  return { id, description, mode, tier, permission, body };
}

/**
 * Every agent source below a plugins directory (<team>/agents/<role>.md).
 * @param {string} pluginsDir @returns {ReturnType<typeof parseAgent>[]}
 */
export function readAgentSources(pluginsDir) {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(pluginsDir, e.name, 'agents')))
    .flatMap((e) =>
      readdirSync(join(pluginsDir, e.name, 'agents'))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => parseAgent(`${e.name}/${f.replace(/\.md$/, '')}`, readFileSync(join(pluginsDir, e.name, 'agents', f), 'utf8'))),
    );
}

/**
 * The registry of team agents: the install's agents.json when `base` is an install root, else the sources in a
 * checkout's plugins directory. Neither is an error: an install made before the registry existed has no
 * agents.json and no sources, and an empty map would read as "no agents" rather than "reinstall".
 * @param {string} base @returns {Record<string, {mode: string, tier: string}>}
 */
export function loadAgentMap(base) {
  const registry = join(base, 'agents.json');
  if (existsSync(registry)) return JSON.parse(readFileSync(registry, 'utf8'));
  const sources = readAgentSources(base);
  if (!sources.length) throw new Error(`no agent registry (${registry}) and no agent sources in ${base}: reinstall with \`node scripts/install.mjs\` from the myco checkout`);
  return Object.fromEntries(sources.map((a) => [a.id, { mode: a.mode, tier: a.tier }]));
}
