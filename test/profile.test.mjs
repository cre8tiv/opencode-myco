// The team profile is how every hook learns about the project it's running in: the merge
// policy, the trunk, the telemetry stream. A parsing slip here silently changes
// behavior (an unfilled placeholder becomes a branch name; a trailing comment becomes
// part of a value), so the parser is tested against how people actually write YAML.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, script, writeProfile } from './helpers.mjs';
import { profileKey } from '../plugins/team-ops/scripts/profile.mjs';
import { resolveStreamName } from '../plugins/team-ops/scripts/stream.mjs';

const key = (dir, k, fallback) => profileKey(dir, k, fallback);

test('the two copies of profile.mjs are identical', () => {
  // The plugins install independently and can't import from each other, so each ships
  // its own copy. They have drifted before, with a real effect on the merge gate.
  const a = readFileSync(script('team-ops', 'profile.mjs'), 'utf8');
  const b = readFileSync(script('engineering-team', 'profile.mjs'), 'utf8');
  assert.equal(b.replace(/\r\n/g, '\n'), a.replace(/\r\n/g, '\n'));
});

describe('values', () => {
  test('plain, quoted and commented values', (t) => {
    const sb = sandbox(t);
    writeProfile(
      sb.project,
      [
        'merge_policy: human-approval',
        'quoted_double: "main"',
        "quoted_single: 'develop'",
        'trailing_comment: release   # the branch we ship from',
        'hash_inside_quotes: "a #1 priority"',
        'url: https://example.com/a#section',
        'padded:    spaced out   ',
      ].join('\n'),
    );
    assert.equal(key(sb.project, 'merge_policy'), 'human-approval');
    assert.equal(key(sb.project, 'quoted_double'), 'main');
    assert.equal(key(sb.project, 'quoted_single'), 'develop');
    assert.equal(key(sb.project, 'trailing_comment'), 'release');
    assert.equal(key(sb.project, 'hash_inside_quotes'), 'a #1 priority');
    assert.equal(key(sb.project, 'url'), 'https://example.com/a#section');
    assert.equal(key(sb.project, 'padded'), 'spaced out');
  });

  test('empty values, comments and unfilled <placeholders> count as unset', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, ['empty:', 'comment: # nothing here yet', 'placeholder: <main>', 'choice: <human-approval | autonomous>'].join('\n'));
    for (const k of ['empty', 'comment', 'placeholder', 'choice']) {
      assert.equal(key(sb.project, k, 'FALLBACK'), 'FALLBACK', k);
    }
  });

  test('a missing key returns the fallback, or undefined', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'alpha' });
    assert.equal(key(sb.project, 'nope', 'main'), 'main');
    assert.equal(key(sb.project, 'nope'), undefined);
  });

  test('only the frontmatter is read, never the prose body', (t) => {
    const sb = sandbox(t);
    const p = join(sb.project, '.myco', 'team', 'project.md');
    mkdirSync(join(sb.project, '.myco', 'team'), { recursive: true });
    writeFileSync(p, '---\nstream: alpha\n---\n\n# Profile\n\nmerge_policy: autonomous\n');
    assert.equal(key(sb.project, 'stream'), 'alpha');
    assert.equal(key(sb.project, 'merge_policy'), undefined);
  });

  test('CRLF line endings, as written on Windows', (t) => {
    const sb = sandbox(t);
    const p = join(sb.project, '.myco', 'team', 'project.md');
    mkdirSync(join(sb.project, '.myco', 'team'), { recursive: true });
    writeFileSync(p, '---\r\nstream: alpha\r\nmerge_policy: autonomous\r\n---\r\n\r\n# Profile\r\n');
    assert.equal(key(sb.project, 'stream'), 'alpha');
    assert.equal(key(sb.project, 'merge_policy'), 'autonomous');
  });

  test('a file with no frontmatter, or none at all, reads as empty', (t) => {
    const sb = sandbox(t);
    assert.equal(key(sb.project, 'stream', 'x'), 'x');
    mkdirSync(join(sb.project, '.myco', 'team'), { recursive: true });
    writeFileSync(join(sb.project, '.myco', 'team', 'project.md'), '# Just prose\n\nstream: alpha\n');
    assert.equal(key(sb.project, 'stream', 'x'), 'x');
  });
});

describe('finding the profile', () => {
  test('walks up from a subdirectory, as an IC in a git worktree does', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'alpha' });
    const deep = join(sb.project, 'worktrees', 'agent-9', 'packages', 'api');
    mkdirSync(deep, { recursive: true });
    assert.equal(key(deep, 'stream'), 'alpha');
  });

  test('project.md wins over design.md in the same directory; design.md fills in what it lacks', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'from-project' }, 'project.md');
    writeProfile(sb.project, { stream: 'from-design', packages_dir: 'docs/design' }, 'design.md');
    assert.equal(key(sb.project, 'stream'), 'from-project');
    assert.equal(key(sb.project, 'packages_dir'), 'docs/design');
  });

  test('a design-only project still resolves its stream', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'design-only' }, 'design.md');
    assert.equal(key(sb.project, 'stream'), 'design-only');
  });

  test('the nearest profile wins when projects are nested', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'outer' });
    const inner = join(sb.project, 'services', 'billing');
    mkdirSync(inner, { recursive: true });
    writeProfile(inner, { stream: 'inner' });
    assert.equal(key(inner, 'stream'), 'inner');
    assert.equal(key(join(sb.project, 'services'), 'stream'), 'outer');
  });
});

describe('telemetry stream name', () => {
  test('comes from the profile', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'checkout-service' });
    assert.equal(resolveStreamName(sb.project), 'checkout-service');
  });

  test('falls back to the directory name, so unconfigured projects do not share one stream', (t) => {
    const sb = sandbox(t);
    assert.equal(resolveStreamName(sb.project), 'proj-alpha');
  });

  test('an unfilled placeholder falls back to the directory name too', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: '<short-slug-for-this-project>' });
    assert.equal(resolveStreamName(sb.project), 'proj-alpha');
  });

  test('every worktree of a project resolves the same stream when the profile is committed', (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { stream: 'checkout-service' });
    const a = join(sb.project, 'worktrees', 'a');
    const b = join(sb.project, 'worktrees', 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    assert.equal(resolveStreamName(a), resolveStreamName(b));
  });
});
