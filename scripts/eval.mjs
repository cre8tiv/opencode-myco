#!/usr/bin/env node
// Behavior evals: runs each case against a real model in OpenCode and grades what the agents did.
//
//   node scripts/eval.mjs [--case <text>[,<text>...]] [--tag <tag>] [--runs <n>] [--model <ref>] [--judge-model <ref>]
//                         [--fail-under <0..1>] [--keep] [--list]
//
// A run is a throwaway git repository: the case's scaffold, the teams installed into it (--project), a
// permission file denying what the case doesn't allow, and `opencode run` with the case's prompt. What the run
// did is read from OpenCode's own session records, the top-level agent's and every dispatched agent's, and
// graded: tool_used and regex deterministically, llm by a judge model given the grader's rubric.
//
// It uses your OpenCode as it is configured (your model credentials), starts a private server per run
// (--standalone), and deletes the sessions it made. It calls a real model, so it costs money and is noisy:
// run a case or two while iterating, and set --model to something cheap. Nothing here runs in CI.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './install.mjs';
import { dispatchesOf, execOpencode } from '../plugins/team-ops/scripts/usage-opencode.mjs';
import { caseDirs, grade, loadCase, observe, permissionFor, verdictOf } from './eval-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVALS = join(ROOT, 'evals');

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[argv[i].slice(2)] = true;
    else {
      o[argv[i].slice(2)] = v;
      i++;
    }
  }
  return o;
}

/** @param {string[]} args @param {string} cwd @param {number} ms @returns {any} the parsed JSON an `opencode api` call printed */
function api(args, cwd, ms = 60000) {
  const r = execOpencode(['api', '--standalone', ...args], cwd, ms);
  if (r.status !== 0) throw new Error(`opencode api ${args.join(' ')}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return JSON.parse(r.stdout);
}
const dataOf = (v) => (Array.isArray(v) ? v : v?.data ?? []);

/** @param {string} stdout `opencode run --format json` output @returns {{sessionID?: string, text: string}} */
function readStream(stdout) {
  let sessionID;
  const text = [];
  for (const line of stdout.split('\n')) {
    try {
      const e = JSON.parse(line);
      sessionID ||= e.sessionID;
      if (e.type === 'text' && e.part?.text) text.push(e.part.text);
    } catch {
      // Not an event line.
    }
  }
  return { sessionID, text: text.join('\n') };
}

/** Deletes the sessions of a run; a failure to is reported, not fatal. @param {string[]} ids @param {string} cwd */
function deleteSessions(ids, cwd) {
  for (const id of ids) {
    const r = execOpencode(['session', 'delete', id], cwd);
    if (r.status !== 0) console.error(`  could not delete session ${id}: ${(r.stderr || r.stdout).trim().slice(0, 100)}`);
  }
}

/**
 * A judge: asks a model whether a response meets a rubric, in an empty directory with nothing it may use.
 * @param {string} model @returns {(rubric: string, response: string) => Promise<{pass: boolean, reason: string}>}
 */
function judgeWith(model) {
  return async (rubric, response) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'myco-eval-judge-')));
    try {
      writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ permission: permissionFor([]) }));
      const prompt = `You grade one response against a rubric. Answer with PASS or FAIL as the first word, then one sentence of reason. Nothing else.\n\nRUBRIC:\n${rubric}\n\nRESPONSE TO GRADE:\n${response}`;
      const r = execOpencode(['run', '--standalone', '--auto', '--format', 'json', '--model', model, prompt], dir, 300000);
      const { sessionID, text } = readStream(r.stdout);
      if (sessionID) deleteSessions([sessionID], dir);
      return verdictOf(text);
    } finally {
      cleanup(dir);
    }
  };
}

/** Removes a directory this runner made, and only one it made. @param {string} dir */
function cleanup(dir) {
  if (basename(dir).startsWith('myco-eval-') && dirname(dir) === realpathSync(tmpdir())) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/** @param {string} cwd @param {string[]} args */
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=eval@example.com', '-c', 'user.name=eval', ...args], { cwd, encoding: 'utf8' });

/**
 * One run of a case: build the repository, run the prompt, read what happened.
 * @param {import('./eval-lib.mjs').Case} c
 * @param {{model: string, keep: boolean}} o
 * @returns {{obs: import('./eval-lib.mjs').Observed, error?: string, dir?: string}}
 */
function runCase(c, o) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'myco-eval-')));
  try {
    if (c.scaffold) {
      const r = spawnSync('bash', [c.scaffold], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) return { obs: observe([]), error: `scaffold failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
    }
    if (git(dir, 'rev-parse', '--git-dir').status !== 0) git(dir, 'init', '-q', '-b', 'main');
    install({ target: join(dir, '.opencode'), models: { tiers: { lead: o.model, reasoning: o.model, worker: o.model } } });
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ permission: permissionFor(c.tools) }));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'eval scaffold');

    const r = execOpencode(['run', '--standalone', '--auto', '--format', 'json', '--model', o.model, c.prompt], dir, c.timeoutMs);
    // The run names its own session in its output; the agents it dispatched are named in its tool calls. (Listing
    // sessions by directory finds none under a symlinked temp path, as macOS has.)
    const { sessionID } = readStream(r.stdout);
    if (!sessionID) return { obs: observe([]), error: `the run left no session${r.status === null ? ' (it timed out)' : ''}: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
    /** @type {{info: any, messages: any[]}[]} */
    const loaded = [];
    const made = [];
    try {
      /** @param {string} id */
      const load = (id) => {
        made.push(id);
        const messages = dataOf(api(['GET', `/api/session/${id}/context`], dir));
        loaded.push({ info: {}, messages });
        for (const d of dispatchesOf(messages)) if (!made.includes(d.sessionID)) load(d.sessionID);
      };
      load(sessionID);
    } finally {
      deleteSessions(made, dir);
    }
    return { obs: observe(loaded), dir: o.keep ? dir : undefined };
  } finally {
    if (!o.keep) cleanup(dir);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = caseDirs(EVALS)
    .map((d) => loadCase(d, EVALS))
    .filter((c) => (typeof opts.case !== 'string' || opts.case.split(',').some((t) => t && c.name.includes(t.trim()))) && (typeof opts.tag !== 'string' || c.tags.includes(opts.tag)));
  if (opts.list) {
    for (const c of cases) console.log(`${c.name}  [${c.tags.join(', ')}]  ${c.graders.length} grader(s)`);
    return;
  }
  if (!cases.length) {
    console.error('No case matches.');
    process.exit(2);
  }
  const model = typeof opts.model === 'string' ? opts.model : 'openrouter/anthropic/claude-haiku-5.5';
  const judge = judgeWith(typeof opts['judge-model'] === 'string' ? opts['judge-model'] : model);
  const runs = Math.max(1, Number(opts.runs) || 1);
  const floor = Number(opts['fail-under']) || 0;
  console.log(`Model ${model}; ${cases.length} case(s), ${runs} run(s) each.\n`);

  let low = false;
  for (const c of cases) {
    /** @type {number[]} */
    const scores = [];
    /** @type {string[]} */
    const notes = [];
    for (let i = 1; i <= runs; i++) {
      const res = runCase(c, { model, keep: opts.keep === true });
      if (res.error) {
        scores.push(0);
        notes.push(`run ${i}: ${res.error}`);
        continue;
      }
      let passed = 0;
      for (const g of c.graders) {
        const v = await grade(g, res.obs, judge);
        if (v.pass) passed++;
        else notes.push(`run ${i}: ${g.file} failed: ${v.reason}`);
      }
      scores.push(c.graders.length ? passed / c.graders.length : 0);
      if (res.dir) notes.push(`run ${i}: kept ${res.dir}`);
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (mean < floor) low = true;
    console.log(`${mean.toFixed(2)}  ${c.name}  (${scores.map((s) => s.toFixed(2)).join(' ')})`);
    for (const n of notes) console.log(`      ${n}`);
  }
  if (low) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
