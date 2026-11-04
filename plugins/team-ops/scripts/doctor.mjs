#!/usr/bin/env node
// Checks that the myco teams are installed and actually working under OpenCode.
//
//   node doctor.mjs [--cwd <project>] [--no-live] [--json]
//
// Several things fail silently. OpenCode logs a single warning and carries on if the plugin
// fails to load; if one of the plugin's cores fails to load, the plugin still loads and that
// guard or recorder is simply absent; a project install is invisible from a git worktree. In
// each case the agents run, unprotected, and nothing says so. This looks for those, and for
// the quieter problems: a missing agent, a stream that can't be written, a model mapping likely
// to go wrong, a project that allows merging next to an install that forbids it.
//
// Run it from the project you work in. The live checks start OpenCode in that directory, so
// they test what an agent there would get: they ask which agents it can see, and what a
// command run in a session reports about the plugin. They leave nothing behind (the session
// they open is deleted). --no-live skips them. Exit status 1 means something is broken;
// warnings leave it at 0.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MAP, checkModels, readCatalog, warnings } from './models.mjs';
import { profileKey } from './profile.mjs';
import { streamDir, resolveStreamName } from './stream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The files the plugin installs as (<config>/plugins/myco/). A test keeps this equal to the source. */
export const PLUGIN_FILES = ['capture.js', 'core.js', 'guards.js', 'index.js', 'tools.js', 'work.js'];
/** The decision code the plugin loads from the install; without one, its feature silently does not exist. */
export const CORES = [
  ['team-ops', 'coach-guard-core.mjs'],
  ['team-ops', 'capture-core.mjs'],
  ['team-ops', 'friction-core.mjs'],
  ['engineering-team', 'merge-gate-core.mjs'],
];
/** What a plugin that loaded completely reports through MYCO_FEATURES. A test keeps this in step with the plugin. */
export const FEATURES = ['capture', 'coach-guard', 'merge-gate', 'start_work', 'log_friction'];
const FEATURE_CORE = { capture: 'capture-core.mjs', 'coach-guard': 'coach-guard-core.mjs', 'merge-gate': 'merge-gate-core.mjs', log_friction: 'friction-core.mjs' };

/** @typedef {{level: 'ok' | 'info' | 'warn' | 'fail', area: string, message: string, fix?: string}} Result */

/** @param {Result['level']} level @param {string} area @param {string} message @param {string} [fix] @returns {Result} */
const r = (level, area, message, fix) => ({ level, area, message, ...(fix ? { fix } : {}) });

const REINSTALL = 'Reinstall: node scripts/install.mjs --global (from the myco checkout).';

/** @param {string} p @returns {any | null} */
function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** The frontmatter of an installed agent file, or '' */
const frontmatterOf = (file) => (readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';

/**
 * What is on disk: the agents, skills, plugin and cores, and whether the agents carry the merge backstop the
 * install says they should.
 * @param {{root: string}} p root is <config>/myco
 * @returns {Result[]}
 */
export function checkInstall({ root }) {
  const config = join(root, '..');
  const out = [];
  const install = readJson(join(root, 'install.json'));
  if (install) {
    out.push(r('ok', 'install', `${Object.entries(install.teams || {}).map(([t, v]) => `${t} ${v}`).join(', ')}; installed ${String(install.installedAt).slice(0, 10)}`));
  } else {
    out.push(r('warn', 'install', 'no install.json: this was installed by an older installer, so what it should contain is not known', REINSTALL));
  }

  const missingAgents = Object.keys(AGENT_MAP).filter((id) => !existsSync(join(config, 'agents', `${id}.md`)));
  out.push(missingAgents.length
    ? r('fail', 'agents', `${missingAgents.length} of ${Object.keys(AGENT_MAP).length} agents are not installed: ${missingAgents.join(', ')}`, REINSTALL)
    : r('ok', 'agents', `all ${Object.keys(AGENT_MAP).length} installed`));

  const missingSkills = (install?.skills || []).filter((s) => !existsSync(join(config, 'skills', s, 'SKILL.md')));
  if (install) out.push(missingSkills.length ? r('fail', 'skills', `missing: ${missingSkills.join(', ')}`, REINSTALL) : r('ok', 'skills', `all ${(install.skills || []).length} installed`));

  const missingPlugin = PLUGIN_FILES.filter((f) => !existsSync(join(config, 'plugins', 'myco', f)));
  out.push(missingPlugin.length ? r('fail', 'plugin', `files missing from plugins/myco: ${missingPlugin.join(', ')}`, REINSTALL) : r('ok', 'plugin', 'files present'));

  const missingCores = CORES.filter(([team, file]) => !existsSync(join(root, team, 'scripts', file)));
  out.push(missingCores.length
    ? r('fail', 'cores', `missing, so the feature each provides does not exist: ${missingCores.map(([t, f]) => `${t}/${f}`).join(', ')}`, REINSTALL)
    : r('ok', 'cores', 'guards, capture and friction code present'));

  // The merge backstop: a native deny for `gh pr merge` in every agent, unless the install allows autonomous merging.
  const present = Object.keys(AGENT_MAP).filter((id) => existsSync(join(config, 'agents', `${id}.md`)));
  const withRule = present.filter((id) => /"gh pr merge\*": deny/.test(frontmatterOf(join(config, 'agents', `${id}.md`))));
  if (present.length) {
    if (withRule.length && withRule.length < present.length) {
      out.push(r('warn', 'backstop', `the native gh pr merge deny is in ${withRule.length} of ${present.length} agents, so some were edited by hand`, REINSTALL));
    } else if (install && typeof install.mergeBackstop === 'boolean' && install.mergeBackstop !== (withRule.length > 0)) {
      out.push(r('warn', 'backstop', `install.json says the backstop is ${install.mergeBackstop ? 'on' : 'off'}, but the agents ${withRule.length ? 'have' : 'lack'} it`, REINSTALL));
    } else {
      out.push(r('info', 'backstop', withRule.length ? 'every agent denies gh pr merge natively (the plugin guard is the real check)' : 'off: agents may merge where a project\'s merge_policy allows it'));
    }
  }
  return out;
}

/**
 * The project you are in: its merge policy against the install, and whether the event stream can be written.
 * @param {{cwd: string, root: string}} p
 * @returns {Result[]}
 */
export function checkProject({ cwd, root }) {
  const out = [];
  const config = join(root, '..');
  const policy = (profileKey(cwd, 'merge_policy') || '').toLowerCase();
  const hasRule = existsSync(join(config, 'agents', 'engineering-team', 'tech-lead.md')) && /"gh pr merge\*": deny/.test(frontmatterOf(join(config, 'agents', 'engineering-team', 'tech-lead.md')));
  if (!profileKey(cwd, 'merge_policy') && !existsSync(join(cwd, '.claude', 'team', 'project.md'))) {
    out.push(r('info', 'project', 'no .claude/team/project.md here, so merging is gated by default (human-approval)'));
  } else if (policy === 'autonomous' && hasRule) {
    out.push(r('warn', 'project', 'merge_policy is autonomous, but every agent denies gh pr merge natively, so merging will be blocked regardless', 'Reinstall with --allow-autonomous-merge. It applies to every project.'));
  } else {
    out.push(r('ok', 'project', `merge_policy: ${policy || 'human-approval (default)'}`));
  }

  try {
    const dir = streamDir(cwd);
    accessSync(dir, constants.W_OK);
    out.push(r('ok', 'stream', `${resolveStreamName(cwd)}: events and friction are written to ${dir}`));
  } catch (e) {
    out.push(r('fail', 'stream', `the event stream cannot be written: ${e.message}`, 'Check that ~/.claude/ops can be created and written.'));
  }
  return out;
}

/**
 * The model mapping, with the warnings `models.mjs check` gives.
 * @param {{root: string, catalog: any[] | null}} p
 * @returns {Result[]}
 */
export function checkModelMapping({ root, catalog }) {
  try {
    const file = join(root, 'models.json');
    const models = checkModels(existsSync(file) ? readJson(file) : {});
    const list = warnings({ models, agentsDir: join(root, '..', 'agents'), catalog });
    const mapped = Object.keys(models.tiers).length + Object.keys(models.agents).length;
    return list.length
      ? list.map((w) => r('warn', 'models', w, 'Run the init-models skill, or models.mjs set.'))
      : [r('ok', 'models', mapped ? 'mapping has no problems' : 'no mapping: every agent uses your default model')];
  } catch (e) {
    return [r('fail', 'models', `models.json is not valid: ${e.message}`, 'Fix it, or run the init-models skill.')];
  }
}

/**
 * Runs `opencode` with arguments in a directory. A parameter of checkLive so tests can stand in for it.
 * @param {string[]} args @param {string} cwd
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
export function execOpencode(args, cwd) {
  const res = spawnSync('opencode', args, { cwd, encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status ?? (res.error ? 127 : null), stdout: res.stdout || '', stderr: res.stderr || '' };
}

/**
 * Why this install's plugin failed to load, from OpenCode's own log, when it says. Only a line that is
 * recent and names this install's plugin counts: the log keeps old failures, and another install's (or an
 * earlier attempt's) is not the cause of this one.
 * @param {typeof execOpencode} exec @param {string} cwd @param {string} pluginDir
 * @param {number} [now] @returns {string | null}
 */
export function loadFailureFromLog(exec, cwd, pluginDir, now = Date.now()) {
  try {
    const paths = exec(['debug', 'paths'], cwd).stdout;
    const logDir = (paths.match(/^log\s+(\S.*)$/m) || [])[1]?.trim();
    if (!logDir || !existsSync(logDir)) return null;
    const files = readdirSync(logDir).filter((f) => f.endsWith('.log')).map((f) => join(logDir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (!files.length) return null;
    const text = readFileSync(files[0], 'utf8').slice(-400000);
    const recent = (l) => {
      const at = Date.parse((l.match(/timestamp=(\S+)/) || [])[1]);
      return Number.isFinite(at) && now - at < 5 * 60 * 1000;
    };
    const line = text.split('\n').reverse().find((l) => /failed to load plugin/i.test(l) && l.includes(pluginDir) && recent(l));
    return line ? ((line.match(/cause=(.*)$/) || [])[1] || line).slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * What OpenCode, started in cwd, shows an agent there: which team agents it can see, and what the plugin says it loaded.
 * @param {{cwd: string, root: string, exec?: typeof execOpencode}} p
 * @returns {Result[]}
 */
export function checkLive({ cwd, root, exec = execOpencode }) {
  const out = [];
  const version = exec(['--version'], cwd);
  if (version.status !== 0) {
    return [r('warn', 'opencode', '`opencode` was not found on PATH, so nothing was checked against a running OpenCode', 'Install OpenCode, or pass --no-live to skip these checks.')];
  }
  out.push(r('ok', 'opencode', `${version.stdout.trim()}`));

  // Agents, as this directory sees them.
  const agents = exec(['debug', 'agents', '--standalone'], cwd);
  let visible = null;
  try {
    visible = new Set(JSON.parse(agents.stdout).map((a) => a.id));
  } catch {
    out.push(r('warn', 'agents (live)', 'could not ask OpenCode which agents it can see from here'));
  }
  if (visible) {
    const missing = Object.keys(AGENT_MAP).filter((id) => !visible.has(id));
    if (!missing.length) {
      out.push(r('ok', 'agents (live)', `all ${Object.keys(AGENT_MAP).length} team agents are visible from ${cwd}`));
    } else {
      const git = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
      const worktree = git('rev-parse', '--git-dir').stdout.trim() !== git('rev-parse', '--git-common-dir').stdout.trim();
      out.push(r('fail', 'agents (live)', `${missing.length} team agents are not visible from ${cwd}${worktree ? ' (a git worktree)' : ''}: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}`,
        'OpenCode finds agents per directory, and a worktree holds only committed files. Install globally (--global), or commit .opencode.'));
    }
  }

  // The plugin: a command run in a session reports what it loaded.
  const api = (...args) => {
    const res = exec(['api', '--standalone', ...args], cwd);
    try {
      return JSON.parse(res.stdout);
    } catch {
      return null;
    }
  };
  const created = api('POST', '/api/session', '-d', JSON.stringify({ title: 'myco doctor' }));
  const id = created?.data?.id;
  if (!id) {
    out.push(r('warn', 'plugin (live)', 'could not open a session to check the plugin'));
    return out;
  }
  try {
    exec(['api', '--standalone', 'POST', `/api/session/${id}/shell`, '-d', JSON.stringify({ command: 'printf "MYCO_ROOT=%s MYCO_FEATURES=%s" "$MYCO_ROOT" "$MYCO_FEATURES"' })], cwd);
    let reported = null;
    for (let i = 0; i < 40 && reported === null; i++) {
      const shell = api('GET', `/api/session/${id}/message`)?.data?.find((m) => m.type === 'shell');
      if (shell?.status === 'exited') reported = String(shell.output?.output ?? '');
    }
    const loadedRoot = (String(reported).match(/MYCO_ROOT=(\S*)/) || [])[1] || '';
    const features = ((String(reported).match(/MYCO_FEATURES=(\S*)/) || [])[1] || '').split(',').filter(Boolean);
    const same = (a, b) => {
      try {
        return realpathSync(a) === realpathSync(b);
      } catch {
        return a === b;
      }
    };
    if (!loadedRoot) {
      const cause = loadFailureFromLog(exec, cwd, join(root, '..', 'plugins', 'myco'));
      out.push(r('fail', 'plugin (live)', `the plugin did not load: a command run in a session saw no MYCO_ROOT${cause ? `. OpenCode's log says: ${cause}` : ''}`,
        'Agents are running without the guards or the event stream. Check the OpenCode log (opencode debug paths), then reinstall.'));
    } else if (!same(loadedRoot, root)) {
      out.push(r('warn', 'plugin (live)', `the plugin that loaded is installed at ${loadedRoot}, not here (${root})`, 'Two installs are visible from this directory (global and project). The nearer one wins; make sure it is the one you meant.'));
    } else {
      out.push(r('ok', 'plugin (live)', 'loaded'));
    }
    if (loadedRoot) {
      for (const feature of FEATURES) {
        if (features.includes(feature)) continue;
        const core = FEATURE_CORE[feature];
        out.push(r('fail', `${feature}`, `not active: the plugin loaded but ${core ? `${core} did not load, so ` : ''}${feature} is silently absent`, REINSTALL));
      }
      if (FEATURES.every((f) => features.includes(f))) out.push(r('ok', 'features', `all active: ${FEATURES.join(', ')}`));
    }
  } finally {
    exec(['session', 'delete', id, '--standalone'], cwd);
  }
  return out;
}

/** @param {Result[]} results @returns {string} */
export function format(results) {
  const tag = { ok: 'ok  ', info: 'info', warn: 'warn', fail: 'FAIL' };
  const lines = [];
  for (const x of results) {
    lines.push(`${tag[x.level]}  ${x.area}: ${x.message}`);
    if (x.fix) lines.push(`      fix: ${x.fix}`);
  }
  const fails = results.filter((x) => x.level === 'fail').length;
  const warns = results.filter((x) => x.level === 'warn').length;
  lines.push('', fails ? `${fails} problem${fails > 1 ? 's' : ''}, ${warns} warning${warns === 1 ? '' : 's'}` : warns ? `no problems, ${warns} warning${warns === 1 ? '' : 's'}` : 'everything checks out');
  return lines.join('\n');
}

/** Whether this file is the one being run, with both sides resolved so a symlinked path still counts. */
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

/** @param {string[]} argv */
function main(argv) {
  const get = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const root = resolve(HERE, '..', '..');
  if (!existsSync(join(root, '..', 'agents'))) {
    console.error(`This is not an installed copy (no ${join(root, '..', 'agents')}). Run it from <config>/myco/team-ops/scripts/ after scripts/install.mjs.`);
    process.exit(2);
  }
  const cwd = resolve(get('--cwd') || process.cwd());
  const live = !argv.includes('--no-live');
  const results = [...checkInstall({ root }), ...checkProject({ cwd, root })];
  const liveResults = live ? checkLive({ cwd, root }) : [];
  results.push(...checkModelMapping({ root, catalog: live ? readCatalog() : null }), ...liveResults);
  if (!live) results.push(r('info', 'live', 'skipped (--no-live): nothing was checked against a running OpenCode'));
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else console.log(format(results));
  process.exit(results.some((x) => x.level === 'fail') ? 1 : 0);
}

if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
