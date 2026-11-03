#!/usr/bin/env node
// PreToolUse hook (Claude Code) for the merge gate. The decision is in
// merge-gate-core.mjs; this reads the hook event, asks it, and turns the answer into an
// exit code.
//
// Exit 2 blocks the call and returns stderr to the calling agent. Any internal
// error exits 0 — a broken gate must never block legitimate work.
import { mergeVerdict } from './merge-gate-core.mjs';

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
  const message = mergeVerdict({ agent: e.agent_type, tool: e.tool_name, input: e.tool_input, cwd: e.cwd });
  if (message) {
    console.error(message);
    process.exit(2);
  }
} catch {
  // A broken gate must never block legitimate work.
}
process.exit(0);
