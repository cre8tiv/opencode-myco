#!/usr/bin/env node
// Keeps this fork honest about what it shares with upstream myco.
//
//   node scripts/drift.mjs check                        files meant to match upstream still do (default)
//   node scripts/drift.mjs report [--remote upstream]   what changed upstream since the recorded commit
//   node scripts/drift.mjs init [--commit <sha>]        record the shared files as they are now
//   node scripts/drift.mjs release <path> --reason <t>  stop treating a file as shared, saying why
//
// Most of the repository (templates, check-package, otlp, profile, render-review, the
// telemetry stack) is meant to stay byte-identical to upstream so upstream fixes merge
// cleanly. drift-manifest.json lists those files with a hash. Changing one on purpose
// is a decision: `release` it with a reason, and `report` will then flag upstream changes
// to it as a manual merge instead of a clean pull. All commands take --root <dir>
// (default: this repository) and --remote <name> (default: upstream).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the shared files live, relative to the repository root. */
const SHARED = [
  { dir: 'plugins', under: ['templates', 'telemetry'] },
  { file: 'plugins/design-team/scripts/check-package.mjs' },
  { file: 'plugins/design-team/scripts/render-review.mjs' },
  { file: 'plugins/engineering-team/scripts/check-package.mjs' },
  { file: 'plugins/engineering-team/scripts/profile.mjs' },
  { file: 'plugins/team-ops/scripts/otlp.mjs' },
  { file: 'plugins/team-ops/scripts/profile.mjs' },
];

const MANIFEST = 'drift-manifest.json';

/** Hashes content with line endings normalized, so a Windows checkout compares equal. */
const hash = (p) => createHash('sha256').update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
const posix = (p) => p.split(sep).join('/');

/** @param {string} dir @returns {string[]} every file below dir */
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** @param {string} root @returns {string[]} the shared files that exist, as repo-relative paths */
export function sharedFiles(root) {
  const out = [];
  for (const s of SHARED) {
    if (s.file) {
      if (existsSync(join(root, s.file))) out.push(s.file);
      continue;
    }
    const base = join(root, s.dir);
    if (!existsSync(base)) continue;
    for (const plugin of readdirSync(base)) {
      for (const sub of s.under) {
        const d = join(base, plugin, sub);
        if (existsSync(d) && statSync(d).isDirectory()) out.push(...walk(d).map((f) => posix(relative(root, f))));
      }
    }
  }
  return out.sort();
}

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const load = (root) => JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
const save = (root, m) => writeFileSync(join(root, MANIFEST), JSON.stringify(m, null, 2) + '\n');

/** @returns {string[]} problems: shared files that changed or went missing, or files no longer covered */
export function check(root) {
  const m = load(root);
  const problems = [];
  for (const [p, h] of Object.entries(m.files)) {
    if (!existsSync(join(root, p))) problems.push(`${p}: missing (deleted? \`release\` it if that was on purpose)`);
    else if (hash(join(root, p)) !== h) problems.push(`${p}: differs from upstream (change it upstream, or \`release\` it with a reason)`);
  }
  for (const p of sharedFiles(root)) {
    if (!(p in m.files) && !(p in m.diverged)) problems.push(`${p}: shared but not in the manifest (run \`init\`)`);
  }
  return problems;
}

/** Records the shared files as they are now, at an upstream commit. */
export function init(root, { commit, remote = 'upstream' }) {
  const prev = existsSync(join(root, MANIFEST)) ? load(root) : { diverged: {} };
  const diverged = prev.diverged || {};
  const files = {};
  for (const p of sharedFiles(root)) if (!(p in diverged)) files[p] = hash(join(root, p));
  let url = null;
  try { url = git(root, 'remote', 'get-url', remote); } catch { /* no remote: the commit alone identifies upstream */ }
  const sha = commit || git(root, 'rev-parse', `${remote}/main`);
  save(root, { upstream: { url, commit: sha }, files, diverged });
  return Object.keys(files).length;
}

/** Moves a file from "shared" to "diverged", with the reason it differs. */
export function release(root, path, reason) {
  const m = load(root);
  if (!(path in m.files)) throw new Error(`${path} is not a shared file in ${MANIFEST}`);
  if (!reason) throw new Error('release needs --reason: say why this file now differs from upstream');
  delete m.files[path];
  m.diverged[path] = reason;
  save(root, m);
}

/** What upstream changed since the recorded commit, sorted by what each change needs. */
export function report(root, { remote = 'upstream', branch = 'main' }) {
  const m = load(root);
  git(root, 'fetch', '-q', remote);
  const head = git(root, 'rev-parse', `${remote}/${branch}`);
  const changed = head === m.upstream.commit ? [] : git(root, 'diff', '--name-only', m.upstream.commit, head).split('\n').filter(Boolean);
  return {
    recorded: m.upstream.commit,
    upstream: head,
    pull: changed.filter((p) => p in m.files),
    merge: changed.filter((p) => p in m.diverged),
    review: changed.filter((p) => !(p in m.files) && !(p in m.diverged)),
  };
}

/** @param {string[]} argv */
function main(argv) {
  const get = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const root = resolve(get('--root') || join(dirname(fileURLToPath(import.meta.url)), '..'));
  const remote = get('--remote') || 'upstream';
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'check';
  if (cmd === 'check') {
    const problems = check(root);
    if (problems.length) {
      console.error(problems.map((p) => `  ${p}`).join('\n'));
      process.exit(1);
    }
    console.log('shared files match upstream');
  } else if (cmd === 'init') {
    console.log(`recorded ${init(root, { commit: get('--commit'), remote })} shared files`);
  } else if (cmd === 'release') {
    release(root, argv[1], get('--reason'));
    console.log(`released ${argv[1]}`);
  } else if (cmd === 'report') {
    const r = report(root, { remote });
    console.log(`recorded ${r.recorded.slice(0, 8)}, ${remote}/main is ${r.upstream.slice(0, 8)}`);
    for (const [label, list] of [['pull (shared, take upstream)', r.pull], ['merge by hand (released)', r.merge], ['review (not shared)', r.review]]) {
      if (list.length) console.log(`${label}:\n${list.map((p) => `  ${p}`).join('\n')}`);
    }
    if (!r.pull.length && !r.merge.length && !r.review.length) console.log('nothing changed upstream');
  } else {
    console.error('usage: drift.mjs check | report | init [--commit <sha>] | release <path> --reason <text>');
    process.exit(2);
  }
}

/** Whether this file is the one being run. Both sides are resolved: a symlinked path (a macOS temp directory, a dotfiles-managed config) differs from the real one, and the script would silently do nothing. */
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
