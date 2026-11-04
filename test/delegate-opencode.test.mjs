// The delegate tool, against a stand-in for the host's session and worktree APIs. What OpenCode
// itself does with these calls (a child created with a parentID inherits the parent's location and
// ignores the one given; a session permission denies the lead's checkout) was checked against
// OpenCode 2.2.5 in the S7 spike and is checked again, live, by the opt-in suite; these tests cover
// what the tool does with the answers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { registerDelegate, finalText } from '../opencode-plugin/myco/delegate.js';
import { createWorkTracker } from '../opencode-plugin/myco/work.js';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const IC = 'engineering-team/ic-generalist';

const assistantText = (text) => ({ type: 'assistant', content: [{ type: 'text', text }] });

/** A git project, and a plugin context whose sessions answer as the test says. */
async function setup(t, { report = 'done', outcome, error, onPrompt, createFails, noId, promptFails } = {}) {
  const sb = sandbox(t);
  git(sb.project, 'init', '-q', '-b', 'main');
  git(sb.project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const calls = { created: [], prompts: [], interrupts: [], removed: [], worktrees: [] };
  let n = 0;
  const ctx = {
    location: { directory: sb.project, project: { id: 'proj-1' } },
    storage: undefined,
    worktree: {
      create: async (input) => {
        const directory = join(sb.root, `wt-${++n}`);
        git(sb.project, 'worktree', 'add', '-q', '--detach', directory);
        calls.worktrees.push(input);
        return { directory };
      },
      remove: async (input) => {
        calls.removed.push(input);
        git(sb.project, 'worktree', 'remove', input.directory);
      },
    },
    session: {
      create: async (input) => {
        if (createFails) throw new Error('create failed');
        calls.created.push(input);
        return noId ? {} : { id: `ses_child_${calls.created.length}` };
      },
      prompt: async (input) => {
        calls.prompts.push(input);
        if (promptFails) throw new Error('prompt failed');
        await onPrompt?.(input, calls);
      },
      wait: async () => undefined,
      context: async () => [assistantText('thinking'), ...(error ? [{ type: 'assistant', content: [], error }] : [assistantText(report)])],
      get: async () => ({ id: 'x', outcome }),
      interrupt: async (input) => void calls.interrupts.push(input),
    },
    tool: {},
  };
  const defs = {};
  ctx.tool.transform = async (fn) => fn({ add: (d) => { defs[d.name] = d; } });
  const work = createWorkTracker(ctx);
  await registerDelegate(ctx, work);
  const run = (input, context = {}) => defs.delegate.execute(input, { sessionID: 'ses_lead', ...context });
  return { sb, ctx, calls, defs, work, run };
}

/**
 * The host rejects a result whose `output` the tool didn't declare a schema for, as a defect after the agent has
 * run (seen in a live run), and encodes it against the schema when it did: so the output must match.
 */
function assertConforms(output, schema) {
  assert.ok(schema, 'the tool declares an output schema');
  for (const k of schema.required) assert.ok(k in output, `output has ${k}`);
  for (const [k, v] of Object.entries(output)) {
    assert.ok(k in schema.properties, `${k} is declared`);
    assert.notEqual(v, undefined, `${k} is not undefined`);
    assert.equal(typeof v, schema.properties[k].type, `${k} has its declared type`);
  }
}

describe('registration', () => {
  test('is a JSON-schema tool the model sees directly, with the arguments a lead needs', async (t) => {
    const { defs } = await setup(t);
    const d = defs.delegate;
    assert.equal(d.options.codemode, false);
    assert.deepEqual(d.input.required, ['agent', 'description', 'prompt']);
    assert.deepEqual(Object.keys(d.input.properties).sort(), ['agent', 'branch', 'description', 'isolated', 'prompt', 'sessionID']);
    assert.equal(d.input.additionalProperties, false);
  });

  test('finalText finds the last thing the agent said', () => {
    assert.equal(finalText([assistantText('a'), assistantText('b'), { type: 'assistant', content: [{ type: 'tool' }] }]), 'b');
    assert.equal(finalText({ data: [assistantText('c')] }), 'c');
    assert.equal(finalText([]), '');
  });
});

describe('a shared-checkout agent', () => {
  test('is a child of the lead, in the lead\'s checkout, and its report comes back with its session', async (t) => {
    const { sb, calls, run, defs } = await setup(t, { report: 'reviewed it' });
    const r = await run({ agent: IC, description: '[CLOUD-1] review', prompt: 'look at the diff' });
    assert.deepEqual(calls.created[0], { title: '[CLOUD-1] review', agent: IC, parentID: 'ses_lead', location: { directory: sb.project } });
    assert.equal(calls.prompts[0].text, 'look at the diff');
    assert.match(r.content, /<delegate sessionID="ses_child_1" state="completed">\nreviewed it\n<\/delegate>/);
    assert.deepEqual(r.metadata, { sessionID: 'ses_child_1', status: 'completed' });
    assert.equal(r.output.output, 'reviewed it');
    assertConforms(r.output, defs.delegate.output);
    assert.equal(calls.worktrees.length, 0);
  });

  test('passing a session back continues it with its context instead of creating another', async (t) => {
    const { calls, run } = await setup(t);
    await run({ agent: IC, description: '[CLOUD-1] more', prompt: 'and now this', sessionID: 'ses_child_9' });
    assert.equal(calls.created.length, 0);
    assert.equal(calls.prompts[0].sessionID, 'ses_child_9');
  });

  test('the dispatched session starts on the work its task names, else its lead\'s work', async (t) => {
    const { work, run } = await setup(t);
    await work.set('ses_lead', 'CLOUD-9');
    await run({ agent: IC, description: '[CLOUD-1] one', prompt: 'p' });
    await run({ agent: IC, description: 'two', prompt: 'p' });
    assert.equal(work.peek('ses_child_1'), 'CLOUD-1');
    assert.equal(work.peek('ses_child_2'), 'CLOUD-9');
    assert.equal(work.parentOf('ses_child_1'), 'ses_lead');
  });
});

describe('an isolated agent', () => {
  test('gets a worktree, no parentID (it would send the child back to the lead\'s checkout), and a deny on the lead\'s checkout', async (t) => {
    const { sb, calls, run, defs } = await setup(t);
    const r = await run({ agent: IC, description: '[CLOUD-1] build', prompt: 'p', isolated: true });
    const created = calls.created[0];
    assert.equal('parentID' in created, false);
    assert.deepEqual(created.metadata, { mycoParent: 'ses_lead' });
    assert.notEqual(created.location.directory, sb.project);
    assert.deepEqual(created.permissions, [{ action: 'edit', resource: `${sb.project}/**`, effect: 'deny' }]);
    assert.equal(calls.worktrees[0].projectID, 'proj-1');
    assert.equal(r.output.worktreeRemoved, true, 'nothing changed, so nothing is kept');
    assertConforms(r.output, defs.delegate.output);
    assert.match(r.content, /worktree was removed/);
  });

  test('a worktree with changes is kept and reported with its branch', async (t) => {
    const { calls, run, defs } = await setup(t, {
      onPrompt: (input, c) => writeFileSync(join(c.created[0].location.directory, 'new.txt'), 'work'),
    });
    const r = await run({ agent: IC, description: '[CLOUD-1] build', prompt: 'p', isolated: true, branch: 'feature/cloud-1' });
    const dir = calls.created[0].location.directory;
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/cloud-1');
    assert.ok(existsSync(join(dir, 'new.txt')));
    assert.equal(calls.removed.length, 0);
    assert.equal(r.output.worktree, dir);
    assert.equal(r.output.branch, 'feature/cloud-1');
    assertConforms(r.output, defs.delegate.output);
    assert.match(r.content, new RegExp(`worktree: ${dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\nbranch: feature/cloud-1`));
  });

  test('a detached worktree whose commit a branch already holds leaves nothing to keep', async (t) => {
    // A reviewer checks out the commit it is reviewing: HEAD moves, but the commit is on a branch.
    const { sb, calls, run, defs } = await setup(t, {
      onPrompt: (_i, c) => {
        const dir = c.created[0].location.directory;
        git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'work');
        git(dir, 'branch', 'feature/kept');
      },
    });
    const r = await run({ agent: 'engineering-team/code-reviewer', description: 'x', prompt: 'p', isolated: true });
    assert.equal(r.output.worktreeRemoved, true);
    assert.equal(calls.removed.length, 1);
    assertConforms(r.output, defs.delegate.output);
    assert.match(git(sb.project, 'branch', '--list', 'feature/kept'), /feature\/kept/, 'the branch, and the work on it, stays');
  });

  test('a detached commit no branch holds is kept: removing the worktree would lose it', async (t) => {
    const { calls, run } = await setup(t, {
      onPrompt: (_i, c) => git(c.created[0].location.directory, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'orphan'),
    });
    const r = await run({ agent: IC, description: 'x', prompt: 'p', isolated: true });
    assert.equal(r.output.worktreeRemoved, false);
    assert.equal(calls.removed.length, 0);
  });

  test('a branch that cannot be created fails the call and leaves no empty worktree behind', async (t) => {
    const { sb, calls, run } = await setup(t);
    git(sb.project, 'branch', 'taken');
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p', isolated: true, branch: 'taken' }), /Could not start branch taken/);
    assert.equal(calls.created.length, 0);
    assert.equal(calls.removed.length, 1);
  });

  test('a session that fails to create does not strand its worktree', async (t) => {
    const { calls, run } = await setup(t, { createFails: true });
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p', isolated: true }), /create failed/);
    assert.equal(calls.removed.length, 1);
  });

  test('a session the host answers without an id does not strand the worktree', async (t) => {
    const { calls, run } = await setup(t, { noId: true });
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p', isolated: true }), /did not say which/);
    assert.equal(calls.removed.length, 1);
  });

  test('a prompt that throws removes the untouched worktree and the branch made in it', async (t) => {
    const { sb, calls, run } = await setup(t, { promptFails: true });
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p', isolated: true, branch: 'feature/gone' }), /prompt failed/);
    assert.equal(calls.removed.length, 1);
    assert.equal(git(sb.project, 'branch', '--list', 'feature/gone'), '', 'the branch delegate made is deleted with it');
  });

  test('a branch that already existed is never deleted by cleanup', async (t) => {
    const { sb, run } = await setup(t);
    git(sb.project, 'branch', 'taken');
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p', isolated: true, branch: 'taken' }), /Could not start branch/);
    assert.match(git(sb.project, 'branch', '--list', 'taken'), /taken/);
  });

  test('continuing a session does not take isolated', async (t) => {
    const { run } = await setup(t);
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p', sessionID: 's', isolated: true }), /keeps the worktree/);
  });
});

describe('what goes wrong', () => {
  test('an agent that is not a team agent is refused before anything is created', async (t) => {
    const { calls, run } = await setup(t);
    await assert.rejects(() => run({ agent: 'build', description: 'x', prompt: 'p' }), /not one/);
    assert.equal(calls.created.length, 0);
  });

  test('a failed run throws, naming the session and why, so the lead can continue it', async (t) => {
    const { run } = await setup(t, { outcome: 'failed', error: { message: 'provider timed out' } });
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p' }), /Agent failed \(sessionID: ses_child_1\): provider timed out/);
  });

  test('an interrupted run is reported as cancelled', async (t) => {
    const { run } = await setup(t, { outcome: 'interrupted' });
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p' }), /Agent cancelled \(sessionID: ses_child_1\)/);
  });

  test('aborting the lead\'s call interrupts the child', async (t) => {
    const controller = new AbortController();
    const { calls, run } = await setup(t, { onPrompt: () => controller.abort() });
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p' }, { signal: controller.signal }), /cancelled/);
    assert.ok(calls.interrupts.length >= 1);
    assert.ok(calls.interrupts.every((i) => i.sessionID === 'ses_child_1'));
  });

  test('a failed isolated run that changed nothing removes its worktree', async (t) => {
    const { calls, run } = await setup(t, { outcome: 'failed', error: 'boom' });
    await assert.rejects(() => run({ agent: IC, description: 'x', prompt: 'p', isolated: true }), /worktree was removed/);
    assert.equal(calls.removed.length, 1);
  });
});
