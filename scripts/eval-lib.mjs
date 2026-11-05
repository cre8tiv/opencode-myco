// What the eval runner (eval.mjs) decides without a model: reading a case, reading what a run did out of
// OpenCode's session records, and grading it. A case is a directory:
//
//   prompt.md        the prompt, with frontmatter: description, tags, tools (what the run may use), agent (run as this
//                    agent instead of the default one; needed for a lead, which can only be a session's agent), timeout_seconds
//   case.yaml        only when a case needs a scaffold script
//   scaffold.sh      builds the repository the case runs in
//   graders/*.md     one pass/fail check each: tool_used, regex or llm
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** @param {string} text @returns {Record<string, string>} the flat frontmatter of a markdown file */
export function frontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  /** @type {Record<string, string>} */
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^'(.*)'$/, '$1');
  }
  return out;
}

/** @param {string} text @returns {string} what follows the frontmatter */
export const bodyOf = (text) => text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

/** @param {string | undefined} v an inline list, `[a, b]` or `["a", "b"]` @returns {string[]} */
export const list = (v) => (v ? v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []);

/** @param {string} dir @returns {string[]} the directories below dir that hold a case */
export function caseDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (!e.isDirectory() || e.name === 'results') return [];
    const p = join(dir, e.name);
    return existsSync(join(p, 'prompt.md')) ? [p] : caseDirs(p);
  });
}

/**
 * @typedef {{file: string, type: string, text: string, [k: string]: string}} Grader
 * @typedef {{name: string, dir: string, prompt: string, description: string, tags: string[], tools: string[], agent: string | null, timeoutMs: number, scaffold: string | null, graders: Grader[]}} Case
 */

/** @param {string} dir @param {string} root the evals directory, for the case's name @returns {Case} */
export function loadCase(dir, root) {
  const text = readFileSync(join(dir, 'prompt.md'), 'utf8');
  const fm = frontmatter(text);
  const gradersDir = join(dir, 'graders');
  const graders = existsSync(gradersDir)
    ? readdirSync(gradersDir).filter((f) => f.endsWith('.md')).sort().map((f) => {
        const g = readFileSync(join(gradersDir, f), 'utf8');
        return /** @type {Grader} */ ({ file: f, ...frontmatter(g), text: bodyOf(g) });
      })
    : [];
  const yaml = existsSync(join(dir, 'case.yaml')) ? readFileSync(join(dir, 'case.yaml'), 'utf8') : '';
  const script = yaml.match(/scaffold_script:\s*(\S+)/)?.[1];
  return {
    name: relative(root, dir).split('\\').join('/'),
    dir,
    prompt: bodyOf(text),
    description: fm.description || '',
    tags: list(fm.tags),
    tools: list(fm.tools),
    agent: fm.agent || null,
    timeoutMs: (Number(fm.timeout_seconds) || 600) * 1000,
    scaffold: script ? join(dir, script) : null,
    graders,
  };
}

/** The actions a case denies the run unless it lists the tool: shell, file changes and the network. */
const GATED = /** @type {const} */ ([
  ['shell', ['shell']],
  ['edit', ['edit', 'write', 'patch']],
  ['webfetch', ['webfetch']],
  ['websearch', ['websearch']],
]);

/**
 * The permission rules for a run, from the tools its case allows. A case that doesn't list `edit` can't change
 * files; one that doesn't list `shell` can't run commands. Everything else stays at the host's default.
 * @param {string[]} allowed @returns {Record<string, 'deny'>}
 */
export function permissionFor(allowed) {
  const have = new Set(allowed.map((t) => t.toLowerCase()));
  return Object.fromEntries(GATED.filter(([, names]) => !names.some((n) => have.has(n))).map(([action]) => [action, /** @type {const} */ ('deny')]));
}

/**
 * @typedef {{tools: {name: string, input: string}[], text: string, final: string}} Observed
 *   tools: every tool call in the run, by every agent in it (a dispatched agent's too), with its input as JSON;
 *   text: everything the top-level agent said; final: its last message.
 */

/**
 * What a run did, from the records of its sessions.
 * @param {{info?: any, messages: any[]}[]} sessions the run's sessions, the top-level one first
 * @returns {Observed}
 */
export function observe(sessions) {
  /** @type {Observed['tools']} */
  const tools = [];
  /** @type {string[]} */
  const said = [];
  sessions.forEach((s, i) => {
    for (const m of s.messages || []) {
      if (m?.type !== 'assistant') continue;
      const texts = [];
      for (const c of m.content || []) {
        if (c?.type === 'tool') tools.push({ name: String(c.name), input: JSON.stringify(c.state?.input ?? {}) });
        else if (c?.type === 'text' && c.text) texts.push(c.text);
      }
      if (i === 0 && texts.length) said.push(texts.join('\n'));
    }
  });
  return { tools, text: said.join('\n'), final: said.at(-1) || '' };
}

/**
 * Grades one run against one grader.
 * @param {Grader} g @param {Observed} obs
 * @param {(rubric: string, response: string) => Promise<{pass: boolean, reason: string}>} judge for llm graders
 * @returns {Promise<{pass: boolean, reason: string}>}
 */
export async function grade(g, obs, judge) {
  if (g.type === 'tool_used') {
    // `tool` may be an alternation (subagent|delegate); it must match the whole name.
    const name = new RegExp(`^(?:${g.tool})$`);
    const input = g.input_match ? new RegExp(g.input_match) : null;
    const n = obs.tools.filter((t) => name.test(t.name) && (!input || input.test(t.input))).length;
    const min = g.min === undefined ? 1 : Number(g.min);
    const max = g.max === undefined ? Infinity : Number(g.max);
    const pass = n >= min && n <= max;
    return { pass, reason: `${g.tool}${g.input_match ? ` /${g.input_match}/` : ''} used ${n} time(s); wanted ${min}${max === Infinity ? '+' : `-${max}`}` };
  }
  if (g.type === 'regex') {
    const pass = new RegExp(g.pattern, g.flags || '').test(obs.text);
    return { pass, reason: `/${g.pattern}/${g.flags || ''} ${pass ? 'matched' : 'did not match'} what the agent said` };
  }
  if (g.type === 'llm') return judge(g.text, obs.final || obs.text);
  return { pass: false, reason: `grader type "${g.type}" is not supported by this runner` };
}

/** @param {string} reply a judge's reply @returns {{pass: boolean, reason: string}} PASS or FAIL leading it */
export function verdictOf(reply) {
  const m = String(reply).trim().match(/^\W*(PASS|FAIL)\b[\s:.\-–—]*([\s\S]*)/i);
  return m ? { pass: m[1].toUpperCase() === 'PASS', reason: m[2].trim().split('\n')[0].slice(0, 200) } : { pass: false, reason: `the judge did not answer PASS or FAIL: ${String(reply).trim().slice(0, 100)}` };
}
