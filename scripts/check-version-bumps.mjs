#!/usr/bin/env node
// Fails when a change under plugins/<name>/ ships without raising that plugin's version.
//
//   node scripts/check-version-bumps.mjs [--base <ref>]      (default: origin/main)
//
// An installed plugin is pinned to its version: `/plugin update` does nothing for a
// change that keeps the same version, so the change never reaches anyone. Compares the
// files changed between the merge base with <ref> and HEAD, and each changed plugin's
// version at <ref> with the one on disk. A plugin's README.md alone doesn't need a bump,
// and a plugin that is new on this branch has nothing to compare with.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** @param {string[]} args @returns {string} */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** @param {string} a @param {string} b @returns {number} negative, zero or positive, comparing dotted numeric versions */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** @param {string} text @returns {string | null} the "version" of a meta.json, or null when it can't be read */
function versionOf(text) {
  try {
    const v = JSON.parse(text).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

const argv = process.argv.slice(2);
const baseAt = argv.indexOf('--base');
const base = baseAt >= 0 && argv[baseAt + 1] ? argv[baseAt + 1] : 'origin/main';

let changed;
try {
  changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').map((l) => l.trim()).filter(Boolean);
} catch (err) {
  console.error(`Could not diff against ${base}: ${String(/** @type {any} */ (err).stderr || err).trim()}`);
  process.exit(2);
}

/** @type {Map<string, string[]>} */
const byPlugin = new Map();
for (const file of changed) {
  const m = file.match(/^plugins\/([^/]+)\/(.+)$/);
  if (!m || m[2] === 'README.md') continue;
  if (!byPlugin.has(m[1])) byPlugin.set(m[1], []);
  /** @type {string[]} */ (byPlugin.get(m[1])).push(m[2]);
}

const problems = [];
for (const [plugin, files] of byPlugin) {
  const manifest = `plugins/${plugin}/meta.json`;
  let before;
  let after;
  try {
    before = versionOf(git('show', `${base}:${manifest}`));
  } catch {
    continue; // new on this branch
  }
  try {
    after = versionOf(readFileSync(manifest, 'utf8'));
  } catch {
    continue; // removed on this branch
  }
  if (!before || !after) continue;
  if (compareVersions(after, before) <= 0) {
    const e = files.slice(0, 3).join(', ') + (files.length > 3 ? `, and ${files.length - 3} more` : '');
    problems.push(`${plugin}: changed (${e}) but its version is ${after}${after === before ? ', unchanged from' : ', not above'} ${before} on ${base}. Raise "version" in ${manifest}.`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(byPlugin.size ? `Version bumps ok for: ${[...byPlugin.keys()].join(', ')}` : 'No plugin changes.');
