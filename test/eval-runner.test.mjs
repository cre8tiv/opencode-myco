// The eval runner without a model: reading what a run did from session records and grading it, then the
// whole runner against a stand-in `opencode` that answers with canned sessions.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, runNode, ROOT } from './helpers.mjs';
import { frontmatter, list, observe, grade, permissionFor, verdictOf } from '../scripts/eval-lib.mjs';

const assistant = (content) => ({ type: 'assistant', content });
const tool = (name, input) => ({ type: 'tool', name, state: { input } });
const text = (t) => ({ type: 'text', text: t });
const noJudge = async () => assert.fail('no model should be asked');

describe('reading a case', () => {
  test('frontmatter and inline lists', () => {
    const fm = frontmatter("---\ndescription: x\ntools: [read, 'glob', \"skill\"]\ninput_match: '\"id\"\\s*:'\n---\nbody");
    assert.deepEqual(list(fm.tools), ['read', 'glob', 'skill']);
    assert.equal(fm.input_match, '"id"\\s*:');
    assert.deepEqual(list(undefined), []);
  });

  test('a case denies what it does not allow: shell, file changes and the network', () => {
    assert.deepEqual(permissionFor(['read', 'skill']), { shell: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny' });
    assert.deepEqual(permissionFor(['read', 'edit']), { shell: 'deny', webfetch: 'deny', websearch: 'deny' });
    assert.deepEqual(permissionFor(['write', 'shell', 'webfetch', 'websearch']), {});
  });
});

describe('what a run did', () => {
  const lead = { info: {}, messages: [{ type: 'user', content: [] }, assistant([tool('skill', { id: 'cost-report' }), text('first')]), assistant([text('the answer')])] };
  const child = { info: { parentID: 'x' }, messages: [assistant([tool('write', { path: 'docs/a.md' }), text('child words')])] };

  test('tool calls come from every agent in the run; what was said, from the top-level one only', () => {
    const o = observe([lead, child]);
    assert.deepEqual(o.tools.map((t) => t.name), ['skill', 'write']);
    assert.equal(o.tools[0].input, '{"id":"cost-report"}');
    assert.equal(o.text, 'first\nthe answer');
    assert.equal(o.final, 'the answer');
  });

  test('a run with no sessions did nothing', () => {
    assert.deepEqual(observe([]), { tools: [], text: '', final: '' });
  });
});

describe('grading', () => {
  const obs = observe([{ messages: [assistant([tool('skill', { id: 'cost-report' }), tool('start_work', { tag: 'x/round-2' }), tool('subagent', { agent: 'engineering-team/code-reviewer' }), text('Verdict: Request changes')])] }]);
  const g = (o) => grade({ file: 'g.md', text: '', ...o }, obs, noJudge);

  test('tool_used matches the tool name whole, and its input', async () => {
    assert.equal((await g({ type: 'tool_used', tool: 'skill', input_match: '"id"\\s*:\\s*"cost-report"' })).pass, true);
    assert.equal((await g({ type: 'tool_used', tool: 'skill', input_match: '"id"\\s*:\\s*"log-friction"' })).pass, false);
    assert.equal((await g({ type: 'tool_used', tool: 'subagent|delegate', input_match: 'code-reviewer' })).pass, true);
    assert.equal((await g({ type: 'tool_used', tool: 'sub' })).pass, false, 'a part of a name is not the name');
  });

  test('min and max count calls; max 0 means it must not fire', async () => {
    assert.equal((await g({ type: 'tool_used', tool: 'skill|start_work', min: '0', max: '0' })).pass, false);
    assert.equal((await g({ type: 'tool_used', tool: 'edit', min: '0', max: '0' })).pass, true);
    assert.equal((await g({ type: 'tool_used', tool: 'skill|start_work', min: '2' })).pass, true);
    assert.equal((await g({ type: 'tool_used', tool: 'skill|start_work', min: '3' })).pass, false);
  });

  test('regex reads what the agent said', async () => {
    assert.equal((await g({ type: 'regex', pattern: 'request(ed)? changes', flags: 'i' })).pass, true);
    assert.equal((await g({ type: 'regex', pattern: 'approve' })).pass, false);
  });

  test('llm asks the judge with the rubric and the final message', async () => {
    let seen;
    const v = await grade({ file: 'g.md', type: 'llm', text: 'PASS if X' }, obs, async (r, resp) => ((seen = [r, resp]), { pass: true, reason: 'ok' }));
    assert.deepEqual(seen, ['PASS if X', 'Verdict: Request changes']);
    assert.equal(v.pass, true);
  });

  test('an unknown grader type fails rather than passing silently', async () => {
    assert.equal((await g({ type: 'file_exists' })).pass, false);
  });

  test('the judge must answer PASS or FAIL first', () => {
    assert.deepEqual(verdictOf('PASS: names the injection'), { pass: true, reason: 'names the injection' });
    assert.equal(verdictOf('fail - missed it').pass, false);
    assert.match(verdictOf('Looks good to me').reason, /did not answer/);
    assert.equal(verdictOf('').pass, false);
  });
});

describe('the runner, against a stand-in opencode', () => {
  /** A stand-in that logs how it was called and answers from canned sessions. */
  function standIn(sb, { sessions, contexts, judge = 'PASS fine' }) {
    const log = join(sb.root, 'calls.jsonl');
    const db = join(sb.root, 'db.json');
    const script = join(sb.root, 'opencode-stand-in.mjs');
    writeFileSync(db, JSON.stringify({ sessions, contexts }));
    writeFileSync(script, `
import { appendFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
const args = process.argv.slice(2);
const db = JSON.parse(readFileSync(${JSON.stringify(db)}, 'utf8'));
const note = (o) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(o) + '\\n');
if (args[0] === 'run') {
  const prompt = args.at(-1);
  const judging = prompt.includes('RUBRIC');
  note({ run: true, judging, pwd: process.env.PWD, model: args[args.indexOf('--model') + 1], cwd: process.cwd(), agents: existsSync('.opencode/agents') ? readdirSync('.opencode/agents').sort() : [], config: existsSync('opencode.json') ? readFileSync('opencode.json', 'utf8') : null, prompt: judging ? '(judge)' : prompt });
  if (judging) console.log(JSON.stringify({ type: 'text', sessionID: 'ses_judge', part: { text: ${JSON.stringify(judge)} } }));
  else if (db.sessions.length) console.log(JSON.stringify({ type: 'step_start', sessionID: db.sessions[0].id }));
  process.exit(0);
}
if (args[0] === 'session') { note({ deleted: args[2] }); process.exit(0); }
const path = args.at(-1);
const lastRun = () => readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').map((l) => JSON.parse(l)).filter((c) => c.run && !c.judging).at(-1);
if (path.startsWith('/api/session/') && path.split('/').length === 4) console.log(JSON.stringify({ data: { id: path.split('/')[3], location: { directory: process.env.STAND_IN_WHERE || lastRun().cwd } } }));
else if (path.startsWith('/api/session/') && path.endsWith('/context')) console.log(JSON.stringify({ data: db.contexts[path.split('/')[3]] || [] }));
else { console.error('stand-in: no route ' + path); process.exit(1); }
`);
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { script, calls };
  }
  const evalRun = (sb, script, args) => runNode(join(ROOT, 'scripts', 'eval.mjs'), { args, cwd: sb.project, env: { ...sb.env, MYCO_OPENCODE: script } });

  test('builds a repository with the teams and the case\'s limits, runs the prompt on the model, grades, and cleans up', async (t) => {
    const sb = sandbox(t);
    const { script, calls } = standIn(sb, { sessions: [{ id: 'ses_a' }], contexts: { ses_a: [assistant([tool('skill', { id: 'cost-report' }), text('It cost a little.')])] } });
    const r = await evalRun(sb, script, ['--case', 'cost-report-fires', '--model', 'p/m']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^1\.00 {2}team-ops\/cost-report-fires/m);
    const run = calls().find((c) => c.run);
    assert.equal(run.model, 'p/m');
    assert.equal(run.pwd, run.cwd, '$PWD names the repository, or OpenCode would work in the directory the runner was started from');
    assert.match(run.prompt, /order-exceptions design package/);
    assert.ok(run.agents.includes('engineering-team') && run.agents.includes('team-ops'), 'the teams were installed into the repository');
    assert.deepEqual(JSON.parse(run.config).permission, { shell: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny' });
    assert.deepEqual(calls().filter((c) => c.deleted).map((c) => c.deleted), ['ses_a'], 'the run\'s session was deleted');
    assert.equal(existsSync(run.cwd), false, 'the throwaway repository was removed');
  });

  test('a failing grader lowers the score and says which and why', async (t) => {
    const sb = sandbox(t);
    const { script } = standIn(sb, { sessions: [{ id: 'ses_a' }], contexts: { ses_a: [assistant([text('no skill used')])] } });
    const r = await evalRun(sb, script, ['--case', 'cost-report-fires']);
    assert.match(r.stdout, /^0\.00 {2}team-ops\/cost-report-fires/m);
    assert.match(r.stdout, /skill-fired\.md failed: skill \/.*cost-report.*\/ used 0 time\(s\)/);
  });

  test('an llm grader goes to the judge, which gets its own model and leaves no session behind', async (t) => {
    const sb = sandbox(t);
    const { script, calls } = standIn(sb, {
      sessions: [{ id: 'ses_a' }],
      contexts: { ses_a: [assistant([tool('subagent', { agent: 'engineering-team/code-reviewer' }), text('Request changes: SQL injection in searchOrders')])] },
      judge: 'FAIL it is only a style note',
    });
    const r = await evalRun(sb, script, ['--case', 'review-catches-sql-injection', '--judge-model', 'j/m']);
    assert.match(r.stdout, /finding\.md failed: it is only a style note/);
    assert.equal(calls().find((c) => c.judging).model, 'j/m');
    assert.ok(calls().some((c) => c.deleted === 'ses_judge'));
  });

  test('agents the run dispatched are read and deleted too, by the id its tool call names', async (t) => {
    const sb = sandbox(t);
    const dispatch = { type: 'tool', name: 'subagent', state: { input: { agent: 'design-team/security-reviewer' }, metadata: { sessionID: 'ses_child' } } };
    const { script, calls } = standIn(sb, {
      sessions: [{ id: 'ses_a' }],
      contexts: { ses_a: [assistant([dispatch, text('done')])], ses_child: [assistant([tool('write', { path: 'docs/design/order-export/security-review.md' })])] },
    });
    const r = await evalRun(sb, script, ['--case', 'security-reviewer-finds-seeded-gaps']);
    assert.deepEqual(calls().filter((c) => c.deleted && c.deleted !== 'ses_judge').map((c) => c.deleted).sort(), ['ses_a', 'ses_child']);
    assert.doesNotMatch(r.stdout, /(wrote-review|dispatched)\.md failed/, 'the dispatch, and the dispatched agent\'s write, count');
  });

  test('a run that worked somewhere other than its own repository is not graded', async (t) => {
    const sb = sandbox(t);
    const { script, calls } = standIn(sb, { sessions: [{ id: 'ses_a' }], contexts: { ses_a: [assistant([tool('skill', { id: 'cost-report' })])] } });
    const r = await runNode(join(ROOT, 'scripts', 'eval.mjs'), { args: ['--case', 'cost-report-fires'], cwd: sb.project, env: { ...sb.env, MYCO_OPENCODE: script, STAND_IN_WHERE: sb.project } });
    assert.match(r.stdout, /^0\.00 {2}team-ops\/cost-report-fires/m);
    assert.match(r.stdout, /not in its repository/);
    assert.deepEqual(calls().filter((c) => c.deleted).map((c) => c.deleted), ['ses_a'], 'its session is still deleted');
  });

  test('a run that leaves no session is a zero with the reason, and --fail-under makes it a failing exit', async (t) => {
    const sb = sandbox(t);
    const { script } = standIn(sb, { sessions: [], contexts: {} });
    const r = await evalRun(sb, script, ['--case', 'cost-report-fires', '--fail-under', '0.5']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /the run left no session/);
  });

  test('--case takes several, comma-separated', async (t) => {
    const sb = sandbox(t);
    const { script } = standIn(sb, { sessions: [], contexts: {} });
    const r = await evalRun(sb, script, ['--list', '--case', 'cost-report-fires,log-friction-fires']);
    assert.match(r.stdout, /cost-report-fires/);
    assert.match(r.stdout, /log-friction-fires/);
    assert.doesNotMatch(r.stdout, /start-work-fires/);
  });

  test('--list shows the cases without running anything', async (t) => {
    const sb = sandbox(t);
    const { script, calls } = standIn(sb, { sessions: [], contexts: {} });
    const r = await evalRun(sb, script, ['--list', '--tag', 'negative']);
    assert.match(r.stdout, /product-bug-skips-log-friction/);
    assert.doesNotMatch(r.stdout, /cost-report-fires/);
    assert.deepEqual(calls(), []);
  });
});
