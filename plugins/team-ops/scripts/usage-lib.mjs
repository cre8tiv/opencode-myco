// What the usage reports are built on: the usage log, work attribution helpers, and prices.
//
// Usage records come from usage-opencode.mjs, which turns OpenCode's sessions into them, and are
// appended to the stream's usage.jsonl, the durable record. A record is one agent's usage on one
// unit of work with one model; see usage-opencode.mjs for how work is attributed.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_KEYS = ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'];

/** @param {string} p @returns {any[]} parsed JSONL rows, skipping bad lines */
function readJsonl(p) {
  const rows = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a partial last line while the file is being written */ }
  }
  return rows;
}

/**
 * The work in effect at a moment. Usage before the first tag belongs to the first tag:
 * a lead usually names the work a few turns in, once it knows the slug.
 * @param {{at: string, tag: string}[]} tags @param {string} at
 * @returns {string | null}
 */
function tagAt(tags, at) {
  if (!tags.length) return null;
  let cur = tags[0].tag;
  for (const t of tags) if (t.at <= at) cur = t.tag;
  return cur;
}

/** @param {string} description @returns {string | null} the "[TAG]" prefix, if any */
function bracketTag(description) {
  const m = String(description || '').match(/^\s*\[([^\]\s]+)\]/);
  return m ? m[1] : null;
}

/** @param {string} streamDirPath @param {object[]} records */
export function appendUsage(streamDirPath, records) {
  if (!records.length) return;
  appendFileSync(join(streamDirPath, 'usage.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/**
 * The current view of the usage log: for each session and agent, only the records
 * from its latest snapshot. Snapshots are cumulative, so older ones are superseded.
 * @param {string} streamDirPath
 * @returns {any[]}
 */
export function currentUsage(streamDirPath) {
  const p = join(streamDirPath, 'usage.jsonl');
  if (!existsSync(p)) return [];
  const rows = readJsonl(p);
  /** @type {Map<string, string>} */
  const latest = new Map();
  for (const r of rows) {
    const k = `${r.session}|${r.agent_id}`;
    if (!latest.has(k) || r.snap > /** @type {string} */ (latest.get(k))) latest.set(k, r.snap);
  }
  return rows.filter((r) => latest.get(`${r.session}|${r.agent_id}`) === r.snap);
}

let PRICES;
/** @returns {any} */
function prices() {
  if (!PRICES) PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prices.json'), 'utf8'));
  return PRICES;
}

/**
 * API-equivalent cost of a usage record in USD, or null when the model isn't priced.
 * @param {any} r
 * @returns {number | null}
 */
export function costOf(r) {
  const { models, speed_multiplier: speedMult = {} } = prices();
  // OpenRouter-style ids carry a provider (anthropic/claude-haiku-5.5) and write versions with dots.
  const id = String(r.model).replace(/\[.*\]$/, '').replace(/^.*\//, '').replace(/\./g, '-');
  const key = Object.keys(models).filter((k) => id.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const p = models[key];
  const mult = speedMult[r.speed] || 1;
  return TOKEN_KEYS.reduce((sum, k) => sum + ((r[k] || 0) * p[k]) / 1e6, 0) * mult;
}

/** @returns {string} the price table's date */
export const pricesAsOf = () => prices().as_of;

export { readJsonl, tagAt, bracketTag };
