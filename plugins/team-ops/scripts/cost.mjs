#!/usr/bin/env node
// Cost report over the stream's usage log.
//
//   node cost.mjs [--work <prefix>] [--since <YYYY-MM-DD>] [--by work|agent|model|day|session]
//                 [--source opencode|claude] [--json] [--no-backfill] [--export]
//
// --work matches a work tag by prefix, so "order-exceptions" covers every round and
// phase of that package, and a ticket key covers that ticket. Before reporting, it
// brings the usage log up to date from where the sessions are kept. For OpenCode (the
// default) that is its session store, asked through `opencode api`; sessions that changed
// since their last record are read again. With --source claude it re-snapshots Claude
// Code transcripts that changed since their last snapshot, while those still exist.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { streamDir, resolveStreamName } from './stream.mjs';
import { snapshotSession, appendUsage, currentUsage, costOf, pricesAsOf, findTranscript, readJsonl } from './usage-lib.mjs';
import { exportSessions } from './otlp.mjs';
import { refreshFromOpenCode } from './usage-opencode.mjs';

/** @param {string[]} argv @returns {Record<string, string|boolean>} */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true;
    else { o[k] = v; i++; }
  }
  return o;
}

/**
 * Re-snapshots sessions whose transcripts changed after their latest snapshot, or that
 * were never snapshotted: a headless run killed before SessionEnd, a session still
 * open. Sessions are the ones the team event stream or the usage log knows about.
 * @param {string} dir stream directory
 * @returns {string[]} sessions updated
 */
function backfill(dir) {
  const events = join(dir, 'events.jsonl');
  const usage = currentUsage(dir);
  /** @type {Map<string, string>} */
  const lastSnap = new Map();
  for (const r of usage) if (!lastSnap.has(r.session) || r.snap > /** @type {string} */ (lastSnap.get(r.session))) lastSnap.set(r.session, r.snap);
  const sessions = new Set([...lastSnap.keys(), ...(existsSync(events) ? readJsonl(events).map((r) => r.session).filter(Boolean) : [])]);
  const projects = join(homedir(), '.claude', 'projects');
  /** @type {string[]} */
  const updated = [];
  for (const s of sessions) {
    const t = findTranscript(projects, s);
    if (!t) continue;
    const snap = lastSnap.get(s);
    if (snap && newestChange(t, s) <= Date.parse(snap)) continue;
    // A lead session records the agent it ran as.
    const setting = readJsonl(t).find((r) => r.type === 'agent-setting');
    const recs = snapshotSession({ transcriptPath: t, sessionId: s, leadAgent: setting?.agentSetting });
    appendUsage(dir, recs);
    if (recs.length) updated.push(s);
  }
  return updated;
}

/** @param {string} transcript @param {string} sessionId @returns {number} newest mtime of the session's transcripts */
function newestChange(transcript, sessionId) {
  let t = statSync(transcript).mtimeMs;
  const sub = join(dirname(transcript), sessionId, 'subagents');
  if (existsSync(sub)) for (const f of readdirSync(sub)) t = Math.max(t, statSync(join(sub, f)).mtimeMs);
  return t;
}

const usd = (n) => (n === null ? 'unpriced' : `$${n.toFixed(2)}`);
const mtok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

const opts = parseArgs(process.argv.slice(2));
const dir = streamDir(process.cwd());
const stream = resolveStreamName(process.cwd());
const source = String(opts.source || 'opencode');
if (source !== 'opencode' && source !== 'claude') {
  console.error(`Unknown --source ${source}: use opencode or claude.`);
  process.exit(2);
}
/** @type {string[]} */
let updated = [];
/** @type {string[]} */
let unreadable = [];
let refreshError = '';
if (!opts['no-backfill']) {
  if (source === 'claude') updated = backfill(dir);
  else {
    try {
      ({ updated, failed: unreadable } = refreshFromOpenCode({ dir, cwd: process.cwd() }));
    } catch (e) {
      // Report what was recorded already, and say why it may be stale.
      refreshError = e instanceof Error ? e.message : String(e);
    }
  }
}
const filled = updated.length;
// Backfilled sessions are exported like hook snapshots; --export sends every session,
// to seed a newly configured backend with the history.
const toExport = opts.export ? new Set(currentUsage(dir).map((r) => r.session)) : updated;
const exportResult = await exportSessions(dir, stream, toExport);
if (opts.export && !exportResult) {
  console.error('Export is off: set TEAM_OPS_OTLP_ENDPOINT. See the telemetry guide in the team-ops plugin.');
  process.exit(1);
}
const by = String(opts.by || 'work');
const prefix = typeof opts.work === 'string' ? opts.work : '';
const since = typeof opts.since === 'string' ? opts.since : '';

const rows = currentUsage(dir)
  .filter((r) => !prefix || String(r.work || '').startsWith(prefix) || String(r.parent_work || '').startsWith(prefix))
  .filter((r) => !since || r.last >= since);

/** @param {any} r */
const keyOf = (r) => {
  if (by === 'agent') return r.agent;
  if (by === 'model') return r.model + (r.speed === 'fast' ? ' (fast)' : '');
  if (by === 'day') return String(r.first).slice(0, 10);
  if (by === 'session') return r.session;
  return r.work || '(untagged)';
};

/** @type {Map<string, any>} */
const groups = new Map();
for (const r of rows) {
  const k = keyOf(r);
  if (!groups.has(k)) groups.set(k, { key: k, cost: 0, unpriced: false, output: 0, input_total: 0, agents: new Map(), sessions: new Set(), first: r.first, last: r.last });
  const g = groups.get(k);
  const c = costOf(r);
  if (c === null) g.unpriced = true; else g.cost += c;
  g.output += r.output;
  g.input_total += r.input + r.cache_write_5m + r.cache_write_1h + r.cache_read;
  g.sessions.add(r.session);
  if (r.first < g.first) g.first = r.first;
  if (r.last > g.last) g.last = r.last;
  const a = r.agent_id === 'main' ? `${r.agent} (lead)` : r.agent;
  g.agents.set(a, (g.agents.get(a) || 0) + (c || 0));
}
const list = [...groups.values()].sort((a, b) => (by === 'day' ? a.key.localeCompare(b.key) : b.cost - a.cost));
const total = list.reduce((s, g) => s + g.cost, 0);

if (opts.json) {
  console.log(JSON.stringify({
    stream, by, work: prefix || null, since: since || null, prices_as_of: pricesAsOf(), backfilled_sessions: filled, source, refresh_error: refreshError || null, unreadable_sessions: unreadable.length, export: exportResult,
    total_usd: Number(total.toFixed(4)),
    groups: list.map((g) => ({ key: g.key, usd: Number(g.cost.toFixed(4)), unpriced_models: g.unpriced, sessions: g.sessions.size, output_tokens: g.output, input_tokens: g.input_total, first: g.first, last: g.last,
      by_agent: Object.fromEntries([...g.agents].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number(v.toFixed(4))])) })),
  }, null, 2));
} else {
  const title = prefix ? `Cost of ${prefix}` : 'Cost';
  console.log(`# ${title}, by ${by}\n`);
  console.log(`Stream \`${stream}\`${since ? `, since ${since}` : ''}. API-equivalent estimate at list prices as of ${pricesAsOf()}; a subscription bills differently.${filled ? ` Refreshed ${filled} session(s) from ${source === 'claude' ? 'transcripts' : 'OpenCode'}.` : ''}${refreshError ? ` Could not refresh from OpenCode (${refreshError}); showing what was recorded.` : ''}${unreadable.length ? ` ${unreadable.length} session(s) could not be read.` : ''}${exportResult?.error ? ` OTLP export failed: ${exportResult.error}.` : exportResult?.exported ? ` Exported ${exportResult.exported} session(s) to OTLP.` : ''}\n`);
  if (!list.length) {
    console.log('No usage recorded yet. Usage is read from the OpenCode sessions of team agents (agents named team/role) in this project.');
  } else {
    console.log(`| ${by === 'work' ? 'Work' : by[0].toUpperCase() + by.slice(1)} | Cost | Sessions | Output | Input (incl. cache) | Biggest spenders |`);
    console.log('| --- | ---: | ---: | ---: | ---: | --- |');
    for (const g of list) {
      const top = [...g.agents].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${usd(v)}`).join(', ');
      console.log(`| ${g.key} | ${usd(g.cost)}${g.unpriced ? ' + unpriced' : ''} | ${g.sessions.size} | ${mtok(g.output)} | ${mtok(g.input_total)} | ${top} |`);
    }
    console.log(`| **Total** | **${usd(total)}** | | | | |`);
  }
}

// An unreachable OTLP endpoint can hold a socket open past the export timeout, so
// exit once the output is flushed.
process.stdout.write('', () => process.exit(0));
