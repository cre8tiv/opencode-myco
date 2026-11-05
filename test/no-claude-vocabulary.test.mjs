// This fork runs on OpenCode only. The code names OpenCode's tools and fields (shell, edit, path, team/role); a
// Claude Code spelling left in it would be silently inert, or worse, look supported. Files shared with upstream
// (drift-protected) are left as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './helpers.mjs';

const SHARED = new Set(['otlp.mjs', 'profile.mjs', 'check-package.mjs', 'render-review.mjs']);
const IDENTIFIERS = /\b(NotebookEdit|file_path|notebook_path|subagent_type|agent_type|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_[A-Z_]+)\b|['"](Bash|PowerShell)['"]|\b(?:design|engineering)-team:[a-z]|\bteam-ops:[a-z]/;

/** @param {string} dir @returns {string[]} the code files below dir, leaving out dependencies and shared files */
function codeFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === 'telemetry' || n.startsWith('.')) return [];
    if (statSync(p).isDirectory()) return codeFiles(p);
    return /\.(m?js)$/.test(n) && !SHARED.has(n) ? [p] : [];
  });
}

test('the code names no Claude Code tool, field, variable or namespaced agent', () => {
  const files = [...codeFiles(join(ROOT, 'plugins')), ...codeFiles(join(ROOT, 'opencode-plugin')), ...codeFiles(join(ROOT, 'scripts'))];
  assert.ok(files.length > 10);
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => assert.doesNotMatch(line, IDENTIFIERS, `${relative(ROOT, f)}:${i + 1}`));
  }
});
