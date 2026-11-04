// The work each session named with start_work, shared by what records it (tools.js) and
// what reads it (capture.js, and friction reports). It lives in memory for the life of the
// plugin instance and, best effort, in the host's storage so it survives a restart.

/**
 * @param {any} ctx the OpenCode plugin context
 * @returns {{parentOf: (id?: string) => string | undefined, link: (id: string, parentID: string | undefined, tag?: string | null) => Promise<void>, peek: (id?: string) => string | undefined, current: (id?: string) => Promise<string | undefined>, set: (id: string, tag: string) => Promise<void>}}
 */
export function createWorkTracker(ctx) {
  /** @type {Map<string, string>} */
  const work = new Map();
  /** @type {Map<string, string>} dispatched session -> the session that dispatched it, for children the host does not link */
  const parents = new Map();
  return {
    /** The session that dispatched this one with delegate, when the host does not record it (an isolated child). */
    parentOf: (id) => (id ? parents.get(id) : undefined),

    /** Records that a session was dispatched by another, and the work it starts on. */
    async link(id, parentID, tag) {
      if (parentID) parents.set(id, parentID);
      if (tag) await this.set(id, tag);
    },

    /** The tag in memory, now. For hooks, which must not wait. */
    peek: (id) => (id ? work.get(id) : undefined),

    /** The tag in memory, else the one saved before a restart. */
    async current(id) {
      if (!id) return undefined;
      if (work.has(id)) return work.get(id);
      try {
        const saved = await ctx.storage?.get?.(`work/${id}`);
        if (typeof saved === 'string' && saved) {
          work.set(id, saved);
          return saved;
        }
      } catch {
        // Storage is a convenience across restarts; the in-memory tag is authoritative.
      }
      return undefined;
    },

    async set(id, tag) {
      work.set(id, tag);
      try {
        await ctx.storage?.set?.(`work/${id}`, tag);
      } catch {
        // See current.
      }
    },
  };
}
