// agent-coach is propose-only: it may write its report and scratch files, and nothing
// else. These tests cover the ways an agent could write elsewhere, by accident or by
// habit, and the things the coach legitimately does that must keep working.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coachViolation, coachMessage } from '../plugins/team-ops/scripts/coach-guard-core.mjs';

const COACH = 'team-ops/agent-coach';

/** @param {{tool: string, input: object, agent?: string | null}} call */
const guard = ({ tool, input, agent = COACH }) => {
  const offending = coachViolation({ agent: agent || undefined, tool, input });
  // 2 and the message to the agent when the call is blocked: what a host adapter turns the answer into.
  return offending ? { status: 2, stderr: coachMessage(offending) } : { status: 0, stderr: '' };
};

/** @param {[string, string, string][]} cases [tool, key, value] */
function table(cases, expectStatus) {
  for (const [tool, key, value] of cases) {
    test(`${expectStatus === 2 ? 'blocks' : 'allows'} ${tool}: ${value}`, async () => {
      const r = await guard({ tool, input: { [key]: value } });
      assert.equal(r.status, expectStatus, r.stderr);
    });
  }
}

describe('the patch tool', () => {
  // A patch names its files in its text, so a guard that reads only a path field would let every patch through.
  const patch = (...lines) => ({ patchText: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') });
  test('blocks a patch that touches anything outside the reports directory, however many files it names', async () => {
    assert.equal((await guard({ tool: 'patch', input: patch('*** Update File: src/app.ts', '@@', '-a', '+b') })).status, 2);
    assert.equal((await guard({ tool: 'patch', input: patch('*** Add File: .claude/ops/reports/ok.md', '+x', '*** Delete File: .claude/team/project.md') })).status, 2);
    assert.equal((await guard({ tool: 'patch', input: patch('*** Update File: .claude/ops/reports/a.md', '*** Move to: src/moved.md') })).status, 2);
  });
  test('allows a patch that stays inside it', async () => {
    assert.equal((await guard({ tool: 'patch', input: patch('*** Add File: .claude/ops/reports/2026-10-12-agent-health.md', '+x') })).status, 0);
    assert.equal((await guard({ tool: 'patch', input: { patchText: '' } })).status, 0);
  });
});

describe('file tools', () => {
  table(
    [
      ['write', 'path', '.claude/team/project.md'],
      ['write', 'path', 'plugins/team-ops/agents/agent-coach.md'],
      ['edit', 'path', String.raw`C:\projects\acme\.claude\team\design.md`],
      ['edit', 'path', '/home/dev/acme/src/app.ts'],
      // The report directory is allowed; walking out of it is not.
      ['write', 'path', '.claude/ops/reports/../../team/project.md'],
      ['write', 'path', String.raw`.claude\ops\reports\..\..\team\project.md`],
      // A directory that merely resembles an allowed one.
      ['write', 'path', 'docs/not-tmp/notes.md'],
      ['write', 'path', '.claude/ops/reports-old/x.md'],
    ],
    2,
  );
  table(
    [
      ['write', 'path', '.claude/ops/reports/2026-10-12-agent-health.md'],
      ['write', 'path', String.raw`C:\projects\acme\.claude\ops\reports\TRENDS.md`],
      ['edit', 'path', '.claude/ops/reports/TRENDS.md'],
      ['write', 'path', '/tmp/coach/scratch.json'],
      ['write', 'path', String.raw`C:\Users\dev\AppData\Local\Temp\claude\C--projects-acme\1f2e\scratchpad\notes.txt`],
      // Reading is never gated.
      ['Read', 'path', '.claude/team/project.md'],
      ['Grep', 'pattern', 'friction'],
    ],
    0,
  );
});

describe('shell commands: writes outside the allowed places', () => {
  table(
    [
      // Redirects.
      ['shell', 'command', 'echo hi > .claude/team/project.md'],
      ['shell', 'command', 'cat notes >> agents/tech-lead.md'],
      ['shell', 'command', 'echo hi 2> src/errors.log'],
      ['shell', 'command', String.raw`"x" > .claude\team\design.md`],
      // File-modifying commands.
      ['shell', 'command', 'cp draft.md .claude/team/project.md'],
      ['shell', 'command', 'mv report.md plugins/x/report.md'],
      ['shell', 'command', 'rm -rf plugins/team-ops'],
      ['shell', 'command', "sed -i 's/a/b/' plugins/team-ops/agents/agent-coach.md"],
      ['shell', 'command', 'tee .claude/team/knowledge.md < notes.txt'],
      ['shell', 'command', 'touch src/new.ts'],
      ['shell', 'command', 'dd if=/dev/zero of=src/blob bs=1 count=1'],
      // The PowerShell equivalents. The coach runs on Windows too.
      ['shell', 'command', 'Set-Content .claude/team/project.md "x"'],
      ['shell', 'command', String.raw`"x" | Out-File -FilePath .claude\team\design.md`],
      ['shell', 'command', 'Add-Content -Path agents/qa.md -Value "line"'],
      ['shell', 'command', 'Remove-Item -Recurse -Force plugins/x'],
      ['shell', 'command', 'Copy-Item a.md .claude/team/project.md'],
      ['shell', 'command', String.raw`Set-Content C:\projects\acme\.claude\team\project.md -Value x`],
      ['shell', 'command', String.raw`Set-Content .claude\ops\reports\..\..\team\project.md x`],
      // A write hidden behind another shell.
      ['shell', 'command', 'bash -c "rm -rf plugins"'],
      ['shell', 'command', 'pwsh -NoProfile -Command "Set-Content agents/x.md y"'],
    ],
    2,
  );

  test('an allowed path elsewhere on the line does not excuse a write', async () => {
    // The old guard matched the allowlist against the whole command, so mentioning
    // /tmp/ or the reports directory anywhere let any write through.
    for (const command of [
      'cp draft.md .claude/team/project.md && ls /tmp/',
      'ls .claude/ops/reports/ && echo oops > .claude/team/project.md',
      'echo .claude/ops/reports/ > src/app.ts',
      'cp .claude/ops/reports/a.md .claude/team/project.md',
    ]) {
      const r = await guard({ tool: 'shell', input: { command } });
      assert.equal(r.status, 2, command);
    }
  });

  test('the block names the path and the way forward', async () => {
    const r = await guard({ tool: 'shell', input: { command: 'echo hi > .claude/team/project.md' } });
    assert.match(r.stderr, /\.claude\/team\/project\.md/);
    assert.match(r.stderr, /\.claude\/ops\/reports\//);
    assert.match(r.stderr, /propose-only/);
  });
});

describe('shell commands: what the coach legitimately does', () => {
  table(
    [
      // Reading and searching everything.
      ['shell', 'command', 'cat .claude/team/project.md'],
      ['shell', 'command', 'grep -rn "friction" ~/.claude/ops | head -20'],
      ['shell', 'command', 'git log --oneline --since=2026-09-01 -- .claude/'],
      ['shell', 'command', 'wc -l ~/.claude/ops/acme/events.jsonl'],
      ['shell', 'command', 'Get-Content $HOME/.claude/ops/acme/friction.jsonl | Select-Object -First 20'],
      ['shell', 'command', 'Get-ChildItem .claude/team 2>$null'],
      // The cost script, which writes nothing in the project.
      ['shell', 'command', 'node "$CLAUDE_PLUGIN_ROOT/scripts/cost.mjs" --json --since 2026-10-01'],
      // Discarded output.
      ['shell', 'command', 'git log --oneline > /dev/null 2>&1'],
      ['shell', 'command', 'git status 2>$null'],
      ['shell', 'command', 'git status > $null'],
      // Writing its report, by any route.
      ['shell', 'command', 'grep -c rejected events.jsonl > .claude/ops/reports/counts.txt'],
      ['shell', 'command', String.raw`Get-Content a.jsonl | Out-File .claude\ops\reports\o.md -Encoding utf8`],
      ['shell', 'command', 'Set-Content -Path .claude/ops/reports/o.md -Value "some text"'],
      ['shell', 'command', 'cp .claude/ops/reports/a.md /tmp/b.md'],
      ['shell', 'command', 'mkdir -p .claude/ops/reports'],
      // An arrow inside a quoted string is not a redirect.
      ['shell', 'command', 'echo "a -> b > c"'],
      ['shell', 'command', "grep 'x>y' notes.md"],
    ],
    0,
  );
});

describe('who is guarded', () => {
  test('only agent-coach', async () => {
    for (const agent of ['engineering-team/tech-lead', 'engineering-team/ic-generalist', 'design-team/product-lead', null]) {
      const r = await guard({ tool: 'write', input: { path: 'src/app.ts' }, agent });
      assert.equal(r.status, 0, String(agent));
    }
  });

  test('a bare agent name without the plugin namespace is guarded too', async () => {
    const r = await guard({ tool: 'write', input: { path: 'src/app.ts' }, agent: 'agent-coach' });
    assert.equal(r.status, 2);
  });
});

describe('failing safe', () => {
  test('a malformed call never blocks work', async () => {
    for (const input of [null, undefined, 'rm -rf x', [], 42, { command: 42 }, { path: null }]) {
      assert.equal((await guard({ tool: 'shell', input })).status, 0, JSON.stringify(input));
    }
    for (const call of [{}, { agent: COACH }, { tool: 'write' }]) {
      assert.equal((await guard({ tool: undefined, input: undefined, ...call })).status, 0, JSON.stringify(call));
    }
  });

  test('a coach call with no tool input is allowed', async () => {
    const r = await guard({ tool: 'shell', input: undefined });
    assert.equal(r.status, 0);
  });
});

describe('commands another plugin has wrapped', () => {
  // A plugin that shrinks or rewrites command output puts the real command behind a wrapper
  // before this guard runs, so the guard sees "node …/caveman shrink -- rm -rf x", not "rm -rf x".
  // Seen in a live run. The guard must judge the command that will actually run.
  const CAVEMAN = "'/opt/homebrew/bin/node' '/opt/homebrew/bin/caveman' shrink --";
  table(
    [
      ['shell', 'command', `${CAVEMAN} rm -rf .claude/team`],
      ['shell', 'command', `${CAVEMAN} cp draft.md .claude/team/project.md`],
      ['shell', 'command', `${CAVEMAN} echo hi > .claude/team/project.md`],
      ['shell', 'command', `${CAVEMAN} bash -c "echo x > src/a.ts"`],
      ['shell', 'command', 'rtk rm -rf .claude/team'],
      ['shell', 'command', 'rtk mv a.md agents/b.md'],
      ['shell', 'command', 'env FOO=1 mv a.md agents/b.md'],
      ['shell', 'command', 'time touch src/x.ts'],
      ['shell', 'command', 'nohup rm -rf .claude/team'],
      ['shell', 'command', 'rtk sudo rm -rf .claude/team'],
    ],
    2,
  );
  table(
    [
      ['shell', 'command', `${CAVEMAN} git log --oneline -5`],
      ['shell', 'command', `${CAVEMAN} cat notes.md`],
      ['shell', 'command', `${CAVEMAN} cp .claude/ops/reports/a.md .claude/ops/reports/b.md`],
      ['shell', 'command', 'rtk git status'],
      ['shell', 'command', 'rtk rm .claude/ops/reports/old.md'],
      ['shell', 'command', 'env FOO=1 ls -la'],
    ],
    0,
  );
});

describe('wrapper options that take a value', () => {
  // "env -u NAME rm -rf x": NAME is the option's value, not the command. Skipping only the flag
  // would judge "NAME" and never see the rm. Found in review.
  table(
    [
      ['shell', 'command', 'env -u NAME rm -rf .claude/team'],
      ['shell', 'command', 'env --unset NAME rm -rf .claude/team'],
      ['shell', 'command', 'env -C src rm -rf .claude/team'],
      ['shell', 'command', 'env --chdir src rm -rf .claude/team'],
      ['shell', 'command', 'env -i -u A -u B rm -rf .claude/team'],
      ['shell', 'command', 'time -o out.txt rm -rf .claude/team'],
      ['shell', 'command', 'time -f %e rm -rf .claude/team'],
      ['shell', 'command', 'exec -a tool rm -rf .claude/team'],
      ['shell', 'command', 'stdbuf -o L rm -rf .claude/team'],
      ['shell', 'command', 'stdbuf -i0 -o L -e0 rm -rf .claude/team'],
      ['shell', 'command', 'sudo -u root rm -rf .claude/team'],
      ['shell', 'command', 'sudo -u root -g wheel rm -rf .claude/team'],
      ['shell', 'command', 'sudo -E -H rm -rf .claude/team'],
      ['shell', 'command', 'rtk sudo -u root rm -rf .claude/team'],
      // env -S takes a whole command line.
      ['shell', 'command', 'env -S "rm -rf .claude/team"'],
      ['shell', 'command', 'env -i -S "cp a.md .claude/team/x.md"'],
    ],
    2,
  );
  table(
    [
      ['shell', 'command', 'env -u NAME ls -la'],
      ['shell', 'command', 'env -C src cat a.md'],
      ['shell', 'command', 'time -o out.txt git log --oneline -5'],
      ['shell', 'command', 'stdbuf -o L cat notes.md'],
      ['shell', 'command', 'sudo -u root cat notes.md'],
      ['shell', 'command', 'env -S "ls -la"'],
      ['shell', 'command', 'env -u NAME rm .claude/ops/reports/old.md'],
      ['shell', 'command', 'sudo -u root rm .claude/ops/reports/old.md'],
    ],
    0,
  );
});
