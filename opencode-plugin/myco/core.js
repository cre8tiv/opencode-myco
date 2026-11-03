// What the plugin's parts share: loading a team's decision code from the install, and
// where the project is.
import { join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads a core module from the install, or null when it isn't there (the team isn't
 * installed) or doesn't load. A missing core means a missing feature, never a broken plugin.
 * @param {string} root the install root @param {string} team @param {string} file @returns {Promise<any | null>}
 */
export async function loadCore(root, team, file) {
  try {
    return await import(pathToFileURL(join(root, team, 'scripts', file)).href);
  } catch {
    return null;
  }
}

/**
 * Where the project is: its profile (merge_policy, trunk_branch, stream) and its event stream
 * are found from here. OpenCode creates one plugin instance per location, and a session located
 * in a worktree gets its own, so the instance's location is the directory of the sessions whose
 * calls it sees (checked against OpenCode in test/opencode.test.mjs). It is deliberately not
 * taken from a tool call: a shell command's workdir is the agent's to choose, and a policy read
 * from wherever it points could be another project's. If the host gives no directory, look
 * nowhere, which resolves to the gated default, rather than wherever the server process happens
 * to be running.
 * @param {any} ctx @returns {string}
 */
export function projectDirectory(ctx) {
  const dir = ctx?.location?.directory;
  return typeof dir === 'string' && dir ? dir : parse(process.cwd()).root;
}
