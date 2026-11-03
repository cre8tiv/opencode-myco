// The tools the teams call, as OpenCode tools. In Claude Code these were a skill whose
// call was itself the record (start-work) and a script the agent ran (friction.mjs). An
// OpenCode tool is handed the real session and agent by the host, which a shell command
// is not, so both are tools: nothing is inferred from transcripts or smuggled through the
// environment.
//
// Telemetry never blocks delivery: a tool that cannot do its job says so in its result and
// does not throw.
import { loadCore, projectDirectory } from './core.js';

/** What an agent can say cost it time (team-ops/scripts/friction-core.mjs). */
const KINDS = ['instructions', 'tooling', 'permissions', 'scope', 'environment', 'handoff'];
/** A work tag is one word, so it can lead a task description as "[TAG]". */
const TAG = /^\S+$/;

/** @param {string} content a tool's result */
const reply = (content) => ({ content });

/**
 * Registers start_work and log_friction on a plugin context.
 * @param {any} ctx the OpenCode plugin context @param {string} root the install root (<config>/myco)
 * @returns {Promise<{friction: boolean}>} whether friction logging is available
 */
export async function registerTools(ctx, root) {
  const friction = await loadCore(root, 'team-ops', 'friction-core.mjs');
  /** @type {Map<string, string>} the work each session named, by session */
  const work = new Map();

  /** @param {string | undefined} sessionID @returns {Promise<string | undefined>} */
  async function currentWork(sessionID) {
    if (!sessionID) return undefined;
    if (work.has(sessionID)) return work.get(sessionID);
    try {
      const saved = await ctx.storage?.get?.(`work/${sessionID}`);
      if (typeof saved === 'string' && saved) {
        work.set(sessionID, saved);
        return saved;
      }
    } catch {
      // Storage is a convenience across restarts; the in-memory tag is authoritative.
    }
    return undefined;
  }

  await ctx.tool.transform((editor) => {
    editor.add({
      name: 'start_work',
      description:
        'Name the unit of work you are on, so what this session spends can be attributed to it and reported later. ' +
        'Design: <package-slug>/round-<n>, such as order-exceptions/round-2. Engineering: <package-slug>/phase-<n>, or the ticket key or epic, such as CLOUD-123. ' +
        'Call it when you start or resume work and whenever the work changes. Team leads call it; carry on without mentioning it to the human unless asked.',
      options: { codemode: false },
      input: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'One tag with no spaces.' },
          note: { type: 'string', description: 'Optional: anything else worth recording about this work.' },
        },
        required: ['tag'],
        additionalProperties: false,
      },
      async execute(input, context) {
        const tag = typeof input?.tag === 'string' ? input.tag.trim() : '';
        if (!TAG.test(tag)) return reply('start_work needs one tag with no spaces, such as order-exceptions/round-2 or CLOUD-123. Put anything else in note.');
        const sessionID = context?.sessionID;
        if (!sessionID) return reply('start_work could not tell which session this is, so nothing was recorded. Carry on.');
        work.set(sessionID, tag);
        try {
          await ctx.storage?.set?.(`work/${sessionID}`, tag);
        } catch {
          // See currentWork.
        }
        return reply(`Work is now ${tag}.`);
      },
    });

    editor.add({
      name: 'log_friction',
      description:
        'Record process friction you hit: your own instructions were unclear or silent, a tool you needed was missing or broken, a task arrived too vague to scope, ' +
        'or a handoff lost information. Not for ordinary product bugs. Call it once per incident, then carry on; do not stop work to log. ' +
        'agent-coach reads these across runs, and you are the only witness to your own instructions being ambiguous.',
      options: { codemode: false },
      input: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: KINDS,
            description:
              'instructions: your definition was wrong, unclear or silent. tooling: a tool was missing, broken or unavailable. permissions: you were blocked by a permission or allowlist. ' +
              'scope: the task was too big or vague. environment: build, infrastructure, credentials or a service was not running. handoff: information was lost or contradicted between agents or teams.',
          },
          note: {
            type: 'string',
            description: 'What cost you time, in one sentence a reader next month can follow without your context: the step, what was missing or unclear, and what you did instead.',
          },
          work: { type: 'string', description: 'Only when this is about different work than you are on, such as a design problem found while building: the ticket key or package slug it belongs to.' },
        },
        required: ['kind', 'note'],
        additionalProperties: false,
      },
      async execute(input, context) {
        if (!friction) return reply('Friction logging is not installed (team-ops is missing), so nothing was recorded. Mention it in your report and carry on.');
        if (!KINDS.includes(input?.kind)) return reply(`kind must be one of ${KINDS.join(', ')}.`);
        const note = typeof input?.note === 'string' ? input.note.trim() : '';
        if (!note) return reply('log_friction needs a note: one sentence on what cost you time.');
        try {
          const sessionID = context?.sessionID;
          await friction.recordFriction({
            cwd: projectDirectory(ctx),
            agent: context?.agent || 'unknown',
            session: sessionID,
            work: (typeof input.work === 'string' && input.work.trim()) || (await currentWork(sessionID)),
            kind: input.kind,
            note,
          });
          return reply('friction logged');
        } catch (e) {
          return reply(`The friction report could not be written (${e?.message || e}). Mention it in your report and carry on.`);
        }
      },
    });
  });

  return { friction: !!friction };
}
