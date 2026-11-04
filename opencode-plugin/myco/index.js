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
    // The parts of the plugin that came up. A core that fails to load leaves its feature out and
    // OpenCode says nothing, so what is missing would otherwise be invisible: this is what
    // `myco doctor` reads.
    const features = [];
    // The installer writes the real install path into agent and skill text, so nothing depends
    // on MYCO_ROOT; it is there for commands people run themselves. A command that prints it and
    // MYCO_FEATURES is how to tell the plugin loaded, and what it loaded.
    await ctx.shell.hook('create.before', (event) => {
      event.env = { ...event.env, MYCO_ROOT: ROOT, MYCO_FEATURES: features.join(',') };
    });
    // The work each session names, shared by what sets it and what reads it.
    const work = createWorkTracker(ctx);
    const capture = await registerCapture(ctx, ROOT, work);
    if (capture.recorded) features.push('capture');
    const guards = await registerGuards(ctx, ROOT, { onBlock: capture.recordBlock });
    if (guards.coach) features.push('coach-guard');
    if (guards.merge) features.push('merge-gate');
    const tools = await registerTools(ctx, ROOT, work);
    features.push('start_work');
    if (tools.friction) features.push('log_friction');
    // The host calls what setup returns when the plugin is torn down.
    return () => capture.dispose();
  },
};
