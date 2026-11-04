// Writes one friction report to the stream, free of any host. Hooks can see what an agent
// DID; only the agent knows its instructions were unclear, which makes this the
// highest-signal input the analyst gets.
//
// The OpenCode plugin's log_friction tool calls it, handed the agent and session by the host. It
// supplies who is reporting and what work they are on; this adds the time and the working
// directory, and writes the record where the event stream is, so friction, events and cost can
// be joined.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamDir, resolveStreamName } from './stream.mjs';
import { exportEvent } from './otlp.mjs';

/** What an agent can say cost it time. */
export const FRICTION_KINDS = ['instructions', 'tooling', 'permissions', 'scope', 'environment', 'handoff'];

/**
 * @param {{cwd: string, agent: string, agentId?: string | null, session?: string | null, work?: string | null,
 *          parentWork?: string | null, kind?: string, note: string}} r
 * @returns {Promise<object>} the record written
 */
export async function recordFriction({ cwd, agent, agentId, session, work, parentWork, kind, note }) {
  const rec = {
    ts: new Date().toISOString(),
    agent,
    agent_id: agentId || undefined,
    session: session || undefined,
    work: work || undefined,
    parent_work: parentWork || undefined,
    kind: kind || 'unspecified',
    note: String(note).slice(0, 1000),
    cwd,
  };
  const dir = streamDir(cwd);
  appendFileSync(join(dir, 'friction.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  await exportEvent(dir, resolveStreamName(cwd), rec, 'friction');
  return rec;
}
