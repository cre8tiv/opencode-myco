// The one OpenCode plugin for every myco team. It installs at <config>/plugins/myco/,
// next to the team assets at <config>/myco/, so the root is two directories up.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'myco');

export default {
  id: 'myco',
  async setup(ctx) {
    // Agents and skills run scripts as $MYCO_ROOT/<team>/scripts/..., the OpenCode
    // counterpart of Claude Code's ${CLAUDE_PLUGIN_ROOT}. A command that prints this
    // variable is also how to tell the plugin loaded.
    await ctx.shell.hook('create.before', (event) => {
      event.env = { ...event.env, MYCO_ROOT: ROOT };
    });
  },
};
