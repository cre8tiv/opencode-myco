// The one OpenCode plugin for every myco team. It installs at <config>/plugins/myco/,
// next to the team assets at <config>/myco/, so the root is two directories up.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerGuards } from './guards.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'myco');

export default {
  id: 'myco',
  async setup(ctx) {
    // The installer writes the real install path into agent and skill text, so nothing
    // depends on this variable; it is there for commands people run themselves, and a
    // command that prints it is how to tell the plugin loaded.
    await ctx.shell.hook('create.before', (event) => {
      event.env = { ...event.env, MYCO_ROOT: ROOT };
    });
    await registerGuards(ctx, ROOT);
  },
};
