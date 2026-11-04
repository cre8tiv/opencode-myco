// The decision behind the merge gate, free of any host: given the agent and the tool call
// it is about to make, should the call be stopped, and what should the agent be told.
//
// When the project profile sets `merge_policy: human-approval` (or doesn't set it —
// a missing profile resolves to gated), no agent may merge a PR or push to the
// trunk. The agent prepares the merge and hands off; a human performs it.
//
// Keyed on the agent, so a human working in a plain session is unaffected — the
// gate is on autonomous merges, not on the person who asked for one.
//
// When the policy is `autonomous`, a PR merge is still blocked unless the PR's branch
// carries a QA run report with a Pass verdict for the code being merged (see qaCheck).
//
// Two hosts call it: merge-gate.mjs (Claude Code hooks) and the OpenCode plugin.
import { execFileSync } from 'node:child_process';
import { profileKey } from './profile.mjs';

// Shell tools whose commands are inspected, under Claude Code's names and OpenCode's.
// PowerShell is how agents run commands on Windows, so it gets the same scrutiny as Bash.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'bash']);

// Splits a command line into commands at the separators Bash and PowerShell share
// (; && || | and newlines), honoring quotes and skipping heredoc bodies. Each command
// comes back twice: as written, and with quoted text blanked, so that a commit message
// that mentions `gh pr merge` is not mistaken for running it.
function commands(cmd) {
  /** @type {{raw: string, blank: string}[]} */
  const out = [];
  let raw = '';
  let blank = '';
  let quote = null;
  const flush = () => {
    if (raw.trim()) out.push({ raw: raw.trim(), blank: blank.trim() });
    raw = '';
    blank = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      raw += c;
      if (quote === '"' && c === String.fromCharCode(92) && cmd[i + 1] === '"') raw += cmd[++i];
      else if (c === quote) {
        quote = null;
        blank += '"';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      raw += c;
      blank += '"';
    } else if (c === '\n' || c === '\r') {
      const heredoc = raw.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
      flush();
      if (heredoc && c === '\n') {
        // Skip the body: it is text for the command, not commands.
        let j = i + 1;
        while (j < cmd.length) {
          const end = cmd.indexOf('\n', j);
          const line = cmd.slice(j, end < 0 ? cmd.length : end);
          j = end < 0 ? cmd.length : end + 1;
          if (line.trim() === heredoc[2]) break;
        }
        i = j - 1;
      }
    } else if (c === ';' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      flush();
      if (cmd[i + 1] === c) i++;
    } else {
      raw += c;
      blank += c;
    }
  }
  flush();
  return out;
}

// What can precede a command without changing what it is: `FOO=1 gh ...`, `sudo gh ...`.
const PREFIX = /^(?:(?:\w+=\S*|sudo|time|command|&)\s+)+/i;

// What a command can look like. Each is searched for anywhere in a command, not only at its start:
// a plugin that rewrites or shrinks command output runs before the gate and hands it
// "node …/caveman shrink -- gh pr merge 42" or "rtk gh pr merge 42", and a merge that begins with
// a wrapper is still a merge. This was found when exactly that went through in a live run. The
// quoted text of a command is already blanked, so a commit message that mentions merging is not one.
//
// A word starts a command at the beginning, after whitespace, after a quote, or after a path
// separator ("/usr/local/bin/gh").
const WORD = String.raw`(?:^|[\s/"'])`;
// "gh --repo o/r pr merge", "gh -R o/r pr merge": options between gh and the subcommand.
const GH_MERGE = new RegExp(`${WORD}gh(?:\\.exe)?(?:\\s+\\S+)*?\\s+pr\\s+merge\\b`, 'i');
const GH_API = new RegExp(`${WORD}gh(?:\\.exe)?\\s+api\\b`, 'i');
const AZ_PR = new RegExp(`${WORD}az\\s+repos\\s+pr\\s+(?:update|complete|set-auto-complete)\\b`, 'i');
// `git -C dir push`, `git -c k=v push`: global options between git and the subcommand.
const GIT_PUSH = new RegExp(`${WORD}git(?:\\s+(?:-C|-c)\\s+\\S+|\\s+--[\\w-]+(?:=\\S+)?)*\\s+push\\b`, 'i');
// `env -S "gh pr merge 1"`: like `bash -c`, the quoted value is itself a command line.
const ENV_S = new RegExp(`${WORD}env(?:\\.exe)?(?:\\s+\\S+)*?\\s+(?:-S|--split-string)\\s+(["'])([\\s\\S]*)\\1`, 'i');
const SHELL_C = new RegExp(`${WORD}(?:bash|sh|zsh|pwsh|powershell)(?:\\.exe)?(?:\\s+[^"']*?)?\\s+-(?:c|lc|command)\\s+(["'])([\\s\\S]*)\\1\\s*$`, 'i');

// Does a `git push` command target the trunk? Tokens are checked rather than the raw
// text so every spelling of the destination is caught: `main`, `HEAD:main`,
// `+main`, `HEAD:refs/heads/main`, `'main'`.
function pushesToTrunk(raw, trunk) {
  const tokens = raw.split(/\s+/);
  return tokens.slice(tokens.findIndex((t) => /^push$/i.test(t)) + 1).some((tok) => {
    if (!tok || tok.startsWith('-')) return false;
    const refspec = tok.replace(/^["'`]+|["'`]+$/g, '').replace(/^\+/, '');
    const dest = refspec.slice(refspec.lastIndexOf(':') + 1).replace(/^refs\/heads\//, '');
    return dest === trunk;
  });
}

// Deliberately narrow. `git merge origin/main` into a feature branch is how an IC
// keeps its worktree current and must stay allowed; only completing a PR or pushing
// straight at the trunk is a merge in the sense that needs a human.
function mergeAttempt(cmd, trunk, depth = 0) {
  for (const { raw: rawCmd, blank: blankCmd } of commands(cmd)) {
    const raw = rawCmd.replace(PREFIX, '');
    const blank = blankCmd.replace(PREFIX, '');
    if (GH_MERGE.test(blank)) return { what: 'gh pr merge', pr: prArgs(raw) };
    // The REST endpoint and the GraphQL mutation both complete a PR without `gh pr merge`.
    if (GH_API.test(blank) && /(\/pulls\/\d+\/merge\b|\bmergePullRequest\b)/i.test(raw))
      return { what: 'gh api pull request merge', pr: apiPrArgs(raw) };
    if (AZ_PR.test(blank) && /\b(completed|complete|--complete|--auto-complete)\b/i.test(raw))
      return { what: 'az repos pr complete', pr: null };
    if (GIT_PUSH.test(blank) && pushesToTrunk(raw, trunk)) return { what: `git push to ${trunk}`, pr: null };
    // `bash -c "gh pr merge 1"`: the quoted text is the command here.
    const inner = depth < 3 && (raw.match(SHELL_C) || raw.match(ENV_S));
    if (inner) {
      const found = mergeAttempt(inner[2], trunk, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// `gh pr merge` flags that take a value, so the value isn't mistaken for the PR selector.
const VALUE_FLAGS = new Set(['-t', '--subject', '-b', '--body', '-F', '--body-file', '-A', '--author-email', '--match-head-commit']);
const unquote = (t) => (t || '').replace(/^["']+|["']+$/g, '');

// The arguments that identify the PR to `gh pr view`: its number, branch or URL (none
// means the current branch), and --repo when given.
function prArgs(raw) {
  const tokens = raw.split(/\s+/);
  const out = [];
  const at = tokens.findIndex((t) => /^merge$/i.test(t));
  // "gh --repo o/r pr merge 42": the repository comes before the subcommand.
  const before = [];
  for (let i = 0; i < at; i++) {
    const tok = unquote(tokens[i]);
    if (tok === '-R' || tok === '--repo') before.push('--repo', unquote(tokens[++i]));
    else if (/^--repo=/.test(tok)) before.push(tok);
  }
  for (let i = at + 1; i < tokens.length; i++) {
    const tok = unquote(tokens[i]);
    if (tok === '-R' || tok === '--repo') out.push('--repo', unquote(tokens[++i]));
    else if (/^--repo=/.test(tok)) out.push(tok);
    else if (VALUE_FLAGS.has(tok)) i++;
    else if (!tok.startsWith('-') && !out.length) out.push(tok);
  }
  return [...out, ...before];
}

// `gh api repos/o/r/pulls/42/merge`: the number and the repo are in the path.
function apiPrArgs(raw) {
  const m = raw.match(/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/merge/i);
  return m ? [m[2], '--repo', m[1]] : null;
}

// ---- The QA gate (autonomous only) ----

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
const git = (cwd, ...args) => run('git', args, cwd);
// MERGE_GATE_GH names a script to run with node in place of `gh`; the tests use it.
const gh = (cwd, args) => (process.env.MERGE_GATE_GH ? run(process.execPath, [process.env.MERGE_GATE_GH, ...args], cwd) : run('gh', args, cwd));

// Why this PR may not merge yet, or null when its QA report is a Pass for the code being
// merged. The report is the latest .claude/qa/runs/*/report.md on the PR's branch, with
// "Verdict:" and "Tested SHA:" lines. Anything that stops the check from running at all
// (no gh, offline, unknown branch) throws, and the caller lets the merge through: a
// broken gate must never block legitimate work.
function qaCheck(cwd, pr) {
  const branch = JSON.parse(gh(cwd, ['pr', 'view', ...pr, '--json', 'headRefName'])).headRefName;
  if (!branch) throw new Error('no head branch');
  try { git(cwd, 'fetch', '-q', 'origin', branch); } catch { /* use what is already fetched */ }
  const ref = `origin/${branch}`;
  git(cwd, 'rev-parse', '--verify', '-q', ref);
  const reports = git(cwd, 'ls-tree', '-r', '--name-only', ref, '--', '.claude/qa/runs').split(/\r?\n/).filter((f) => /\/report\.md$/.test(f));
  if (!reports.length) return `${branch} has no QA run report under .claude/qa/runs/`;
  const latest = reports.sort().pop();
  const report = git(cwd, 'show', `${ref}:${latest}`);
  const verdict = (report.match(/^\W*Verdict\W*:\W*([A-Za-z][^\r\n]*)/im) || [])[1]?.trim();
  if (!verdict || !/^pass\b/i.test(verdict)) return `${latest} has verdict "${verdict || 'none recorded'}", not Pass`;
  const sha = (report.match(/^\W*Tested SHA\W*:\W*([0-9a-f]{7,40})/im) || [])[1];
  if (!sha) return `${latest} records no "Tested SHA:", so it can't be tied to the code being merged`;
  let changed;
  try {
    changed = git(cwd, 'diff', '--name-only', sha, ref).split(/\r?\n/).filter(Boolean);
  } catch {
    return `${latest}'s tested SHA ${sha} is not in ${branch}'s history`;
  }
  const code = changed.filter((f) => !f.startsWith('.claude/qa/'));
  if (code.length) return `${branch} changed after QA tested ${sha.slice(0, 7)} (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', ...' : ''}); QA must re-run`;
  return null;
}

// A merge or completion tool exposed by an MCP server (GitHub, Azure DevOps, ...).
function mcpMergeAttempt(toolName, input) {
  if (!/^mcp__/i.test(toolName)) return null;
  if (/merge/i.test(toolName)) return { what: toolName, pr: null };
  if (/pull_?request/i.test(toolName) && /^(completed|complete)$/i.test(String(input?.status || '')))
    return { what: `${toolName} (status: completed)`, pr: null };
  return null;
}


/**
 * @param {{agent?: string | null, tool?: string, input?: any, cwd?: string}} call
 *   the agent making the call (none for a human in a plain session), the tool, its input, where it runs
 * @returns {string | null} what to tell the agent when the call must be stopped, or null to let it through
 */
export function mergeVerdict({ agent, tool, input, cwd }) {
  if (!agent) return null;
  const policy = (profileKey(cwd, 'merge_policy', 'human-approval') || '').toLowerCase();
  const trunk = profileKey(cwd, 'trunk_branch', 'main') || 'main';
  const found = SHELL_TOOLS.has(tool) ? mergeAttempt(input?.command || '', trunk) : mcpMergeAttempt(tool || '', input);
  if (policy === 'autonomous') {
    // Autonomous means no human approval, not no QA. Only a merge that names a PR can be
    // checked; a push to the trunk or another tool's merge has no branch to look at.
    let why = null;
    try { why = found?.pr ? qaCheck(cwd, found.pr) : null; } catch { /* could not check: let it through */ }
    return why
      ? `Blocked: merge_policy is "autonomous", but this PR has no passing QA run (${why}). ` +
          'Dispatch qa-specialist against the PR branch, wait for a Pass, then merge.'
      : null;
  }
  return found?.what
    ? `Blocked: this project's merge_policy is "${policy}", so merging is a human's ` +
        `action, not yours (attempted: ${found.what}). Finish the handoff instead — post the ` +
        'review and QA verdicts on the PR, request review from the human named in ' +
        '.claude/team/project.md, send the notification recorded there, and report that ' +
        'the PR is ready to merge. Leave the ticket in its review/validated state.'
    : null;
}
