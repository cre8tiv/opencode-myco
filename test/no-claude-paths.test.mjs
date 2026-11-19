// The team's files live in .myco/ and its event stream under ~/.local/share/myco: this fork is OpenCode-only,
// and .claude/ is Claude Code's directory. A `.claude` path left in a script, an agent or a README would send
// an agent to a place nothing writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

// Where `.claude` may still appear: the ignore rule for Claude Code's own settings file, the check that no
// Claude Code plugin manifest is shipped (`.claude-plugin`), and this file.
const ALLOWED = new Set(['.gitignore', 'test/structure.test.mjs', 'test/no-claude-paths.test.mjs']);

test('no tracked file names a .claude path', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length > 100);
  const found = [];
  for (const f of files) {
    if (ALLOWED.has(f) || /\.(png|jpg|ico|woff2?)$/i.test(f)) continue;
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (/\.claude(?!-plugin)/.test(line)) found.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});
