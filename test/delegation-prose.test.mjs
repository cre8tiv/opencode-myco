// The agents' text is what tells a model how to delegate. OpenCode has no SendMessage, TaskCreate or
// Agent tool, so an agent that names one is told to call something that is not there; and the leads
// must name the one tool that can give an agent its own worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const agents = readdirSync(join(ROOT, 'plugins')).flatMap((team) => {
  try {
    return readdirSync(join(ROOT, 'plugins', team, 'agents')).map((f) => ({ id: `${team}/${f.replace(/\.md$/, '')}`, text: readFileSync(join(ROOT, 'plugins', team, 'agents', f), 'utf8') }));
  } catch {
    return [];
  }
});

test('no agent is told to use a Claude Code tool OpenCode does not have', () => {
  const claudeOnly = /\bSendMessage\b|\bTaskCreate\b|\bTaskUpdate\b|\bTaskList\b|claude -p/;
  for (const a of agents) assert.doesNotMatch(a.text, claudeOnly, a.id);
});

test('the leads dispatch with delegate, and the engineering lead isolates the agents that change files', () => {
  const by = Object.fromEntries(agents.map((a) => [a.id, a.text]));
  for (const lead of ['engineering-team/tech-lead', 'design-team/product-lead']) assert.match(by[lead], /`delegate`/, lead);
  assert.match(by['engineering-team/tech-lead'], /`isolated: true`/);
  assert.match(by['engineering-team/tech-lead'], /`sessionID`/);
  assert.match(by['design-team/product-lead'], /`sessionID`/);
});
