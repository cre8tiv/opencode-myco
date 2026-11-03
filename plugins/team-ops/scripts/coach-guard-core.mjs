// The decision behind agent-coach's propose-only mandate, free of any host: given the
// agent and the tool call it is about to make, which write (if any) is not allowed.
//
// Allowlist: the coach may write into .claude/ops/reports/ and scratch locations,
// and nothing else. It reads everything — agent definitions, transcripts, git
// history, team profiles — and argues for changes in a report a human applies.
//
// File tools are judged by their target path. Shell tools are judged by what each
// command writes to: its redirect targets, and the path arguments of commands that
// modify files. A path that merely appears elsewhere on the line doesn't make a write
// acceptable. This is a guard against accidents, not a sandbox: a script that writes
// files from inside an interpreter (`node -e`, `python -c`) isn't inspected.
//
// Two hosts call it: coach-guard.mjs (Claude Code hooks) and the OpenCode plugin. They
// name tools and fields differently, so both spellings are understood here. Team agents
// arrive namespaced ("team-ops:agent-coach" in Claude Code, "team-ops/agent-coach" in
// OpenCode), so the role is matched after the last separator; a bare name matches too.
import { posix } from 'node:path';


const ALLOWED = [/(^|\/)\.claude\/ops\/reports(\/|$)/i, /(^|\/)(tmp|temp)(\/|$)/i, /\/scratchpad(\/|$)/i];

/** Places a redirect may point at without writing a file. */
const SINKS = new Set(['/dev/null', '$null', 'nul']);

// Claude Code's tool names, then OpenCode's.
const FILE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'write', 'edit', 'patch'];
const SHELL_TOOLS = ['Bash', 'PowerShell', 'shell', 'bash'];

/** Commands that modify files, including PowerShell cmdlets and their aliases. */
const MUTATING = new Set([
  'cp', 'mv', 'rm', 'tee', 'dd', 'truncate', 'touch', 'mkdir', 'rmdir', 'ln', 'install',
  'copy', 'move', 'del', 'erase', 'ren', 'rd', 'md',
  'set-content', 'add-content', 'clear-content', 'out-file', 'copy-item', 'move-item',
  'remove-item', 'new-item', 'rename-item', 'set-item', 'sc', 'ac', 'cpi', 'mi', 'ri',
  'ni', 'rni',
]);

/** Shells whose -c / -Command argument is itself a command line to inspect. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd']);

/**
 * Commands that run another command: judge what they run. Plugins that rewrite or shrink command
 * output put the real command behind one before this guard sees it, as "rtk rm -rf x".
 */
const WRAPPERS = new Set(['rtk', 'env', 'time', 'command', 'nohup', 'exec', 'builtin', 'stdbuf']);

/** How many wrappers or nested shells to look through. */
const MAX_DEPTH = 4;

/** PowerShell parameters whose value is content or a setting, not a path. */
const NON_PATH_PARAMS = new Set(['-encoding', '-value', '-itemtype', '-filter', '-include', '-exclude', '-width']);

/** @param {string} p @returns {string} forward-slashed and normalized, so `a/../b` can't hide a target */
const normalize = (p) => posix.normalize(p.split('\\').join('/'));

/** @param {string} p @returns {boolean} whether the coach may write to this path */
export const allowed = (p) => ALLOWED.some((re) => re.test(normalize(p)));

/** Looks like a path rather than a value: has a separator, an extension, or is home/variable-relative. */
const pathLike = (t) => /[\\/]/.test(t) || /\.[A-Za-z0-9]+$/.test(t) || /^[~$]/.test(t);

/**
 * Splits a command line into words, command separators and redirects, honoring quotes.
 * The same rules serve Bash and PowerShell: both quote with ' and ", chain with ; && ||
 * and |, and redirect with > and >>.
 * @param {string} cmd
 * @returns {({sep: true} | {redir: true, dup: boolean} | {text: string, quoted: boolean})[]}
 */
function tokenize(cmd) {
  const toks = [];
  let cur = '';
  let quoted = false;
  let has = false;
  const flush = () => {
    if (has) toks.push({ text: cur, quoted });
    cur = '';
    quoted = false;
    has = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const end = cmd.indexOf(c, i + 1);
      cur += cmd.slice(i + 1, end < 0 ? cmd.length : end);
      quoted = true;
      has = true;
      i = end < 0 ? cmd.length : end;
    } else if (c === '\n' || c === '\r' || c === ';') {
      flush();
      toks.push({ sep: true });
    } else if (c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      flush();
      toks.push({ sep: true });
      if (cmd[i + 1] === c) i++;
    } else if (c === '>') {
      // `2>`, `2>&1` and `&>`: a leading file descriptor isn't a word.
      if (has && !quoted && /^\d+$/.test(cur)) {
        cur = '';
        has = false;
      } else flush();
      if (cmd[i + 1] === '>') i++;
      let dup = false;
      if (cmd[i + 1] === '&') {
        dup = true;
        i++;
        while (/[\d-]/.test(cmd[i + 1] || '')) i++;
      }
      toks.push({ redir: true, dup });
    } else if (/\s/.test(c) || c === '&') {
      flush();
    } else {
      cur += c;
      has = true;
    }
  }
  flush();
  return toks;
}

/** @param {string} word @returns {string} the command a word names: no directory, no .exe, lower case */
const verbOf = (word) => (word.split(/[\\/]/).pop() || '').toLowerCase().replace(/\.exe$/, '');

/**
 * The first disallowed write one command (its words, redirects already dealt with) makes, looking
 * through anything that merely runs another command.
 * @param {{text: string, quoted: boolean}[]} words
 * @param {number} depth how many wrappers and nested shells deep this is
 * @returns {string | null}
 */
function judgeWords(words, depth) {
  // Skip env assignments and sudo to reach the command itself.
  let v = 0;
  while (v < words.length && (/^\w+=/.test(words[v].text) || words[v].text === 'sudo')) v++;
  if (v >= words.length) return null;
  const verb = verbOf(words[v].text);
  const args = words.slice(v + 1);

  // "rtk rm -rf x": the command that runs is what follows the wrapper and its options.
  if (WRAPPERS.has(verb) && depth < MAX_DEPTH) {
    let i = 0;
    while (i < args.length && args[i].text.startsWith('-') && !args[i].quoted) i++;
    return judgeWords(args.slice(i), depth + 1);
  }

  if (SHELLS.has(verb) && depth < MAX_DEPTH) {
    const i = args.findIndex((a) => /^(-c|-lc|-command|\/c)$/i.test(a.text));
    if (i >= 0 && args[i + 1]) {
      const inner = disallowedWrite(args[i + 1].text, depth + 1);
      if (inner) return inner;
    }
  }

  const inPlace = (verb === 'sed' || verb === 'perl') && args.some((a) => /^-(?!-)[A-Za-z]*i|^--in-place/.test(a.text));
  if (MUTATING.has(verb) || inPlace) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.text.startsWith('-') && !a.quoted) {
        if (NON_PATH_PARAMS.has(a.text.toLowerCase())) i++;
        continue;
      }
      // A quoted word that isn't path-shaped is content (`Set-Content f "text"`).
      if (a.quoted && !pathLike(a.text)) continue;
      const path = a.text.replace(/^of=/, '');
      if (!allowed(path)) return path;
    }
    return null;
  }

  // An unfamiliar command followed by "--" and another command: "node wrapper.js shrink -- rm -rf x".
  // What follows runs, whatever the wrapper is. Commands that know "--" as the end of their options
  // are the familiar ones above (rm -- file) and never reach here.
  const dd = words.findIndex((w, i) => i > v && w.text === '--' && !w.quoted);
  if (dd >= 0 && depth < MAX_DEPTH) return judgeWords(words.slice(dd + 1), depth + 1);
  return null;
}

/**
 * The first write in a command line that isn't to an allowed location.
 * @param {string} cmd
 * @param {number} [depth] recursion through `bash -c "..."`
 * @returns {string | null} the offending target, or null when every write is allowed
 */
export function disallowedWrite(cmd, depth = 0) {
  const toks = tokenize(cmd);
  /** @type {any[][]} */
  const segments = [[]];
  for (const t of toks) {
    if ('sep' in t) segments.push([]);
    else segments[segments.length - 1].push(t);
  }

  for (const seg of segments) {
    /** @type {{text: string, quoted: boolean}[]} */
    const words = [];
    for (let i = 0; i < seg.length; i++) {
      if ('redir' in seg[i]) {
        const target = seg[i + 1];
        if (!seg[i].dup && target && 'text' in target) {
          if (!SINKS.has(target.text.toLowerCase()) && !allowed(target.text)) return target.text;
          i++;
        }
      } else words.push(seg[i]);
    }

    const found = judgeWords(words, depth);
    if (found) return found;
  }
  return null;
}


/** @param {string | null | undefined} agent @returns {string} the role: the part of a team agent's name after its team */
export const roleOf = (agent) => String(agent || '').split(/[:/]/).pop() || '';

/**
 * @param {{agent?: string | null, tool?: string, input?: any}} call the agent making the call, the tool, its input
 * @returns {string | null} the target the coach may not write to, or null when the call is fine
 */
export function coachViolation({ agent, tool, input }) {
  if (roleOf(agent) !== 'agent-coach') return null;
  const ti = input || {};
  if (FILE_TOOLS.includes(tool)) {
    const target = ti.file_path || ti.notebook_path || ti.path || ti.filePath;
    return target && !allowed(target) ? target : null;
  }
  if (SHELL_TOOLS.includes(tool)) return disallowedWrite(ti.command || '');
  return null;
}

/** @param {string} offending @returns {string} what the agent is told when its write is blocked */
export const coachMessage = (offending) =>
  `Blocked: agent-coach is propose-only, and "${offending}" is not a place you may write. ` +
  'The only place you may write is .claude/ops/reports/ (or a scratch directory). ' +
  'Put the recommendation in your report as a fenced diff and let a human apply it — ' +
  'agent definitions, team profiles and your own instrumentation are not yours to edit.';
