// agent-coach is propose-only: it may write its report and scratch files, and nothing
// else. These tests cover the ways an agent could write elsewhere, by accident or by
// habit, and the things the coach legitimately does that must keep working.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coachViolation, coachMessage } from '../plugins/team-ops/scripts/coach-guard-core.mjs';

const COACH = 'team-ops:agent-coach';

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

describe('file tools', () => {
  table(
    [
      ['Write', 'file_path', '.claude/team/project.md'],
      ['Write', 'file_path', 'plugins/team-ops/agents/agent-coach.md'],
      ['Edit', 'file_path', String.raw`C:\projects\acme\.claude\team\design.md`],
      ['Edit', 'file_path', '/home/dev/acme/src/app.ts'],
      ['NotebookEdit', 'notebook_path', 'analysis.ipynb'],
      // The report directory is allowed; walking out of it is not.
      ['Write', 'file_path', '.claude/ops/reports/../../team/project.md'],
      ['Write', 'file_path', String.raw`.claude\ops\reports\..\..\team\project.md`],
      // A directory that merely resembles an allowed one.
      ['Write', 'file_path', 'docs/not-tmp/notes.md'],
      ['Write', 'file_path', '.claude/ops/reports-old/x.md'],
    ],
    2,
  );
  table(
    [
      ['Write', 'file_path', '.claude/ops/reports/2026-10-12-agent-health.md'],
      ['Write', 'file_path', String.raw`C:\projects\acme\.claude\ops\reports\TRENDS.md`],
      ['Edit', 'file_path', '.claude/ops/reports/TRENDS.md'],
      ['Write', 'file_path', '/tmp/coach/scratch.json'],
      ['Write', 'file_path', String.raw`C:\Users\dev\AppData\Local\Temp\claude\C--projects-acme\1f2e\scratchpad\notes.txt`],
      // Reading is never gated.
      ['Read', 'file_path', '.claude/team/project.md'],
      ['Grep', 'pattern', 'friction'],
    ],
    0,
  );
});

describe('shell commands: writes outside the allowed places', () => {
  table(
    [
      // Redirects.
      ['Bash', 'command', 'echo hi > .claude/team/project.md'],
      ['Bash', 'command', 'cat notes >> agents/tech-lead.md'],
      ['Bash', 'command', 'echo hi 2> src/errors.log'],
      ['PowerShell', 'command', String.raw`"x" > .claude\team\design.md`],
      // File-modifying commands.
      ['Bash', 'command', 'cp draft.md .claude/team/project.md'],
      ['Bash', 'command', 'mv report.md plugins/x/report.md'],
      ['Bash', 'command', 'rm -rf plugins/team-ops'],
      ['Bash', 'command', "sed -i 's/a/b/' plugins/team-ops/agents/agent-coach.md"],
      ['Bash', 'command', 'tee .claude/team/knowledge.md < notes.txt'],
      ['Bash', 'command', 'touch src/new.ts'],
      ['Bash', 'command', 'dd if=/dev/zero of=src/blob bs=1 count=1'],
      // The PowerShell equivalents. The coach runs on Windows too.
      ['PowerShell', 'command', 'Set-Content .claude/team/project.md "x"'],
      ['PowerShell', 'command', String.raw`"x" | Out-File -FilePath .claude\team\design.md`],
      ['PowerShell', 'command', 'Add-Content -Path agents/qa.md -Value "line"'],
      ['PowerShell', 'command', 'Remove-Item -Recurse -Force plugins/x'],
      ['PowerShell', 'command', 'Copy-Item a.md .claude/team/project.md'],
      ['PowerShell', 'command', String.raw`Set-Content C:\projects\acme\.claude\team\project.md -Value x`],
      ['PowerShell', 'command', String.raw`Set-Content .claude\ops\reports\..\..\team\project.md x`],
      // A write hidden behind another shell.
      ['Bash', 'command', 'bash -c "rm -rf plugins"'],
      ['PowerShell', 'command', 'pwsh -NoProfile -Command "Set-Content agents/x.md y"'],
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
      const r = await guard({ tool: 'Bash', input: { command } });
      assert.equal(r.status, 2, command);
    }
  });

  test('the block names the path and the way forward', async () => {
    const r = await guard({ tool: 'Bash', input: { command: 'echo hi > .claude/team/project.md' } });
    assert.match(r.stderr, /\.claude\/team\/project\.md/);
    assert.match(r.stderr, /\.claude\/ops\/reports\//);
    assert.match(r.stderr, /propose-only/);
  });
});

describe('shell commands: what the coach legitimately does', () => {
  table(
    [
      // Reading and searching everything.
      ['Bash', 'command', 'cat .claude/team/project.md'],
      ['Bash', 'command', 'grep -rn "friction" ~/.claude/ops | head -20'],
      ['Bash', 'command', 'git log --oneline --since=2026-09-01 -- .claude/'],
      ['Bash', 'command', 'wc -l ~/.claude/ops/acme/events.jsonl'],
      ['PowerShell', 'command', 'Get-Content $HOME/.claude/ops/acme/friction.jsonl | Select-Object -First 20'],
      ['PowerShell', 'command', 'Get-ChildItem .claude/team 2>$null'],
      // The cost script, which writes nothing in the project.
      ['Bash', 'command', 'node "$CLAUDE_PLUGIN_ROOT/scripts/cost.mjs" --json --since 2026-10-01'],
      // Discarded output.
      ['Bash', 'command', 'git log --oneline > /dev/null 2>&1'],
      ['PowerShell', 'command', 'git status 2>$null'],
      ['PowerShell', 'command', 'git status > $null'],
      // Writing its report, by any route.
      ['Bash', 'command', 'grep -c rejected events.jsonl > .claude/ops/reports/counts.txt'],
      ['PowerShell', 'command', String.raw`Get-Content a.jsonl | Out-File .claude\ops\reports\o.md -Encoding utf8`],
      ['PowerShell', 'command', 'Set-Content -Path .claude/ops/reports/o.md -Value "some text"'],
      ['Bash', 'command', 'cp .claude/ops/reports/a.md /tmp/b.md'],
      ['Bash', 'command', 'mkdir -p .claude/ops/reports'],
      // An arrow inside a quoted string is not a redirect.
      ['Bash', 'command', 'echo "a -> b > c"'],
      ['Bash', 'command', "grep 'x>y' notes.md"],
    ],
    0,
  );
});

describe('who is guarded', () => {
  test('only agent-coach', async () => {
    for (const agent of ['engineering-team:tech-lead', 'engineering-team:ic-generalist', 'design-team:product-lead', null]) {
      const r = await guard({ tool: 'Write', input: { file_path: 'src/app.ts' }, agent });
      assert.equal(r.status, 0, String(agent));
    }
  });

  test('a bare agent name without the plugin namespace is guarded too', async () => {
    const r = await guard({ tool: 'Write', input: { file_path: 'src/app.ts' }, agent: 'agent-coach' });
    assert.equal(r.status, 2);
  });
});

describe('failing safe', () => {
  test('a malformed call never blocks work', async () => {
    for (const input of [null, undefined, 'rm -rf x', [], 42, { command: 42 }, { file_path: null }]) {
      assert.equal((await guard({ tool: 'Bash', input })).status, 0, JSON.stringify(input));
    }
    for (const call of [{}, { agent: COACH }, { tool: 'Write' }]) {
      assert.equal((await guard({ tool: undefined, input: undefined, ...call })).status, 0, JSON.stringify(call));
    }
  });

  test('a coach call with no tool input is allowed', async () => {
    const r = await guard({ tool: 'Bash', input: undefined });
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
      ['Bash', 'command', `${CAVEMAN} rm -rf .claude/team`],
      ['Bash', 'command', `${CAVEMAN} cp draft.md .claude/team/project.md`],
      ['Bash', 'command', `${CAVEMAN} echo hi > .claude/team/project.md`],
      ['Bash', 'command', `${CAVEMAN} bash -c "echo x > src/a.ts"`],
      ['Bash', 'command', 'rtk rm -rf .claude/team'],
      ['Bash', 'command', 'rtk mv a.md agents/b.md'],
      ['Bash', 'command', 'env FOO=1 mv a.md agents/b.md'],
      ['Bash', 'command', 'time touch src/x.ts'],
      ['Bash', 'command', 'nohup rm -rf .claude/team'],
      ['Bash', 'command', 'rtk sudo rm -rf .claude/team'],
    ],
    2,
  );
  table(
    [
      ['Bash', 'command', `${CAVEMAN} git log --oneline -5`],
      ['Bash', 'command', `${CAVEMAN} cat notes.md`],
      ['Bash', 'command', `${CAVEMAN} cp .claude/ops/reports/a.md .claude/ops/reports/b.md`],
      ['Bash', 'command', 'rtk git status'],
      ['Bash', 'command', 'rtk rm .claude/ops/reports/old.md'],
      ['Bash', 'command', 'env FOO=1 ls -la'],
    ],
    0,
  );
});

describe('wrapper options that take a value', () => {
  // "env -u NAME rm -rf x": NAME is the option's value, not the command. Skipping only the flag
  // would judge "NAME" and never see the rm. Found in review.
  table(
    [
      ['Bash', 'command', 'env -u NAME rm -rf .claude/team'],
      ['Bash', 'command', 'env --unset NAME rm -rf .claude/team'],
      ['Bash', 'command', 'env -C src rm -rf .claude/team'],
      ['Bash', 'command', 'env --chdir src rm -rf .claude/team'],
      ['Bash', 'command', 'env -i -u A -u B rm -rf .claude/team'],
      ['Bash', 'command', 'time -o out.txt rm -rf .claude/team'],
      ['Bash', 'command', 'time -f %e rm -rf .claude/team'],
      ['Bash', 'command', 'exec -a tool rm -rf .claude/team'],
      ['Bash', 'command', 'stdbuf -o L rm -rf .claude/team'],
      ['Bash', 'command', 'stdbuf -i0 -o L -e0 rm -rf .claude/team'],
      ['Bash', 'command', 'sudo -u root rm -rf .claude/team'],
      ['Bash', 'command', 'sudo -u root -g wheel rm -rf .claude/team'],
      ['Bash', 'command', 'sudo -E -H rm -rf .claude/team'],
      ['Bash', 'command', 'rtk sudo -u root rm -rf .claude/team'],
      // env -S takes a whole command line.
      ['Bash', 'command', 'env -S "rm -rf .claude/team"'],
      ['Bash', 'command', 'env -i -S "cp a.md .claude/team/x.md"'],
    ],
    2,
  );
  table(
    [
      ['Bash', 'command', 'env -u NAME ls -la'],
      ['Bash', 'command', 'env -C src cat a.md'],
      ['Bash', 'command', 'time -o out.txt git log --oneline -5'],
      ['Bash', 'command', 'stdbuf -o L cat notes.md'],
      ['Bash', 'command', 'sudo -u root cat notes.md'],
      ['Bash', 'command', 'env -S "ls -la"'],
      ['Bash', 'command', 'env -u NAME rm .claude/ops/reports/old.md'],
      ['Bash', 'command', 'sudo -u root rm .claude/ops/reports/old.md'],
    ],
    0,
  );
});
