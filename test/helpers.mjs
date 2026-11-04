// Shared test helpers: an isolated home and project per test, a way to run a plugin script,
// builders for team profiles and the stream's files, and a local OTLP collector.
//
// Every script that writes under ~/.claude/ops resolves the home directory through
// os.homedir(), which reads HOME on macOS/Linux and USERPROFILE on Windows. Tests point
// both at a temp directory so they never touch the real one, on any platform.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} plugin @param {string} name @returns {string} path of a plugin's script */
export const script = (plugin, name) => join(ROOT, 'plugins', plugin, 'scripts', name);

/**
 * An isolated home directory and project directory, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {{root: string, home: string, project: string, env: Record<string,string>}}
 */
export function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'myco-test-')));
  const home = join(root, 'home');
  const project = join(root, 'proj-alpha');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, home, project, env: { HOME: home, USERPROFILE: home } };
}

/**
 * Runs a node script and resolves with its exit status and output. Async, so a test can
 * serve an HTTP endpoint from the same process while the script talks to it.
 * @param {string} file
 * @param {{args?: string[], input?: string, cwd?: string, env?: Record<string,string|undefined>}} [opts]
 * @returns {Promise<{status: number | null, stdout: string, stderr: string}>}
 */
export function runNode(file, opts = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, ...opts.env };
  // A developer's own telemetry settings must not leak into a test run.
  for (const k of Object.keys(env)) if (k.startsWith('TEAM_OPS_') && !(opts.env && k in opts.env)) delete env[k];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...(opts.args || [])], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

/**
 * Writes a team profile's frontmatter, like /init-team or /init-design would.
 * @param {string} projectDir
 * @param {Record<string,string> | string} frontmatter keys to write, or the raw frontmatter text
 * @param {'project.md' | 'design.md'} [name]
 */
export function writeProfile(projectDir, frontmatter, name = 'project.md') {
  const body = typeof frontmatter === 'string' ? frontmatter : Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  const p = join(projectDir, '.claude', 'team', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\n${body}\n---\n\n# Profile\n`, 'utf8');
  return p;
}

/** @param {string} file @returns {any[]} parsed lines of a JSONL file, [] when it doesn't exist */
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** @param {string} home @param {string} stream @param {string} file @returns {string} path under ~/.claude/ops/<stream>/ */
export const opsFile = (home, stream, file) => join(home, '.claude', 'ops', stream, file);

// ---------- time ----------

/** @param {number} seconds @returns {string} a timestamp `seconds` into a fixed morning, so ordering is explicit in tests */
export const ts = (seconds) => new Date(Date.UTC(2026, 9, 12, 10, 0, seconds)).toISOString();

// ---------- OTLP collector ----------

/**
 * A local HTTP endpoint that records what's POSTed to it.
 * @param {import('node:test').TestContext} t
 * @param {{status?: number}} [opts] the status to answer with
 * @returns {Promise<{url: string, requests: {path: string, headers: Record<string, any>, body: any}[]}>}
 */
export async function collector(t, opts = {}) {
  /** @type {{path: string, headers: Record<string, any>, body: any}[]} */
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = raw; }
      requests.push({ path: req.url || '', headers: req.headers, body });
      res.writeHead(opts.status || 200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)); }));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, requests };
}

/**
 * An OTLP attribute list as a plain object, so tests can assert on names and values.
 * @param {{key: string, value: any}[]} list
 * @returns {Record<string, string>}
 */
export function attrMap(list) {
  return Object.fromEntries((list || []).map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue]));
}
