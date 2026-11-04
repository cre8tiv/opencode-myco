// The delegate tool: how a team lead hands work to an agent, and the only way an agent gets its own
// worktree. OpenCode's own `subagent` tool takes {agent, description, prompt} and nothing else, so it
// cannot place the agent anywhere but the lead's checkout. `subagent` keeps working; this is the
// tool the leads are told to use (and does what it does, with the same records).
//
// What it does, checked against OpenCode (see the notes in test/delegate-opencode.test.mjs):
//
// - Creates a session for the agent. A child created with a parentID inherits the parent's location
//   and ignores the one it is given, so an isolated child is created WITHOUT a parentID, and is
//   linked to its lead by session metadata (and by the lead's own tool call, which names the child).
//   A child that shares the lead's checkout keeps the native parentID.
// - Isolation: a git worktree for the child, and a session permission that denies edits to the lead's
//   checkout, so a child that wanders into it by absolute path is refused by the host. Shell
//   redirects are not covered by that rule.
// - Sends the task, waits for the run to end, and returns the agent's final text, the session (to
//   resume it with its context, by passing it back as sessionID) and, when isolated, the worktree.
// - Ends the child if the lead's call is aborted. An isolated worktree with no changes is removed
//   afterwards; one with changes stays, and is reported, because it is the work.
//
// A failure is thrown, so the lead sees a failed tool call that names the session, not an empty report.
import { execFileSync } from 'node:child_process';
import { isTeamAgent } from './core.js';

/** "[CLOUD-123] implement retry" names the work an agent's task belongs to. */
const bracketTag = (description) => (String(description || '').match(/^\s*\[([^\]\s]+)\]/) || [])[1] || null;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The agent's final words in a session's messages. */
export function finalText(messages) {
  const list = Array.isArray(messages) ? messages : messages?.data || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type !== 'assistant') continue;
    const text = (list[i].content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

/** What went wrong in a session's last response, if it says. */
const lastError = (messages) => {
  const list = (Array.isArray(messages) ? messages : messages?.data || []).filter((m) => m?.type === 'assistant');
  const e = list.at(-1)?.error;
  return typeof e === 'string' ? e : e?.message || (e ? JSON.stringify(e) : '');
};

/** The branch and starting commit of a worktree, so "no changes" can be told from "nothing committed yet". */
const baseOf = (dir) => {
  try {
    return git(dir, 'rev-parse', 'HEAD');
  } catch {
    return undefined;
  }
};

/**
 * True when an isolated worktree holds nothing worth keeping: no uncommitted changes, and either no new commits or a
 * detached HEAD at a commit some branch already has (a reviewer that checked out the commit it was reviewing).
 */
function untouched(dir, base) {
  try {
    if (git(dir, 'status', '--porcelain') || base === undefined) return false;
    const head = git(dir, 'rev-parse', 'HEAD');
    if (head === base) return true;
    let detached = false;
    try {
      git(dir, 'symbolic-ref', '-q', 'HEAD');
    } catch {
      detached = true; // symbolic-ref fails when HEAD is not on a branch
    }
    return detached && git(dir, 'for-each-ref', '--contains', head, 'refs/heads').length > 0;
  } catch {
    return false;
  }
}

/**
 * Registers delegate on a plugin context.
 * @param {any} ctx the OpenCode plugin context
 * @param {ReturnType<typeof import('./work.js').createWorkTracker>} work shared with capture, so a dispatched agent's records carry its work
 * @returns {Promise<void>}
 */
export async function registerDelegate(ctx, work) {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: 'delegate',
      description:
        'Hand a task to a team agent and wait for its report. Use this, not the subagent tool, to dispatch team agents. ' +
        'agent: the agent to run, as team/role. description: the task in one line; start it with the ticket or work tag in brackets, such as "[CLOUD-123] implement retry". ' +
        'prompt: everything the agent needs, since it has none of your context. ' +
        'isolated: true gives the agent its own git worktree, so parallel agents cannot collide in the checkout; set it for agents that change files. branch: with isolated, the new branch to start the worktree on. ' +
        'sessionID: pass a session this tool returned to continue that agent with its context, instead of starting a new one. ' +
        'The result names the agent\'s session and, when isolated, its worktree and branch; a worktree with changes is kept for you to review and merge.',
      options: { codemode: false },
      input: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The agent to run, as team/role.' },
          description: { type: 'string', description: 'The task in one line, led by "[TAG]".' },
          prompt: { type: 'string', description: 'The full task for the agent.' },
          sessionID: { type: 'string', description: 'Continue this session instead of starting a new one.' },
          isolated: { type: 'boolean', description: 'Run the agent in its own git worktree.' },
          branch: { type: 'string', description: 'With isolated: create and switch to this branch in the worktree.' },
        },
        required: ['agent', 'description', 'prompt'],
        additionalProperties: false,
      },
      // The host refuses a result that carries `output` when the tool declares no output schema, and does so as a
      // defect after the agent has already run: the work is done and the lead never hears of it. Keep this in step
      // with what execute returns (delegate-opencode.test.mjs checks it).
      output: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          status: { type: 'string' },
          output: { type: 'string', description: "The agent's final report." },
          worktree: { type: 'string', description: 'Where the isolated agent worked, when it changed anything.' },
          branch: { type: 'string' },
          worktreeRemoved: { type: 'boolean' },
        },
        required: ['sessionID', 'status', 'output'],
        additionalProperties: false,
      },
      async execute(input, context) {
        const fail = (message) => {
          throw new Error(message);
        };
        if (!isTeamAgent(input?.agent)) fail(`delegate runs team agents, named team/role (such as engineering-team/ic-generalist); "${input?.agent}" is not one.`);
        if (typeof input.prompt !== 'string' || !input.prompt.trim()) fail('delegate needs a prompt: the task, with everything the agent needs.');
        if (input.sessionID && input.isolated) fail('A session being continued keeps the worktree it started in; do not pass isolated with sessionID.');
        const parentID = context?.sessionID;
        const description = String(input.description || '').trim() || input.agent;

        let sessionID = input.sessionID;
        let directory = ctx.location?.directory;
        let worktree;
        let base;
        /** What cleanup needs to know about the worktree: where it is, where it started, and the branch delegate made in it. */
        const iso = { ctx, dir: undefined, base: undefined, branch: undefined };
        // Whatever goes wrong after the worktree exists, an untouched one is not left behind.
        try {
          if (!sessionID) {
            if (input.isolated) {
              const projectID = ctx.location?.project?.id;
              if (!projectID) fail('Cannot create a worktree: the host did not say which project this is.');
              const made = await ctx.worktree.create({ projectID, name: `${input.agent.replace('/', '-')}-${Date.now().toString(36)}` });
              worktree = made?.directory || made?.data?.directory;
              if (!worktree) fail('The host created a worktree but did not say where.');
              directory = worktree;
              base = baseOf(worktree);
              iso.dir = worktree;
              iso.base = base;
              if (input.branch) {
                try {
                  git(worktree, 'switch', '-c', input.branch);
                  iso.branch = input.branch;
                } catch (e) {
                  await removeIfUntouched(iso);
                  fail(`Could not start branch ${input.branch} in the worktree: ${String(e?.stderr || e?.message || e).trim()}`);
                }
              }
            }
            // Isolated: no parentID (it would put the child back in the lead's checkout); linked by metadata.
            const link = input.isolated ? { metadata: { mycoParent: parentID } } : { parentID };
            const permissions = input.isolated ? [{ action: 'edit', resource: `${ctx.location.directory}/**`, effect: 'deny' }] : undefined;
            const created = await ctx.session.create({ title: description, agent: input.agent, ...link, location: { directory }, ...(permissions ? { permissions } : {}) });
            sessionID = created?.id || created?.data?.id;
            if (!sessionID) fail('The host created the session but did not say which.');
            // The agent's records carry the work its task is for, else the work its lead was on.
            await work.link(sessionID, parentID, bracketTag(description) || (await work.current(parentID)));
          }

          const stop = () => {
            Promise.resolve(ctx.session.interrupt?.({ sessionID })).catch(() => {});
          };
          context?.signal?.addEventListener?.('abort', stop, { once: true });
          let messages;
          let session;
          try {
            await ctx.session.prompt({ sessionID, text: input.prompt });
            await ctx.session.wait({ sessionID });
            messages = await ctx.session.context({ sessionID });
            session = await ctx.session.get?.({ sessionID });
          } finally {
            context?.signal?.removeEventListener?.('abort', stop);
          }
          const outcome = (session?.data || session)?.outcome;
          const failedRun = context?.signal?.aborted || outcome === 'interrupted' || outcome === 'failed';
          // A run that ended badly keeps its worktree if it changed anything: that is partial work to look at.
          const gone = worktree && failedRun && (await removeIfUntouched(iso));
          const where = worktree ? (gone ? ' Its worktree was removed: nothing had changed.' : ` Its worktree is ${worktree}.`) : '';
          if (context?.signal?.aborted || outcome === 'interrupted') {
            stop();
            fail(`Agent cancelled (sessionID: ${sessionID}).${where}`);
          }
          if (outcome === 'failed') fail(`Agent failed (sessionID: ${sessionID}): ${lastError(messages) || 'no reason given'}.${where}`);

          const report = finalText(messages) || '(the agent finished without a report)';
          const kept = worktree ? !(await removeIfUntouched(iso)) : false;
          // No undefined values: the output is encoded against the schema above.
        const out = { sessionID, status: 'completed', output: report, ...(worktree ? { ...(kept ? { worktree, ...(input.branch ? { branch: input.branch } : {}) } : {}), worktreeRemoved: !kept } : {}) };
          const note = worktree ? (kept ? `\nworktree: ${worktree}${input.branch ? `\nbranch: ${input.branch}` : ''}` : '\nThe agent changed nothing, so its worktree was removed.') : '';
          return {
            output: out,
            content: `<delegate sessionID="${sessionID}" state="completed">\n${report}\n</delegate>${note}`,
            metadata: { sessionID, status: 'completed' },
          };
        } catch (e) {
          if (iso.dir) await removeIfUntouched(iso);
          throw e;
        }
      },
    });
  });
}

/**
 * Removes an isolated worktree that holds nothing, and the branch delegate made in it.
 * @param {{ctx: any, dir?: string, base?: string, branch?: string}} iso
 * @returns {Promise<boolean>} whether it was removed
 */
async function removeIfUntouched({ ctx, dir, base, branch }) {
  if (!dir || !untouched(dir, base)) return false;
  try {
    await ctx.worktree.remove({ projectID: ctx.location.project.id, directory: dir, force: false });
  } catch {
    return false;
  }
  if (branch) {
    try {
      git(ctx.location.directory, 'branch', '-D', branch);
    } catch {
      // The branch is gone already, or was never there.
    }
  }
  return true;
}
