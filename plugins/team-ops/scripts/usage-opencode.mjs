// Token usage from OpenCode sessions, as the records usage-lib's reports already read.
//
// OpenCode keeps every session, and each model response in it carries the agent, the model and the
// tokens it used. Any program can ask for them, so usage is pulled from OpenCode when a report
// asks, not pushed by hooks the way Claude Code needed. The same records come out, so cost.mjs and
// the OTel export (otlp.mjs) work on them unchanged.
//
// Attribution is usage-lib's: a lead names the work it is on with the start_work tool, that call
// sits in its session with a time, and the lead's own usage after it belongs to that work. A
// dispatched agent belongs to the "[TAG]" its task begins with, else to the lead's work when it
// was dispatched. A dispatched agent's session is found from the lead's subagent call.
//
// Two things differ from Claude Code's transcripts:
//
// - A session's own token total is larger than the sum of its responses. The difference is in no
//   message: it is OpenCode's hidden internal agents (the one that titles a session, for one). It
//   is reported as its own "internal" line, so totals reconcile instead of the usage vanishing.
// - Cache writes come as one number, with no 5-minute/1-hour split; they are priced as 5-minute
//   writes. Reasoning tokens come separately from output, and are billed as output, so they are
//   added to it.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { appendUsage, bracketTag, currentUsage, tagAt } from './usage-lib.mjs';

/** A team agent is named team/role. Whatever else ran in a session is not the teams'. */
const isTeam = (agent) => typeof agent === 'string' && agent.includes('/');

const iso = (ms) => new Date(ms).toISOString();
const timeOf = (m) => m?.time?.created ?? 0;
/** Responses that used tokens: a message that only made a tool call carries none and is not a request. */
const assistants = (messages) =>
  (messages || []).filter((m) => m?.type === 'assistant' && m.tokens && (m.tokens.input || m.tokens.output || m.tokens.reasoning || m.tokens.cache?.read || m.tokens.cache?.write));

/** @param {any} v @returns {any[]} a list that came back bare, or inside {data} */
const listOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : []);

/** The work each start_work call named, and when, in time order. */
export function workTagsOf(messages) {
  const tags = [];
  for (const m of messages || []) {
    if (m?.type !== 'assistant') continue;
    for (const c of m.content || []) {
      if (c?.type !== 'tool' || c.name !== 'start_work') continue;
      const tag = String(c.state?.input?.tag || '').trim().split(/\s+/)[0];
      if (tag) tags.push({ at: iso(timeOf(m)), tag });
    }
  }
  return tags.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The sessions a lead dispatched agents into, from its subagent and delegate calls: the session, the task, and when. */
export function dispatchesOf(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m?.type !== 'assistant') continue;
    for (const c of m.content || []) {
      // In a stored session the child is named in the tool part's metadata (the live hook result carries it as output.sessionID).
      // Both dispatching tools say it there: OpenCode's subagent, and the plugin's delegate.
      const id = c?.type === 'tool' && (c.name === 'subagent' || c.name === 'delegate') ? c.state?.metadata?.sessionID : null;
      if (id) out.push({ sessionID: id, description: c.state?.input?.description, at: timeOf(m) });
    }
  }
  return out;
}

/** @param {any} m an assistant message @returns the token classes usage-lib prices */
const tokensOf = (m) => ({
  input: m.tokens.input || 0,
  output: (m.tokens.output || 0) + (m.tokens.reasoning || 0),
  cache_write_5m: m.tokens.cache?.write || 0,
  cache_write_1h: 0,
  cache_read: m.tokens.cache?.read || 0,
});

const CLASSES = ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'];

/** What a session reports as used, minus what its messages account for: the internal agents' share. */
function residualOf(session) {
  const total = tokensOf({ tokens: session.info?.tokens || {} });
  const seen = Object.fromEntries(CLASSES.map((k) => [k, 0]));
  for (const m of assistants(session.messages)) for (const k of CLASSES) seen[k] += tokensOf(m)[k];
  return Object.fromEntries(CLASSES.map((k) => [k, Math.max(0, total[k] - seen[k])]));
}

/**
 * The usage records for a lead session and the sessions of the agents it dispatched, in the shape
 * usage-lib reads: per agent, unit of work and model.
 * @param {{lead: {id: string, info: any, messages: any[]}, children?: Map<string, {info: any, messages: any[]}>, snap?: string}} p
 * @returns {object[]}
 */
export function usageRecords({ lead, children = new Map(), snap = new Date().toISOString() }) {
  const isLead = isTeam(lead.info?.agent);
  const tags = workTagsOf(lead.messages);
  /** @type {Map<string, any>} */
  const out = new Map();
  const counted = [];

  const updatedAt = lead.info?.time?.updated ?? 0;
  const put = (agentId, agent, work, parentWork, m) => {
    const model = m.model?.id || lead.info?.model?.id || 'unknown';
    const key = [agentId, work, model].join('|');
    if (!out.has(key)) {
      out.set(key, { snap, source_updated: updatedAt, session: lead.id, agent_id: agentId, agent, work, parent_work: parentWork, model, provider: m.model?.providerID, speed: 'standard', input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, requests: 0, first: iso(timeOf(m)), last: iso(timeOf(m)) });
    }
    const rec = out.get(key);
    for (const [k, v] of Object.entries(tokensOf(m))) rec[k] += v;
    rec.requests += 1;
    if (iso(timeOf(m)) < rec.first) rec.first = iso(timeOf(m));
    if (iso(timeOf(m)) > rec.last) rec.last = iso(timeOf(m));
  };

  if (isLead) {
    counted.push(lead);
    for (const m of assistants(lead.messages)) {
      const work = tagAt(tags, iso(timeOf(m)));
      put('main', m.agent || lead.info.agent, work, work, m);
    }
  }

  for (const d of dispatchesOf(lead.messages)) {
    const child = children.get(d.sessionID);
    if (!child) continue;
    const parentWork = tagAt(tags, iso(d.at));
    const work = bracketTag(d.description) || parentWork;
    let used = false;
    for (const m of assistants(child.messages)) {
      const agent = m.agent || child.info?.agent;
      // In a lead's session everything it dispatched is the team's cost. Elsewhere, only team agents count.
      if (!isLead && !isTeam(agent)) continue;
      put(d.sessionID, agent, work, parentWork, m);
      used = true;
    }
    if (used) counted.push(child);
  }

  // The internal agents' share, across the sessions counted above, reported as its own line.
  const residual = Object.fromEntries(CLASSES.map((k) => [k, counted.reduce((s, c) => s + residualOf(c)[k], 0)]));
  if (CLASSES.some((k) => residual[k] > 0)) {
    const last = assistants(lead.messages).at(-1) || assistants(counted.at(-1)?.messages).at(-1);
    const work = tagAt(tags, iso(timeOf(last)));
    out.set('internal', { snap, source_updated: updatedAt, session: lead.id, agent_id: 'internal', agent: 'internal', work, parent_work: work, model: last?.model?.id || lead.info?.model?.id || 'unknown', provider: last?.model?.providerID, speed: 'standard', ...residual, requests: 0, first: iso(lead.info?.time?.created ?? timeOf(last)), last: iso(lead.info?.time?.updated ?? timeOf(last)) });
  }
  return [...out.values()];
}

/**
 * Runs OpenCode. MYCO_OPENCODE names a script to run with node in place of it; the tests use it, as
 * the merge gate's tests use MERGE_GATE_GH.
 * @param {string[]} args @param {string} cwd
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
export function execOpencode(args, cwd) {
  const script = process.env.MYCO_OPENCODE;
  const res = script
    ? spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024 })
    : spawnSync('opencode', args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  // A spawn that failed has no exit status: say why, so a missing binary is not confused with a timeout.
  const missing = res.error?.code === 'ENOENT';
  return { status: res.status ?? (missing ? 127 : null), stdout: res.stdout || '', stderr: res.stderr || (res.error && !missing ? res.error.message : '') };
}

/** A GET against OpenCode's API, parsed. */
function get(exec, cwd, path, params = {}) {
  const flags = Object.entries(params).flatMap(([k, v]) => ['--param', `${k}=${v}`]);
  const res = exec(['api', '--standalone', ...flags, 'GET', path], cwd);
  if (res.status === 127) throw new Error('`opencode` was not found on PATH');
  if (res.status !== 0) throw new Error(`opencode api GET ${path} failed: ${(res.stderr || res.stdout).trim().slice(0, 200) || `exit ${res.status}`}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`opencode api GET ${path} did not return JSON`);
  }
}

const sameDir = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

/** The project a directory belongs to: it, or one of its worktrees. */
function projectOf(exec, cwd) {
  for (const p of listOf(get(exec, cwd, '/api/project'))) {
    const dirs = [p.canonical, ...(p.sandboxes || []).map((s) => (typeof s === 'string' ? s : s?.directory))].filter(Boolean);
    if (dirs.some((d) => sameDir(d, cwd))) return p.id;
  }
  return null;
}

/**
 * Brings the usage log up to date with OpenCode: every top-level team session of this project that has
 * changed since it was last recorded is read, with the agents it dispatched, and recorded again. A
 * snapshot is cumulative and supersedes the earlier one, so doing this twice records the same thing.
 * Sessions OpenCode no longer has are not lost: what was recorded stays.
 * @param {{dir: string, cwd: string, exec?: typeof execOpencode, now?: () => number}} p dir is the stream directory
 * @returns {{updated: string[], failed: string[], unreadableChildren: number}} the sessions recorded, the ones that could not be read, and dispatched sessions that could not be
 */
export function refreshFromOpenCode({ dir, cwd, exec = execOpencode, now = Date.now }) {
  const snap = new Date(now()).toISOString();
  const project = projectOf(exec, cwd);
  if (!project) return { updated: [], failed: [] };

  const sessions = new Map();
  let cursor;
  for (let page = 0; page < 40; page++) {
    const res = get(exec, cwd, '/api/session', { project, limit: 100, ...(cursor ? { cursor } : {}) });
    const rows = listOf(res);
    const before = sessions.size;
    for (const s of rows) sessions.set(s.id, s);
    cursor = res?.cursor?.next;
    if (!cursor || sessions.size === before) break;
  }

  // When OpenCode last changed each session, as of the latest record of it. A session is read again only when it has changed since.
  const seen = new Map();
  for (const r of currentUsage(dir)) seen.set(r.session, Math.max(seen.get(r.session) ?? 0, r.source_updated ?? 0));

  const updated = [];
  const failed = [];
  let unreadableChildren = 0;
  for (const s of sessions.values()) {
    // A session that is not a team agent is read too: a team agent it dispatched is still the teams' cost.
    // An agent delegate gave its own worktree has no parent session; its lead's delegate call names it, and counts it.
    if (s.parentID || s.metadata?.mycoParent) continue;
    if (seen.has(s.id) && seen.get(s.id) >= (s.time?.updated ?? 0)) continue;
    try {
      const messages = listOf(get(exec, cwd, `/api/session/${s.id}/context`));
      const children = new Map();
      for (const d of dispatchesOf(messages)) {
        // One dispatched session OpenCode no longer has must not lose the rest of the lead's usage.
        try {
          const info = get(exec, cwd, `/api/session/${d.sessionID}`);
          children.set(d.sessionID, { info: info?.data || info, messages: listOf(get(exec, cwd, `/api/session/${d.sessionID}/context`)) });
        } catch {
          unreadableChildren++;
        }
      }
      const records = usageRecords({ lead: { id: s.id, info: s, messages }, children, snap });
      appendUsage(dir, records);
      if (records.length) updated.push(s.id);
    } catch {
      failed.push(s.id);
    }
  }
  return { updated, failed, unreadableChildren };
}
