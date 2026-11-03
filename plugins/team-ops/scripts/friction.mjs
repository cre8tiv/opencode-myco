#!/usr/bin/env node
// Self-report sink. Any agent that hits process friction it can name appends here:
//
//   node "<plugin>/scripts/friction.mjs" --agent ic-generalist --kind instructions \
//     --note "definition says run the test script but names none" [--work CLOUD-123]
//
// kind: instructions | tooling | permissions | scope | environment | handoff
//
// Hooks can see what an agent DID; only the agent knows its instructions were
// unclear. That makes this the highest-signal input the analyst gets.
//
// The record carries the fields every team-ops record shares (context.mjs): the
// session comes from Claude Code's environment, the agent's full name and its unit of
// work from the session's transcripts. --work overrides the work, for a report about
// a package or ticket other than the one in hand; --ticket is its older name.
import { resolveSelf } from './context.mjs';
import { recordFriction } from './friction-core.mjs';

const a = process.argv.slice(2);
const get = (f) => {
  const i = a.indexOf(f);
  return i >= 0 ? a[i + 1] : undefined;
};

const note = get('--note');
if (!note) {
  console.error(
    'usage: friction.mjs --agent <name> --kind <instructions|tooling|permissions|scope|environment|handoff> --note "<what cost you time>" [--work <ticket or package slug>]',
  );
  process.exit(1);
}

try {
  const name = get('--agent') || 'unknown';
  let ctx = { agent: name, agent_id: null, session: process.env.CLAUDE_CODE_SESSION_ID || null, work: null, parent_work: null };
  try {
    ctx = resolveSelf(process.env.CLAUDE_CODE_SESSION_ID, name);
  } catch { /* the report matters more than its context */ }
  const work = get('--work') || get('--ticket');
  await recordFriction({
    cwd: process.cwd(),
    agent: ctx.agent,
    agentId: ctx.agent_id,
    session: ctx.session,
    work: work || ctx.work,
    parentWork: ctx.parent_work,
    kind: get('--kind'),
    note,
  });
  console.log('friction logged');
} catch (err) {
  console.error('friction log failed:', err.message);
  process.exit(1);
}
process.exit(0);
