// Writes one record to the project's event stream, free of any host.
//
// The OpenCode plugin calls it: it is handed the agent and session by the host, decides which
// events are team activity and who produced them, and this turns what it knows into a compact record, appends it where the coach reads it, and, when
// TEAM_OPS_OTLP_ENDPOINT is set, exports it as an OTel event (otlp.mjs).
//
// Successful tool calls are deliberately not recorded: that would be a record per tool call
// across every agent for a marginal signal.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamDir, resolveStreamName } from './stream.mjs';
import { exportEvent } from './otlp.mjs';

/** @param {any} v @param {number} n @returns {any} a string cut to n characters, other values as they are */
export const cap = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) + '…' : v);

/**
 * The one argument that says what a tool call was about, so a finding is traceable to a
 * command.
 * @param {any} input a tool's input @returns {any}
 */
export const targetOf = (input) => {
  const i = input || {};
  // pattern before path: a grep or glob names both, and what it searched for is the telling one.
  return cap(i.command || i.pattern || i.path || i.url || i.agent, 300);
};

/**
 * @param {{event: string, agent?: string | null, agentId?: string | null, session?: string | null, work?: string | null,
 *          parentWork?: string | null, cwd?: string, mode?: string, effort?: string, tool?: string, input?: any,
 *          error?: any, reason?: any, report?: any, task?: any}} p
 * @returns {Record<string, any>} the record, with every empty field left out
 */
export function buildEventRecord(p) {
  const rec = {
    ts: new Date().toISOString(),
    event: p.event,
    agent: p.agent,
    agent_id: p.agentId,
    session: p.session,
    work: p.work,
    parent_work: p.parentWork,
    cwd: p.cwd,
    mode: p.mode,
    effort: p.effort,
    tool: p.tool,
    target: p.tool || p.input ? targetOf(p.input) : undefined,
    error: cap(p.error, 600),
    reason: cap(p.reason, 300),
    // A subagent's stop carries the agent's own final report: the richest field here.
    report: cap(p.report, 1200),
    task: p.task,
  };
  for (const k of Object.keys(rec)) if (rec[k] === undefined || rec[k] === null) delete rec[k];
  return rec;
}

/**
 * @param {Parameters<typeof buildEventRecord>[0]} p
 * @returns {Promise<Record<string, any>>} the record written
 */
export async function recordEvent(p) {
  const rec = buildEventRecord(p);
  const dir = streamDir(p.cwd);
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  await exportEvent(dir, resolveStreamName(p.cwd), rec, 'event');
  return rec;
}
