// The guards, as OpenCode runs them: before every tool call, ask the teams' decision code,
// and block by throwing, which stops the call and hands the
// message back to the agent.
//
// The decisions live with their teams (team-ops/scripts/coach-guard-core.mjs,
// engineering-team/scripts/merge-gate-core.mjs) and are loaded from the install, so a
// team that isn't installed simply has no guard. Nothing here may stop legitimate work
// because the guard itself broke: failing to load a core, or any error while judging a
// call, lets the call through.
import { isTeamAgent, loadCore, projectDirectory } from './core.js';

/** Where the merge gate looks for the project profile (see core.js). */
export const profileDirectory = projectDirectory;

export { isTeamAgent };

/**
 * Registers the guards on a plugin context.
 * @param {any} ctx the OpenCode plugin context @param {string} root the install root (<config>/myco)
 * @param {{onBlock?: (event: any, message: string) => void}} [opts] onBlock hears of each call the guards stop, for the record
 * @returns {Promise<{coach: boolean, merge: boolean}>} which guards loaded
 */
export async function registerGuards(ctx, root, { onBlock } = {}) {
  const coach = await loadCore(root, 'team-ops', 'coach-guard-core.mjs');
  const merge = await loadCore(root, 'engineering-team', 'merge-gate-core.mjs');

  await ctx.tool.hook('execute.before', (event) => {
    /** @type {string | null} */
    let message = null;
    try {
      const call = { agent: event.agent, tool: event.tool, input: event.input };
      const offending = coach?.coachViolation(call);
      if (offending) message = coach.coachMessage(offending);
      else if (isTeamAgent(event.agent)) message = merge?.mergeVerdict({ ...call, cwd: projectDirectory(ctx) }) ?? null;
    } catch {
      // A broken guard must never block legitimate work.
    }
    if (message) {
      try {
        onBlock?.(event, message);
      } catch {
        // Recording a block must not change it.
      }
      throw new Error(message);
    }
  });

  return { coach: !!coach, merge: !!merge };
}
