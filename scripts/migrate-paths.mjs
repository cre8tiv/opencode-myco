#!/usr/bin/env node
// Moves a project's team files off `.claude/` to the layout this fork uses.
//
//   node scripts/migrate-paths.mjs [--project <dir>] [--dry-run]
//
//   .claude/team/              ->  .myco/team/               profiles and knowledge sources
//   .claude/qa/                ->  .myco/qa/                 the QA library
//   .claude/ops/reports/       ->  .myco/ops/reports/        agent-coach reports
//   ~/.claude/ops/<stream>/    ->  $XDG_DATA_HOME/myco/ops/<stream>/   (default ~/.local/share), copied
//
// Only those four are touched. Anything else in `.claude/` (settings, a Claude Code install) stays where
// it is. Nothing is deleted except a `.claude/ops` or `.claude` directory the moves left empty, and the old
// event stream is left for the person to delete once they are satisfied it arrived.
//
// Tracked files are moved with `git mv`, so the move shows as renames to commit. It stops before changing
// anything if a destination exists already or a tracked file in a source has uncommitted changes. A second
// run finds nothing to do.
//
// Run it only with a plugin version that reads the new paths: the team's scripts and agents read what this
// moves, and an older install would find nothing.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project's directories that move, as [from, to] relative to the project. */
export const PROJECT_MOVES = [
  ['.claude/team', '.myco/team'],
  ['.claude/qa', '.myco/qa'],
  ['.claude/ops/reports', '.myco/ops/reports'],
];

/** The profiles, in the order a stream name is looked up. */
const PROFILES = ['project.md', 'design.md'];

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** @param {string} dir @returns {boolean} whether dir is inside a git work tree */
function isRepo(dir) {
  try {
    return git(dir, 'rev-parse', '--is-inside-work-tree').trim() === 'true';
  } catch {
    return false;
  }
}

/** @param {string} dir @param {string} rel @returns {string[]} the tracked files below rel */
const tracked = (dir, rel) => git(dir, 'ls-files', '-z', '--', rel).split('\0').filter(Boolean);

/** The `stream:` the project's profile names, else the project's directory name: what team-ops resolves. */
export function streamNameOf(project) {
  for (const name of PROFILES) {
    try {
      const m = readFileSync(join(project, '.claude', 'team', name), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const kv = m?.[1].match(/^stream:[ \t]*(.*)$/m);
      if (!kv) continue;
      let raw = kv[1].trim();
      if (!/^["']/.test(raw)) raw = raw.replace(/\s+#.*$/, '');
      const value = raw.replace(/^["']|["']$/g, '');
      if (value && !value.startsWith('#') && !value.startsWith('<')) return value;
    } catch {
      /* no such profile */
    }
  }
  return basename(project) || 'default';
}

/** Where the event streams live, in the old layout and the new. */
export const streamHomes = () => ({
  from: join(homedir(), '.claude', 'ops'),
  to: join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'myco', 'ops'),
});

/** @param {string} dir @returns {string[]} every file below dir, relative, with its size */
function listing(dir) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [`${relative(dir, join(d, e.name))}:${statSync(join(d, e.name)).size}`]));
  return walk(dir).sort();
}

/**
 * Works out what to do, without doing it.
 * @param {string} project @returns {{moves: {from: string, to: string, git: boolean}[], stream: {from: string, to: string} | null, problems: string[]}}
 */
export function plan(project) {
  const repo = isRepo(project);
  const problems = [];
  const moves = [];
  for (const [from, to] of PROJECT_MOVES) {
    if (!existsSync(join(project, from))) continue;
    if (existsSync(join(project, to))) {
      problems.push(`${to} already exists, so ${from} was not moved: merge them by hand, then run this again`);
      continue;
    }
    const files = repo ? tracked(project, from) : [];
    if (files.length && git(project, 'status', '--porcelain', '--untracked-files=no', '--', from).trim()) {
      problems.push(`${from} has uncommitted changes: commit or stash them first`);
      continue;
    }
    moves.push({ from, to, git: files.length > 0 });
  }
  const name = streamNameOf(project);
  const homes = streamHomes();
  const from = join(homes.from, name);
  const to = join(homes.to, name);
  let stream = null;
  if (existsSync(from)) {
    if (existsSync(to)) problems.push(`the event stream already exists at ${to}, so ${from} was not copied: merge them by hand`);
    else stream = { from, to };
  }
  return { moves, stream, problems };
}

/** @param {string} project @param {{dryRun?: boolean, log?: (s: string) => void}} [opts] @returns {number} an exit status */
export function migrate(project, { dryRun = false, log = console.log } = {}) {
  const { moves, stream, problems } = plan(project);
  if (problems.length) {
    for (const p of problems) log(`stopped: ${p}`);
    return 1;
  }
  if (!moves.length && !stream) {
    log('Nothing to migrate: no team files under .claude/ and no old event stream.');
    return 0;
  }
  const would = dryRun ? 'would move' : 'moved';
  for (const m of moves) {
    if (!dryRun) {
      mkdirSync(dirname(join(project, m.to)), { recursive: true });
      if (m.git) git(project, 'mv', m.from, m.to);
      else renameSync(join(project, m.from), join(project, m.to));
    }
    log(`${would} ${m.from} -> ${m.to}${m.git ? ' (git mv)' : ''}`);
  }
  if (stream) {
    if (!dryRun) {
      mkdirSync(dirname(stream.to), { recursive: true });
      cpSync(stream.from, stream.to, { recursive: true });
      if (JSON.stringify(listing(stream.from)) !== JSON.stringify(listing(stream.to))) {
        log(`stopped: the copy at ${stream.to} does not match ${stream.from}; the original is untouched`);
        return 1;
      }
    }
    log(`${dryRun ? 'would copy' : 'copied'} ${stream.from} -> ${stream.to}`);
  }
  if (!dryRun) {
    // Directories the moves left empty. rmdir refuses a directory with anything in it, which is the point.
    for (const d of ['.claude/ops', '.claude']) {
      try {
        rmdirSync(join(project, d));
      } catch {
        /* not empty, or not there */
      }
    }
    log('');
    if (moves.some((m) => m.git)) log('Commit the renames. Branches made before this will have their QA reports at the old path: rebase them after.');
    if (stream) log(`The old event stream was left at ${stream.from}. Delete it yourself when you are satisfied.`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const at = args.indexOf('--project');
  const project = resolve(at >= 0 ? args[at + 1] || '.' : process.cwd());
  if (flag('--help') || flag('-h')) {
    console.log('usage: node scripts/migrate-paths.mjs [--project <dir>] [--dry-run]');
    process.exit(0);
  }
  if (!existsSync(project)) {
    console.error(`no such directory: ${project}`);
    process.exit(1);
  }
  process.exit(migrate(project, { dryRun: flag('--dry-run') }));
}
