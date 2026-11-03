// The guards, as OpenCode runs them: before every tool call, ask the same decision code
// the Claude Code hooks use, and block by throwing, which stops the call and hands the
// message back to the agent.
//
// The decisions live with their teams (team-ops/scripts/coach-guard-core.mjs,
// engineering-team/scripts/merge-gate-core.mjs) and are loaded from the install, so a
// team that isn't installed simply has no guard. Nothing here may stop legitimate work
// because the guard itself broke: failing to load a core, or any error while judging a
// call, lets the call through.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A team agent is installed as team/role. Every OpenCode session has an agent (a human's is "build"), so plain names are not the teams'. */
export const isTeamAgent = (name) => typeof name === 'string' && name.includes('/');

/** @param {string} root the install root @param {string} team @param {string} file @returns {Promise<any | null>} */
async function loadCore(root, team, file) {
  try {
    return await import(pathToFileURL(join(root, team, 'scripts', file)).href);
  } catch {
    return null;
  }
}

/**
 * Registers the guards on a plugin context.
 * @param {any} ctx the OpenCode plugin context @param {string} root the install root (<config>/myco)
 * @returns {Promise<{coach: boolean, merge: boolean}>} which guards loaded
 */
export async function registerGuards(ctx, root) {
  const coach = await loadCore(root, 'team-ops', 'coach-guard-core.mjs');
  const merge = await loadCore(root, 'engineering-team', 'merge-gate-core.mjs');

  await ctx.tool.hook('execute.before', (event) => {
    /** @type {string | null} */
    let message = null;
    try {
      const call = { agent: event.agent, tool: event.tool, input: event.input };
      const offending = coach?.coachViolation(call);
      if (offending) message = coach.coachMessage(offending);
      else if (isTeamAgent(event.agent)) message = merge?.mergeVerdict({ ...call, cwd: ctx.location?.directory }) ?? null;
    } catch {
      // A broken guard must never block legitimate work.
    }
    if (message) throw new Error(message);
  });

  return { coach: !!coach, merge: !!merge };
}
