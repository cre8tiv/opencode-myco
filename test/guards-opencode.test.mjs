// The guards as OpenCode runs them. The decisions are tested through the Claude Code hook
// scripts (coach-guard.test.mjs, merge-gate.test.mjs) because they share one core; these
// cover what is specific to the OpenCode side: its tool names and input fields, who counts
// as a team agent, that a block is a thrown error, and that nothing here can block work
// because the guard itself broke. Event shapes are the ones recorded from a live run.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { install } from '../scripts/install.mjs';
import { registerGuards, isTeamAgent, profileDirectory } from '../opencode-plugin/myco/guards.js';
import { parse } from 'node:path';

/** A plugin context that keeps the hooks it is given. */
function fakeCtx(directory) {
  /** @type {Record<string, (e: any) => any>} */
  const hooks = {};
  return { hooks, ctx: { location: { directory }, tool: { hook: async (name, fn) => { hooks[name] = fn; } } } };
}

/** Installs the teams, registers the guards for a project, and returns a way to ask them about a call. */
async function guarded(t, { profile } = {}) {
  const sb = sandbox(t);
  const target = join(sb.root, 'oc');
  install({ target });
  const project = join(sb.root, 'proj');
  mkdirSync(join(project, '.claude', 'team'), { recursive: true });
  if (profile) writeFileSync(join(project, '.claude', 'team', 'project.md'), `---\n${profile}\n---\n`);
  const { ctx, hooks } = fakeCtx(project);
  const loaded = await registerGuards(ctx, join(target, 'myco'));
  /** @returns {string | null} the message the call was blocked with, or null when it ran */
  const ask = (event) => {
    try {
      hooks['execute.before']({ sessionID: 's', messageID: 'm', id: 'c', ...event });
      return null;
    } catch (e) {
      return e.message;
    }
  };
  return { ask, hooks, loaded, project, target };
}

const COACH = 'team-ops/agent-coach';
const LEAD = 'engineering-team/tech-lead';

describe('who is a team agent', () => {
  test('team agents are named team/role; a human\'s session and plain custom agents are not', () => {
    assert.equal(isTeamAgent('engineering-team/ic-generalist'), true);
    assert.equal(isTeamAgent('build'), false);
    assert.equal(isTeamAgent('plan'), false);
    assert.equal(isTeamAgent(undefined), false);
  });
});

describe('the agent-coach guard', () => {
  test('loads from an install', async (t) => {
    assert.deepEqual((await guarded(t)).loaded, { coach: true, merge: true });
  });

  test('blocks file writes outside the reports directory, under OpenCode\'s tool names and fields', async (t) => {
    const { ask } = await guarded(t);
    for (const call of [
      { tool: 'write', input: { path: 'a.txt', content: 'x' } },
      { tool: 'write', input: { path: '/home/dev/proj/b.txt', content: 'w' } },
      { tool: 'edit', input: { path: '.claude/team/project.md', oldString: 'a', newString: 'b' } },
      { tool: 'write', input: { path: '.claude/ops/reports/../../team/project.md', content: 'x' } },
    ]) {
      assert.match(ask({ agent: COACH, ...call }) ?? '', /agent-coach is propose-only/, JSON.stringify(call.input));
    }
  });

  test('lets the coach write its report, by a relative or an absolute path, and edit it', async (t) => {
    const { ask } = await guarded(t);
    for (const call of [
      { tool: 'write', input: { path: '.claude/ops/reports/2026-11-03-agent-health.md', content: 'y' } },
      { tool: 'write', input: { path: '/home/dev/proj/.claude/ops/reports/abs.md', content: 'z' } },
      { tool: 'edit', input: { path: '.claude/ops/reports/keep.md', oldString: 'r', newString: 'edited' } },
      { tool: 'read', input: { path: 'a.txt' } },
    ]) {
      assert.equal(ask({ agent: COACH, ...call }), null, JSON.stringify(call.input));
    }
  });

  test('blocks what the native permission rules cannot see: a shell redirect that writes a file', async (t) => {
    // The agent's edit rules cover the write and edit tools only; in a live run
    // `echo x > c.txt` was allowed and the file was created.
    const { ask } = await guarded(t);
    assert.match(ask({ agent: COACH, tool: 'shell', input: { command: 'echo shellwrite > c.txt' } }) ?? '', /propose-only/);
    assert.match(ask({ agent: COACH, tool: 'shell', input: { command: 'rm -rf .claude/team' } }) ?? '', /propose-only/);
    assert.match(ask({ agent: COACH, tool: 'shell', input: { command: 'bash -c "echo x > c.txt"' } }) ?? '', /propose-only/);
  });

  test('lets the coach read and run ordinary commands', async (t) => {
    const { ask } = await guarded(t);
    for (const command of ['echo ROOT=$MYCO_ROOT', 'git log --oneline -5', 'cat a.txt | wc -l', 'echo report > .claude/ops/reports/r.md']) {
      assert.equal(ask({ agent: COACH, tool: 'shell', input: { command } }), null, command);
    }
  });

  test('other agents may write anywhere', async (t) => {
    const { ask } = await guarded(t);
    assert.equal(ask({ agent: 'engineering-team/ic-generalist', tool: 'write', input: { path: 'src/app.ts', content: 'x' } }), null);
    assert.equal(ask({ agent: 'build', tool: 'shell', input: { command: 'echo x > c.txt' } }), null);
  });
});

describe('the merge gate', () => {
  test('stops a team agent merging a PR or pushing the trunk, in every spelling the core knows', async (t) => {
    const { ask } = await guarded(t);
    for (const command of ['gh pr merge 5', 'gh pr merge 5 --squash', 'git push origin main', 'git push origin HEAD:main', 'bash -c "gh pr merge 1"', 'gh api repos/o/r/pulls/42/merge -X PUT']) {
      assert.match(ask({ agent: LEAD, tool: 'shell', input: { command } }) ?? '', /merge_policy is "human-approval"/, command);
    }
  });

  test('applies to every team agent, not only the lead', async (t) => {
    const { ask } = await guarded(t);
    for (const agent of ['engineering-team/ic-generalist', 'engineering-team/qa-specialist', 'design-team/architect']) {
      assert.match(ask({ agent, tool: 'shell', input: { command: 'gh pr merge 5' } }) ?? '', /merge_policy/, agent);
    }
  });

  test('leaves ordinary git and gh alone, including merging the trunk into a branch', async (t) => {
    const { ask } = await guarded(t);
    for (const command of ['gh pr view 5', 'gh pr create --title x --body-file b.md', 'git push origin feature/x', 'git merge origin/main', 'git commit -m "gh pr merge is blocked for agents"']) {
      assert.equal(ask({ agent: LEAD, tool: 'shell', input: { command } }), null, command);
    }
  });

  test('never blocks a human: their session\'s agent is "build", not a team agent', async (t) => {
    const { ask } = await guarded(t);
    assert.equal(ask({ agent: 'build', tool: 'shell', input: { command: 'gh pr merge 5' } }), null);
    assert.equal(ask({ agent: undefined, tool: 'shell', input: { command: 'git push origin main' } }), null);
  });

  test('reads the policy from the project profile, from where the plugin runs', async (t) => {
    const gated = await guarded(t, { profile: 'merge_policy: human-approval' });
    assert.match(gated.ask({ agent: LEAD, tool: 'shell', input: { command: 'git push origin main' } }) ?? '', /merge_policy/);
    // Autonomous still requires a passing QA run for a PR merge; a trunk push has no PR to check.
    const auto = await guarded(t, { profile: 'merge_policy: autonomous' });
    assert.equal(auto.ask({ agent: LEAD, tool: 'shell', input: { command: 'git push origin main' } }), null);
  });

  test('honors a configured trunk branch', async (t) => {
    const { ask } = await guarded(t, { profile: 'trunk_branch: develop' });
    assert.match(ask({ agent: LEAD, tool: 'shell', input: { command: 'git push origin develop' } }) ?? '', /merge_policy/);
    assert.equal(ask({ agent: LEAD, tool: 'shell', input: { command: 'git push origin main' } }), null);
  });
});

describe('commands another plugin has rewritten', () => {
  // The caveman plugin rewrites a shell command to this before the guards run; in a live run the
  // merge went through because neither the guard nor the native rule recognised it.
  const WRAP = "'/opt/homebrew/bin/node' '/opt/homebrew/bin/caveman' shrink -- ";

  test('a merge behind a wrapper, or with options before the subcommand, is still stopped', async (t) => {
    const { ask } = await guarded(t);
    for (const command of [WRAP + 'gh pr merge 5', WRAP + 'git push origin main', 'rtk gh pr merge 5', 'gh --repo o/r pr merge 5']) {
      assert.match(ask({ agent: LEAD, tool: 'shell', input: { command } }) ?? '', /merge_policy is "human-approval"/, command);
    }
    assert.equal(ask({ agent: LEAD, tool: 'shell', input: { command: WRAP + 'git log --oneline -5' } }), null);
  });

  test('a write behind a wrapper is still stopped for the coach', async (t) => {
    const { ask } = await guarded(t);
    for (const command of [WRAP + 'rm -rf .claude/team', 'rtk rm -rf .claude/team', WRAP + 'echo x > c.txt']) {
      assert.match(ask({ agent: COACH, tool: 'shell', input: { command } }) ?? '', /propose-only/, command);
    }
    assert.equal(ask({ agent: COACH, tool: 'shell', input: { command: WRAP + 'git log --oneline -5' } }), null);
  });
});

describe('where the project profile is looked for', () => {
  test('it is the directory the plugin instance runs in', () => {
    assert.equal(profileDirectory({ location: { directory: '/work/proj' } }), '/work/proj');
  });

  test('with no directory from the host it looks nowhere, not wherever the server happens to run', () => {
    for (const ctx of [{}, { location: {} }, { location: { directory: '' } }, { location: { directory: 42 } }, undefined]) {
      assert.equal(profileDirectory(ctx), parse(process.cwd()).root, JSON.stringify(ctx));
    }
  });

  test('a missing directory is gated even when the server runs inside a project that allows merging', async (t) => {
    // The server's own directory is some project with an autonomous profile; without a directory
    // from the host the gate must not read it.
    const sb = sandbox(t);
    install({ target: join(sb.root, 'oc') });
    const elsewhere = join(sb.root, 'elsewhere');
    mkdirSync(join(elsewhere, '.claude', 'team'), { recursive: true });
    writeFileSync(join(elsewhere, '.claude', 'team', 'project.md'), '---\nmerge_policy: autonomous\n---\n');
    const { ctx, hooks } = fakeCtx(undefined);
    delete ctx.location;
    await registerGuards(ctx, join(sb.root, 'oc', 'myco'));
    const before = process.cwd();
    process.chdir(elsewhere);
    try {
      assert.throws(() => hooks['execute.before']({ agent: LEAD, tool: 'shell', input: { command: 'git push origin main' } }), /merge_policy is "human-approval"/);
    } finally {
      process.chdir(before);
    }
  });

  test('the shell call\'s own workdir does not choose the policy: the agent controls it', async (t) => {
    const { ask, project } = await guarded(t);
    const other = join(project, '..', 'other');
    mkdirSync(join(other, '.claude', 'team'), { recursive: true });
    writeFileSync(join(other, '.claude', 'team', 'project.md'), '---\nmerge_policy: autonomous\n---\n');
    assert.match(ask({ agent: LEAD, tool: 'shell', input: { command: 'git push origin main', workdir: other } }) ?? '', /merge_policy is "human-approval"/);
  });
});

describe('failing safe', () => {
  test('a block is a thrown Error carrying the message, so the call does not run', async (t) => {
    const { ctx, hooks } = fakeCtx('/nowhere');
    const sb = sandbox(t);
    install({ target: join(sb.root, 'oc') });
    await registerGuards(ctx, join(sb.root, 'oc', 'myco'));
    assert.throws(() => hooks['execute.before']({ agent: COACH, tool: 'write', input: { path: 'a.txt' } }), (e) => e instanceof Error && /propose-only/.test(e.message));
  });

  test('with no team installed there is no guard and nothing breaks', async (t) => {
    const sb = sandbox(t);
    const { ctx, hooks } = fakeCtx(sb.project);
    assert.deepEqual(await registerGuards(ctx, join(sb.root, 'empty')), { coach: false, merge: false });
    assert.doesNotThrow(() => hooks['execute.before']({ agent: COACH, tool: 'write', input: { path: 'a.txt' } }));
  });

  test('an error while judging a call lets the call through', async (t) => {
    const { ask, hooks } = await guarded(t);
    // Called directly: the getter must be read by the guard, not by a helper that spreads the event.
    assert.doesNotThrow(() => hooks['execute.before']({ agent: COACH, tool: 'write', get input() { throw new Error('boom'); } }));
    assert.equal(ask({}), null);
    assert.equal(ask({ agent: LEAD, tool: 'shell', input: null }), null);
    assert.equal(ask({ agent: COACH, tool: 'shell', input: { command: 42 } }), null);
  });
});
