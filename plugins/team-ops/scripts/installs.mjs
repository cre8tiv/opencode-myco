// Where myco can be installed, and whether it is installed twice.
//
// OpenCode reads agents and plugins from the user's config directory and from the project's .opencode,
// and loads both. Two copies of the plugin register the same tools under the same id, and OpenCode
// reports a plugin failure. So a project install next to a global one, or the reverse, is a fault,
// and the installer and the doctor both say so.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** @returns {string} OpenCode's user config directory */
export const globalConfig = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');

/** @param {string} dir @returns {boolean} whether dir holds a myco install */
export const hasInstall = (dir) => existsSync(join(dir, 'myco', 'install.json')) || existsSync(join(dir, 'plugins', 'myco'));

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The other places OpenCode would also load myco from, given the install in config and the project being worked in.
 * Empty unless config is itself one of the two places OpenCode loads from.
 * @param {string} config an install's config directory (<config>/myco is its root)
 * @param {string} cwd the project directory
 * @returns {string[]} the other installs' directories
 */
export function otherInstalls(config, cwd) {
  const loaded = [globalConfig(), join(resolve(cwd), '.opencode')];
  // An install somewhere else (a scratch --target, say) is not loaded, so it collides with nothing.
  if (!loaded.some((d) => real(d) === real(config))) return [];
  return loaded.filter((d) => real(d) !== real(config) && hasInstall(d));
}
