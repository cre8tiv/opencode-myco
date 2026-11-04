// The merge gate is the one thing standing between an agent and an unreviewed merge, so
// these tests are mostly about what must be blocked and, just as important, what an IC
// does every day that must never be.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { sandbox, writeProfile } from './helpers.mjs';
import { mergeVerdict } from '../plugins/engineering-team/scripts/merge-gate-core.mjs';

const LEAD = 'engineering-team:tech-lead';
const IC = 'engineering-team:ic-generalist';

/**
 * Asks the gate, and answers as a host adapter does: 2 and the message to the agent when the call is blocked.
 * The gh stand-in some tests use is named by MERGE_GATE_GH, which the gate reads from the environment.
 * @param {Parameters<typeof mergeVerdict>[0]} call @param {{MERGE_GATE_GH?: string}} [env]
 */
function verdict(call, env = {}) {
  const had = process.env.MERGE_GATE_GH;
  if (env.MERGE_GATE_GH) process.env.MERGE_GATE_GH = env.MERGE_GATE_GH;
  else delete process.env.MERGE_GATE_GH;
  try {
    const message = mergeVerdict(call);
    return message ? { status: 2, stderr: message } : { status: 0, stderr: '' };
  } finally {
    if (had === undefined) delete process.env.MERGE_GATE_GH;
    else process.env.MERGE_GATE_GH = had;
  }
}

/**
 * @param {ReturnType<typeof sandbox>} sb
 * @param {{tool?: string, command?: string, input?: object, agent?: string | null}} call
 */
async function gate(sb, { tool = 'Bash', command, input, agent = LEAD }) {
  return verdict({ agent: agent || undefined, tool, input: input ?? { command }, cwd: sb.project });
}

describe('merge_policy: human-approval', () => {
  const BLOCKED = [
    ['Bash', 'gh pr merge 42'],
    ['Bash', 'gh pr merge 42 --squash --delete-branch'],
    ['PowerShell', 'gh pr merge 42 --squash'],
    ['PowerShell', 'gh.exe pr merge 42'],
    ['Bash', 'gh api -X PUT repos/acme/app/pulls/42/merge -f merge_method=squash'],
    ['Bash', 'gh api graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "X"}) { clientMutationId } }\''],
    ['Bash', 'az repos pr update --id 42 --status completed'],
    ['Bash', 'git push origin main'],
    ['Bash', 'git push origin HEAD:main'],
    ['Bash', 'git push origin HEAD:refs/heads/main'],
    ['Bash', 'git push origin +main'],
    ['Bash', 'git push --force-with-lease origin HEAD:main'],
    ['Bash', 'git push origin :main'],
    ['Bash', 'git add -A && git commit -m wip && git push origin main'],
    ['PowerShell', 'git add .; git commit -m wip; git push origin main'],
    ['Bash', 'cd app && git push origin main'],
    ['Bash', 'git -C ../app push origin main'],
    ['Bash', 'GH_TOKEN=abc gh pr merge 42'],
    ['Bash', 'bash -c "gh pr merge 42"'],
    ['PowerShell', 'pwsh -NoProfile -Command "gh pr merge 42 --squash"'],
  ];
  for (const [tool, command] of BLOCKED) {
    test(`blocks ${tool}: ${command}`, async (t) => {
      const sb = sandbox(t);
      writeProfile(sb.project, { merge_policy: 'human-approval', trunk_branch: 'main' });
      const r = await gate(sb, { tool, command });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /human/i);
    });
  }

  const ALLOWED = [
    // How an IC keeps its worktree current and publishes its branch.
    'git merge origin/main',
    'git pull --rebase origin main',
    'git fetch origin main',
    'git push -u origin CLOUD-123-retry-logic',
    'git push origin HEAD',
    'git push origin feature/main-menu',
    'git push origin main:feature/from-main',
    'git push origin HEAD && gh pr create --fill',
    // Reading PRs is fine; only completing one is a merge.
    'gh pr view 42',
    'gh pr checks 42 --watch',
    'gh pr review 42 --comment -b "looks good"',
    'gh api repos/acme/app/pulls/42/comments',
    'git stash push -m main',
    'echo "to merge, run gh pr merge 42"',
    'git commit -m "revert: undo git push origin main"',
    'git -C ../app push origin feature/x',
  ];
  for (const command of ALLOWED) {
    test(`allows: ${command}`, async (t) => {
      const sb = sandbox(t);
      writeProfile(sb.project, { merge_policy: 'human-approval', trunk_branch: 'main' });
      const r = await gate(sb, { command });
      assert.equal(r.status, 0, r.stderr);
    });
  }

  test('blocks merge tools exposed by an MCP server', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    for (const tool of ['mcp__github__merge_pull_request', 'mcp__plugin_github_github__merge_pull_request']) {
      const r = await gate(sb, { tool, input: { owner: 'acme', repo: 'app', pullNumber: 42 } });
      assert.equal(r.status, 2, tool);
    }
  });

  test('blocks completing a PR by status through an MCP server, but not other updates', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    const tool = 'mcp__azure-devops__update_pull_request';
    assert.equal((await gate(sb, { tool, input: { id: 42, status: 'completed' } })).status, 2);
    assert.equal((await gate(sb, { tool, input: { id: 42, status: 'active', title: 'renamed' } })).status, 0);
  });

  test('leaves read-only MCP tools alone', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    assert.equal((await gate(sb, { tool: 'mcp__github__get_pull_request', input: { pullNumber: 42 } })).status, 0);
    assert.equal((await gate(sb, { tool: 'Read', input: { file_path: 'merge-notes.md' } })).status, 0);
  });

  test('the block tells the agent what to do instead', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    const r = await gate(sb, { command: 'gh pr merge 42' });
    assert.match(r.stderr, /handoff/i);
    assert.match(r.stderr, /project\.md/);
  });

  test('a heredoc commit message that mentions merging is not a merge', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    const command = `git commit -q -F - <<'EOF'
fix: stop retrying forever

gh pr merge is blocked for agents by the merge gate
git push origin main stays with a human
EOF
git push -u origin CLOUD-9`;
    const r = await gate(sb, { command });
    assert.equal(r.status, 0, r.stderr);
  });

  test('a push to the trunk after a heredoc is still caught', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    const command = `git commit -q -F - <<'EOF'
fix
EOF
git push origin main`;
    assert.equal((await gate(sb, { command })).status, 2);
  });

  test('a commit message that mentions merging is not a merge', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    const r = await gate(sb, { command: 'git commit -m "docs: explain how gh pr merge is gated"' });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('policy resolution', () => {
  test('a missing profile is treated as gated', async (t) => {
    const sb = sandbox(t);
    assert.equal((await gate(sb, { command: 'gh pr merge 42' })).status, 2);
  });

  test('a profile with no frontmatter is treated as gated', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, '');
    assert.equal((await gate(sb, { command: 'gh pr merge 42' })).status, 2);
  });

  test('autonomous allows merging', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'autonomous' });
    for (const command of ['gh pr merge 42 --squash', 'git push origin main']) {
      assert.equal((await gate(sb, { command })).status, 0, command);
    }
  });

  test('autonomous, written the way people write YAML (quotes, trailing comment, CRLF)', async (t) => {
    const sb = sandbox(t);
    for (const fm of ['merge_policy: "autonomous"', "merge_policy: 'Autonomous'", 'merge_policy: autonomous   # we trust CI', 'merge_policy: autonomous\r\ntrunk_branch: main\r']) {
      writeProfile(sb.project, fm);
      assert.equal((await gate(sb, { command: 'gh pr merge 42' })).status, 0, fm);
    }
  });

  test('an unfilled template placeholder never means autonomous', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: '<human-approval | autonomous>' });
    assert.equal((await gate(sb, { command: 'gh pr merge 42' })).status, 2);
  });

  test('a typo in the policy fails safe', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'autonomus' });
    assert.equal((await gate(sb, { command: 'gh pr merge 42' })).status, 2);
  });

  test('the profile is found from inside a worktree below the project root', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'autonomous' });
    const worktree = join(sb.project, '.claude', 'worktrees', 'agent-1', 'src');
    mkdirSync(worktree, { recursive: true });
    const r = verdict({ agent: IC, cwd: worktree, tool: 'Bash', input: { command: 'gh pr merge 1' } });
    assert.equal(r.status, 0);
  });
});

describe('trunk_branch', () => {
  test('protects the configured trunk, not a hard-coded main', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval', trunk_branch: 'develop' });
    assert.equal((await gate(sb, { command: 'git push origin develop' })).status, 2);
    assert.equal((await gate(sb, { command: 'git push origin HEAD:refs/heads/develop' })).status, 2);
    assert.equal((await gate(sb, { command: 'git push origin main' })).status, 0);
  });

  test('a trailing comment is not part of the branch name', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, 'merge_policy: human-approval\ntrunk_branch: develop   # our integration branch');
    assert.equal((await gate(sb, { command: 'git push origin develop' })).status, 2);
  });

  test('an unfilled placeholder falls back to main instead of protecting a branch called "<main>"', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval', trunk_branch: '<main>' });
    assert.equal((await gate(sb, { command: 'git push origin main' })).status, 2);
  });

  test('a branch whose name merely contains the trunk name is not the trunk', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval', trunk_branch: 'main' });
    for (const branch of ['main-menu', 'domain', 'fix/main', 'maintenance']) {
      assert.equal((await gate(sb, { command: `git push origin ${branch}` })).status, 0, branch);
    }
  });
});

describe('who is gated', () => {
  test('a human in a plain session is never blocked', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    assert.equal((await gate(sb, { command: 'gh pr merge 42', agent: null })).status, 0);
  });

  test('every team agent is gated, not just the lead', async (t) => {
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    for (const agent of [LEAD, IC, 'engineering-team:qa-specialist', 'engineering-team:code-reviewer']) {
      assert.equal((await gate(sb, { command: 'gh pr merge 42', agent })).status, 2, agent);
    }
  });
});

describe('failing safe', () => {
  test('a malformed call never blocks work', async (t) => {
    const sb = sandbox(t);
    for (const input of [null, undefined, 'gh pr merge 1', [], 42, { command: 42 }, { command: null }]) {
      assert.equal(verdict({ agent: LEAD, tool: 'Bash', input, cwd: sb.project }).status, 0, JSON.stringify(input));
    }
    for (const call of [{}, { agent: LEAD }, { tool: 'Bash' }]) {
      assert.equal(verdict(call).status, 0, JSON.stringify(call));
    }
  });

  test('a call with no tool input is allowed', async (t) => {
    const sb = sandbox(t);
    const r = verdict({ agent: LEAD, cwd: sb.project, tool: 'Bash' });
    assert.equal(r.status, 0);
  });
});

// Autonomous means no human approval, not no QA: a PR can only merge if its branch carries
// a passing QA report for the code being merged. These tests use real git repositories (an
// origin and a clone) and a stand-in for `gh` that answers `pr view` with the head branch.
describe('merge_policy: autonomous requires a passing QA run', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /**
   * A project cloned from an origin, with a feature branch `feat/x` pushed to it.
   * @param {ReturnType<typeof sandbox>} sb
   */
  function repo(sb) {
    const origin = join(sb.root, 'origin.git');
    mkdirSync(origin);
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(sb.project, 'init', '-q', '-b', 'main');
    git(sb.project, 'remote', 'add', 'origin', origin);
    writeFileSync(join(sb.project, 'app.js'), 'one\n');
    git(sb.project, 'add', 'app.js');
    git(sb.project, 'commit', '-q', '-m', 'base');
    git(sb.project, 'push', '-q', 'origin', 'main');
    git(sb.project, 'checkout', '-q', '-b', 'feat/x');
    writeFileSync(join(sb.project, 'app.js'), 'two\n');
    git(sb.project, 'commit', '-q', '-am', 'change');
    const ghStub = join(sb.root, 'gh-stub.mjs');
    writeFileSync(ghStub, "if (process.argv.includes('99')) process.exit(1);\nconsole.log(JSON.stringify({ headRefName: 'feat/x' }));\n");
    writeProfile(sb.project, { merge_policy: 'autonomous' });
    const push = () => git(sb.project, 'push', '-q', 'origin', 'feat/x');
    /** Commits a QA report, as the qa-specialist does, and pushes. */
    const qaReport = (dir, lines, { sha = git(sb.project, 'rev-parse', 'HEAD') } = {}) => {
      mkdirSync(join(sb.project, '.claude', 'qa', 'runs', dir), { recursive: true });
      const body = lines.map((l) => l.replace('<sha>', sha)).join('\n') + '\n';
      writeFileSync(join(sb.project, '.claude', 'qa', 'runs', dir, 'report.md'), body);
      git(sb.project, 'add', '.claude/qa');
      git(sb.project, 'commit', '-q', '-m', `qa ${dir}`);
      push();
    };
    push();
    return { qaReport, push, env: { ...sb.env, MERGE_GATE_GH: ghStub } };
  }
  const run = (sb, r, command) => verdict({ agent: LEAD, cwd: sb.project, tool: 'Bash', input: { command } }, r.env);
  const PASS = ['# QA run', 'Verdict: Pass', 'Tested SHA: <sha>'];

  test('a Pass for the code being merged lets the merge through', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    r.qaReport('2026-10-12-X-1', PASS);
    assert.equal((await run(sb, r, 'gh pr merge 42 --squash')).status, 0);
  });

  test('Pass with caveats is accepted, and markdown emphasis in the report is tolerated', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    r.qaReport('2026-10-12-X-1', ['**Verdict:** Pass with caveats', '- **Tested SHA:** <sha>']);
    assert.equal((await run(sb, r, 'gh pr merge 42')).status, 0);
  });

  test('no QA report on the branch blocks the merge, and says what to do', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    const out = await run(sb, r, 'gh pr merge 42');
    assert.equal(out.status, 2);
    assert.match(out.stderr, /no QA run report/);
    assert.match(out.stderr, /qa-specialist/);
  });

  test('a Fail or Blocked verdict blocks', async (t) => {
    for (const verdict of ['Fail', 'Blocked']) {
      const sb = sandbox(t);
      const r = repo(sb);
      r.qaReport('2026-10-12-X-1', [`Verdict: ${verdict}`, 'Tested SHA: <sha>']);
      const out = await run(sb, r, 'gh pr merge 42');
      assert.equal(out.status, 2, verdict);
      assert.match(out.stderr, new RegExp(`verdict "${verdict}"`));
    }
  });

  test('the latest run decides: a later Pass clears an earlier Fail, a later Fail overrides a Pass', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    r.qaReport('2026-10-10-X-1', ['Verdict: Fail', 'Tested SHA: <sha>']);
    r.qaReport('2026-10-11-X-1', PASS);
    assert.equal((await run(sb, r, 'gh pr merge 42')).status, 0);
    r.qaReport('2026-10-12-X-1', ['Verdict: Fail', 'Tested SHA: <sha>']);
    assert.equal((await run(sb, r, 'gh pr merge 42')).status, 2);
  });

  test('a report with no verdict, or no tested SHA, blocks', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    r.qaReport('2026-10-12-X-1', ['All scenarios ran.']);
    assert.equal((await run(sb, r, 'gh pr merge 42')).status, 2);
    r.qaReport('2026-10-12-X-2', ['Verdict: Pass']);
    const out = await run(sb, r, 'gh pr merge 42');
    assert.equal(out.status, 2);
    assert.match(out.stderr, /Tested SHA/);
  });

  test('code pushed after QA tested it makes the Pass stale', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    r.qaReport('2026-10-12-X-1', PASS);
    writeFileSync(join(sb.project, 'app.js'), 'three\n');
    git(sb.project, 'commit', '-q', '-am', 'late fix');
    r.push();
    const out = await run(sb, r, 'gh pr merge 42');
    assert.equal(out.status, 2);
    assert.match(out.stderr, /changed after QA tested.*app\.js/);
  });

  test('QA files committed after the tested SHA do not make it stale', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    r.qaReport('2026-10-12-X-1', PASS);
    mkdirSync(join(sb.project, '.claude', 'qa', 'scripts'), { recursive: true });
    writeFileSync(join(sb.project, '.claude', 'qa', 'scripts', 'smoke.sh'), 'echo ok\n');
    git(sb.project, 'add', '.claude/qa');
    git(sb.project, 'commit', '-q', '-m', 'qa script');
    r.push();
    assert.equal((await run(sb, r, 'gh pr merge 42')).status, 0);
  });

  test('a tested SHA that is not in the branch blocks', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    r.qaReport('2026-10-12-X-1', PASS, { sha: 'deadbeefdeadbeef' });
    const out = await run(sb, r, 'gh pr merge 42');
    assert.equal(out.status, 2);
    assert.match(out.stderr, /not in feat\/x's history/);
  });

  test('the REST merge endpoint is held to the same rule', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    assert.equal((await run(sb, r, 'gh api -X PUT repos/acme/app/pulls/42/merge')).status, 2);
    r.qaReport('2026-10-12-X-1', PASS);
    assert.equal((await run(sb, r, 'gh api -X PUT repos/acme/app/pulls/42/merge')).status, 0);
  });

  test('flags and their values around the PR number do not confuse the lookup', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    assert.equal((await run(sb, r, 'gh pr merge --squash --subject "fix it" 42 --delete-branch')).status, 2);
  });

  test('when the check cannot run at all, the merge is not blocked', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    // The gh stand-in fails for PR 99, as gh would when missing or offline.
    assert.equal((await run(sb, r, 'gh pr merge 99')).status, 0);
    // And a project that is not a git repository at all.
    const plain = join(sb.root, 'plain');
    mkdirSync(plain);
    writeProfile(plain, { merge_policy: 'autonomous' });
    assert.equal(verdict({ agent: LEAD, cwd: plain, tool: 'Bash', input: { command: 'gh pr merge 42' } }, r.env).status, 0);
  });

  test('a push to the trunk and non-merge commands are not subject to the QA check', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    for (const command of ['git push origin main', 'gh pr view 42', 'git merge origin/main']) {
      assert.equal((await run(sb, r, command)).status, 0, command);
    }
  });

  test('human-approval still blocks every merge, report or not', async (t) => {
    const sb = sandbox(t);
    const r = repo(sb);
    writeProfile(sb.project, { merge_policy: 'human-approval' });
    r.qaReport('2026-10-12-X-1', PASS);
    const out = await run(sb, r, 'gh pr merge 42');
    assert.equal(out.status, 2);
    assert.match(out.stderr, /merging is a human's/);
  });
});

describe('commands another plugin has wrapped, or spelled with options', () => {
  // A plugin that rewrites commands runs before this gate and hands it
  // "node …/caveman shrink -- gh pr merge 42", which starts with "node". In a live run the PR
  // merge went through. The gate must judge the command that will actually run. Options placed
  // before the subcommand (gh --repo o/r pr merge) are the same hole without any wrapper.
  const CAVEMAN = "'/opt/homebrew/bin/node' '/opt/homebrew/bin/caveman' shrink --";
  const BLOCKED = [
    `${CAVEMAN} gh pr merge 42`,
    `${CAVEMAN} gh pr merge 42 --squash`,
    `${CAVEMAN} gh api -X PUT repos/acme/app/pulls/42/merge`,
    `${CAVEMAN} az repos pr update --id 42 --status completed`,
    `${CAVEMAN} git push origin main`,
    `${CAVEMAN} bash -c "gh pr merge 42"`,
    'rtk gh pr merge 42',
    'rtk git push origin main',
    'env GH_TOKEN=abc gh pr merge 42',
    'time gh pr merge 42',
    'nohup git push origin HEAD:main',
    'gh --repo acme/app pr merge 42',
    'gh -R acme/app pr merge 42 --squash',
    'rtk gh --repo acme/app pr merge 42',
    '/usr/local/bin/gh pr merge 42',
    // Wrapper options that take a value: the gate searches the whole command, so none of them hides a merge.
    'env -u NAME gh pr merge 42',
    'env -C src git push origin main',
    'sudo -u root gh pr merge 42',
    'time -o out.txt gh pr merge 42',
    'stdbuf -o L git push origin HEAD:main',
    'env -S "gh pr merge 42"',
  ];
  for (const command of BLOCKED) {
    test(`blocks: ${command}`, async (t) => {
      const sb = sandbox(t);
      writeProfile(sb.project, { merge_policy: 'human-approval', trunk_branch: 'main' });
      const r = await gate(sb, { command });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /human/i);
    });
  }

  const ALLOWED = [
    `${CAVEMAN} gh pr view 42`,
    `${CAVEMAN} git push origin feature/x`,
    `${CAVEMAN} git merge origin/main`,
    `${CAVEMAN} git log --oneline -5`,
    `${CAVEMAN} git commit -m "docs: explain how gh pr merge is gated"`,
    'rtk gh pr view 42',
    'rtk git status',
    'rtk git push -u origin CLOUD-123-retry-logic',
    'gh --repo acme/app pr view 42',
    'gh -R acme/app pr checks 42',
    'git stash push -m main',
  ];
  for (const command of ALLOWED) {
    test(`allows: ${command}`, async (t) => {
      const sb = sandbox(t);
      writeProfile(sb.project, { merge_policy: 'human-approval', trunk_branch: 'main' });
      const r = await gate(sb, { command });
      assert.equal(r.status, 0, r.stderr);
    });
  }
});

describe('what widening the search costs', () => {
  test('an unquoted mention of a merge command is treated as the command; a quoted one is not', async (t) => {
    // Searching the whole command for a merge is what catches a merge behind a wrapper. The price is
    // that "echo gh pr merge 42", unquoted, looks like one. Quoted text is blanked, so messages and
    // arguments that mention it in quotes (the realistic case) are unaffected.
    const sb = sandbox(t);
    writeProfile(sb.project, { merge_policy: 'human-approval', trunk_branch: 'main' });
    assert.equal((await gate(sb, { command: 'echo gh pr merge 42' })).status, 2);
    assert.equal((await gate(sb, { command: 'echo "gh pr merge 42"' })).status, 0);
    assert.equal((await gate(sb, { command: "git commit -m 'docs: gh pr merge is gated'" })).status, 0);
  });
});
