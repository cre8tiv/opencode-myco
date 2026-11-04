// The event stream, as OpenCode feeds it. Claude Code pushed team activity to a hook script;
// OpenCode hands the plugin the same facts through its tool hooks and session hooks, already
// knowing the agent and the session, so nothing is worked out from transcripts.
//
// What is recorded, under the event names the coach and the stream's consumers already use:
//
//   PostToolUseFailure  a team agent's tool call failed (execute.after, status error)
//   PermissionDenied    a team agent's call was refused: by a permission rule (execute.after with
//                       Permission.BlockedError; OpenCode does not run its permission hook for a
//                       configured deny) or by one of the guards (recordBlock)
//   SubagentStart/Stop  a team agent was dispatched, and returned its report (the subagent tool, or delegate)
//   PreCompact          a team agent's context is being compacted
//   StopFailure         a team agent's run ended on an error, such as a provider timeout (session.execution.failed)
//   SessionEnd          a team lead's run ended (session.execution.succeeded). OpenCode sessions do not end, each
//                       prompt's run does; a dispatched agent's run is its SubagentStop, so only top-level sessions
//
// Events reach every plugin instance (one per location) and several carry no location, so an instance
// treats as its own only the sessions it has served, which its context hook reveals along with the agent.
//
// Only team agents (named team/role) are recorded. The plugin runs in every session in the
// project, and a human's own session or an ad-hoc agent is not team activity: its events would
// skew the coach's numbers.
//
// Telemetry is never worth breaking a run over: nothing here waits on a write, and nothing
// here throws.
import { isTeamAgent, loadCore, projectDirectory } from './core.js';
import { createWorkTracker } from './work.js';

/**
 * What went wrong, as text: an error's message, else the error itself as JSON, else nothing. Never the
 * literal "undefined" or "[object Object]", which is what String() would write.
 * @param {any} err @returns {string | undefined}
 */
const errorText = (err) => {
  if (err === undefined || err === null) return undefined;
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return undefined;
  }
};

/** "[CLOUD-123] implement retry" names the work an agent's task belongs to. */
/** The tools that dispatch an agent: OpenCode's own, and the plugin's, which can also give it a worktree. */
const DISPATCH = new Set(['subagent', 'delegate']);

const bracketTag = (description) => (String(description || '').match(/^\s*\[([^\]\s]+)\]/) || [])[1] || null;

/**
 * Registers the capture hooks on a plugin context.
 * @param {any} ctx the OpenCode plugin context @param {string} root the install root (<config>/myco)
 * @param {ReturnType<typeof createWorkTracker>} [work] the work each session named
 * @returns {Promise<{recorded: boolean, recordBlock: (event: any, message: string) => void, dispose: () => void}>}
 *   recorded: whether the event stream is available; recordBlock: for the guards to report what they stop;
 *   dispose: stops listening, for the host's cleanup
 */
export async function registerCapture(ctx, root, work = createWorkTracker(ctx)) {
  const core = await loadCore(root, 'team-ops', 'capture-core.mjs');

  /** @type {Map<string, {agent?: string, parentID?: string, work?: string}>} the sessions this instance serves */
  const sessions = new Map();
  /** The work a session is on: what it named itself, else what it inherited when it was dispatched. */
  const workFor = (id) => work.peek(id) || sessions.get(id)?.work;
  /** The work of the lead that dispatched a session, when there is one. */
  const parentOf = (id) => sessions.get(id)?.parentID || work.parentOf(id);
  const parentWorkFor = (id) => {
    const parent = parentOf(id);
    return parent ? workFor(parent) : undefined;
  };

  /** Writes a record without waiting for it and without ever failing the caller. */
  const emit = (p) => {
    if (!core) return;
    Promise.resolve()
      .then(() => core.recordEvent({ cwd: projectDirectory(ctx), ...p }))
      .catch(() => {});
  };

  await ctx.tool.hook('execute.before', (e) => {
    try {
      if (!DISPATCH.has(e.tool) || !isTeamAgent(e.input?.agent)) return;
      const parent = workFor(e.sessionID);
      emit({
        event: 'SubagentStart',
        agent: e.input.agent,
        session: e.sessionID,
        work: bracketTag(e.input.description) || parent,
        parentWork: parent,
        task: e.input.description,
      });
    } catch {
      // See the header.
    }
  });

  await ctx.tool.hook('execute.after', (e) => {
    try {
      const parent = workFor(e.sessionID);
      if (DISPATCH.has(e.tool)) {
        const child = e.input?.agent;
        if (isTeamAgent(child)) {
          emit({
            event: 'SubagentStop',
            agent: child,
            agentId: e.result?.output?.sessionID,
            session: e.sessionID,
            work: bracketTag(e.input.description) || parent,
            parentWork: parent,
            report: e.result?.output?.output,
            task: e.input.description,
            error: e.status === 'completed' ? undefined : errorText(e.error),
          });
        }
        return;
      }
      if (e.status === 'completed' || !isTeamAgent(e.agent)) return;
      // The host wraps the cause: a tool error whose own error is the Permission.BlockedError.
      const denied = e.error?.error?._tag === 'Permission.BlockedError' || e.error?._tag === 'Permission.BlockedError';
      emit({
        event: denied ? 'PermissionDenied' : 'PostToolUseFailure',
        agent: e.agent,
        session: e.sessionID,
        work: parent,
        parentWork: parentWorkFor(e.sessionID),
        tool: e.tool,
        input: e.input,
        error: denied ? undefined : errorText(e.error),
        reason: denied ? [e.error?.message, e.error?.error?.rules && JSON.stringify(e.error.error.rules)].filter(Boolean).join('; ') : undefined,
      });
    } catch {
      // See the header.
    }
  });

  try {
    await ctx.session.hook('compaction', (e) => {
      try {
        if (!isTeamAgent(e.agent)) return;
        emit({ event: 'PreCompact', agent: e.agent, session: e.sessionID, work: workFor(e.sessionID), parentWork: parentWorkFor(e.sessionID) });
      } catch {
        // See the header.
      }
    });
  } catch {
    // A host without the compaction hook just has no PreCompact records.
  }

  // Which sessions this instance serves, and as which agent: its context hook runs for each model request.
  try {
    await ctx.session.hook('context', (e) => {
      try {
        if (!e?.sessionID || !e.agent) return;
        sessions.set(e.sessionID, { ...sessions.get(e.sessionID), agent: e.agent });
      } catch {
        // See the header.
      }
    });
  } catch {
    // Without it only the tool and compaction records have an agent to name.
  }

  const controller = new AbortController();
  /** @param {{type?: string, data?: any}} ev */
  const onEvent = (ev) => {
    const d = ev?.data;
    if (!d?.sessionID) return;
    if (ev.type === 'session.created') {
      // A dispatched agent's session names its parent and, as its title, the task it was given,
      // so it can start on the work its lead was on, or the [TAG] the task begins with. An agent
      // delegate gave its own worktree has no parent (the host would have put it back in the lead's
      // checkout); delegate links it by metadata. It runs in the worktree's plugin instance, which has
      // not seen the lead, so the link is read from here, and its work is the [TAG] of its task.
      const parent = d.parentID || d.metadata?.mycoParent;
      if (!parent || d.location?.directory !== ctx.location?.directory) return;
      sessions.set(d.sessionID, { ...sessions.get(d.sessionID), agent: d.agent, parentID: parent, work: bracketTag(d.title) || workFor(parent) });
      return;
    }
    const mine = sessions.get(d.sessionID);
    if (!mine?.agent || !isTeamAgent(mine.agent)) return;
    if (ev.type === 'session.execution.failed') {
      emit({ event: 'StopFailure', agent: mine.agent, session: d.sessionID, work: workFor(d.sessionID), parentWork: parentWorkFor(d.sessionID), error: errorText(d.error) });
    } else if (ev.type === 'session.execution.succeeded' && !parentOf(d.sessionID)) {
      emit({ event: 'SessionEnd', agent: mine.agent, session: d.sessionID, work: workFor(d.sessionID) });
    }
  };
  try {
    const events = ctx.event?.subscribe?.({ signal: controller.signal });
    if (events) {
      (async () => {
        try {
          for await (const ev of events) {
            // Events can still be in flight when the plugin is torn down.
            if (controller.signal.aborted) break;
            try {
              onEvent(ev);
            } catch {
              // See the header.
            }
          }
        } catch {
          // The stream ending, or the host going away, is not an error.
        }
      })();
    }
  } catch {
    // A host without an event stream has no StopFailure or SessionEnd records.
  }

  return {
    recorded: !!core,
    dispose: () => controller.abort(),
    /** A call one of the guards stopped never reaches execute.after, so the guards say so here. */
    recordBlock(event, message) {
      try {
        if (!isTeamAgent(event?.agent)) return;
        emit({ event: 'PermissionDenied', agent: event.agent, session: event.sessionID, work: workFor(event.sessionID), parentWork: parentWorkFor(event.sessionID), tool: event.tool, input: event.input, reason: message });
      } catch {
        // See the header.
      }
    },
  };
}
