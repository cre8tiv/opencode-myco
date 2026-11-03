#!/usr/bin/env node
// PreToolUse hook (Claude Code) that makes agent-coach's propose-only mandate structural.
// The decision is in coach-guard-core.mjs; this reads the hook event, asks it, and turns
// the answer into an exit code.
//
// Exit 2 blocks the call and returns stderr to the agent. Any internal error exits
// 0 — a broken guard must never block legitimate work.
import { coachViolation, coachMessage } from './coach-guard-core.mjs';

const read = () =>
  new Promise((res) => {
    let b = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (b += d));
    process.stdin.on('end', () => res(b));
    process.stdin.on('error', () => res(''));
    setTimeout(() => res(b), 4000);
  });


try {
  const e = JSON.parse((await read()) || '{}');
  const offending = coachViolation({ agent: e.agent_type, tool: e.tool_name, input: e.tool_input });
  if (offending) {
    console.error(coachMessage(offending));
    process.exit(2);
  }
} catch {
  // A broken guard must never block legitimate work.
}
process.exit(0);
