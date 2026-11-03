// The one OpenCode plugin for every myco team. It installs at <config>/plugins/myco/,
// next to the team assets at <config>/myco/, so the root is two directories up.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCapture } from './capture.js';
import { registerGuards } from './guards.js';
import { registerTools } from './tools.js';
import { createWorkTracker } from './work.js';

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
    // The work each session names, shared by what sets it and what reads it.
    const work = createWorkTracker(ctx);
    const capture = await registerCapture(ctx, ROOT, work);
    await registerGuards(ctx, ROOT, { onBlock: capture.recordBlock });
    await registerTools(ctx, ROOT, work);
    // The host calls what setup returns when the plugin is torn down.
    return () => capture.dispose();
  },
};
