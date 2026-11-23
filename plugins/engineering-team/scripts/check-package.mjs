#!/usr/bin/env node
// Mechanical readiness checks for a design package.
//
//   node check-package.mjs <package-dir> [--json] [--ready] [--local-prototypes]
//
// The product lead's step 7 and the engineering tech lead's "check it's ready" list
// things that can be counted: every requirement in one phase, every P0/P1/SEC control
// in the traceability table, no open questions. Counting is what a script does reliably
// and a model does not, so those checks live here. The judgment ones (do the documents
// agree with each other, does an ADR constrain implementation) stay with the product lead.
//
// Exit 0: every check passes. Exit 1: at least one fails. Exit 2: not a package.
// --ready also requires the index to say "Ready for engineering" with every readiness
// box ticked, which is how the tech lead uses it; the product lead runs without it,
// since the status and boxes are what it sets once the checks pass.
// --local-prototypes is for hosts that can't publish to claude.ai: an HTML prototype
// kept in the package (a `ux/<file>.html` path that exists) counts as linked.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith('--'));
const asJson = argv.includes('--json');
const ready = argv.includes('--ready');
const localPrototypes = argv.includes('--local-prototypes');
if (!dir || !existsSync(join(dir, 'README.md'))) {
  console.error('usage: check-package.mjs <package-dir> [--json] [--ready] [--local-prototypes]\nThe directory must hold the package index, README.md.');
  process.exit(2);
}

/** @param {string} name @returns {string | null} file text with LF endings, or null */
const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n') : null);
const DOCS = ['prd.md', 'architecture.md', 'security-review.md', 'tech-design.md', 'ux.md'];
const docs = Object.fromEntries(DOCS.map((d) => [d, read(d)]));
const index = /** @type {string} */ (read('README.md'));

const ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const BLANK = /^\s*(|-+|n\/a|none|tbd|\?)\s*$/i;

/**
 * The body of the first section whose heading matches, up to the next heading of the
 * same or a higher level. Headings inside fenced code blocks (templates quoted in a
 * document) are not headings.
 * @param {string | null} text @param {RegExp} title @returns {string | null}
 */
function section(text, title) {
  if (!text) return null;
  const lines = text.split('\n');
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    const m = !fence && lines[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    if (start < 0) {
      if (title.test(m[2])) {
        start = i + 1;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

/**
 * Markdown tables in a block of text, as rows of cells keyed by lower-cased header.
 * @param {string | null} text @returns {Record<string, string>[][]}
 */
function tables(text) {
  if (!text) return [];
  const out = [];
  let cur = null;
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) {
      cur = null;
      continue;
    }
    if (!cur && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      cur = { head: cells(l).map((h) => h.toLowerCase().replace(/\*/g, '')), rows: [] };
      out.push(cur.rows);
      i++;
    } else if (cur) {
      const c = cells(l);
      cur.rows.push(Object.fromEntries(cur.head.map((h, j) => [h, c[j] ?? ''])));
    }
  }
  return out;
}

/** The first column whose header contains `word`. @param {Record<string,string>} row @param {string} word */
const col = (row, word) => row[Object.keys(row).find((k) => k.includes(word)) ?? ''] ?? '';

/** An unfilled template cell: blank, or a `<placeholder>`. @param {string} cell @returns {boolean} */
const isPlaceholder = (cell) => BLANK.test(cell) || /^<.*>$/.test(cell.trim());

/** A table row copied from a template and never filled in. @param {Record<string,string>} row @returns {boolean} */
const isTemplateRow = (row) => Object.values(row).every(isPlaceholder);

/** The first http(s) URL in text, or ''. @param {string | undefined} s @returns {string} */
const firstUrl = (s) => (s || '').match(/https?:\/\/[^\s)>\]|]+/)?.[0] ?? '';

/**
 * The first claude.ai link in text, or ''. Claude Design canvases and pages published
 * with the Artifact tool both live there, so it is what a published prototype links to.
 * @param {string | undefined} s @returns {string}
 */
const claudeLink = (s) => (s || '').match(/https:\/\/claude\.ai\/[^\s)>\]|]+/)?.[0] ?? '';

/** The first `ux/<file>.html` path in text, or ''. @param {string | undefined} s @returns {string} */
const uxPath = (s) => (s || '').match(/\bux\/[^\s`)>\]|]+\.html\b/)?.[0] ?? '';

/**
 * Where a prototype row points: its claude.ai link or, under --local-prototypes, a `ux/` file
 * that exists in the package. '' when it points nowhere that counts.
 * @param {string} s @returns {string}
 */
const prototypeTarget = (s) => claudeLink(s) || (localPrototypes && uxPath(s) && existsSync(join(dir, uxPath(s))) ? uxPath(s) : '');

/**
 * IDs in text, with ranges like `COL-1–COL-3` or `COL-1..3` expanded.
 * @param {string} s @returns {string[]}
 */
function ids(s) {
  const out = [];
  const range = /\b([A-Z][A-Z0-9]*)-(\d+)\s*(?:–|—|\.\.|\bto\b)\s*(?:\1-)?(\d+)\b/g;
  const rest = s.replace(range, (_, p, a, b) => {
    for (let n = +a; n <= +b; n++) out.push(`${p}-${n}`);
    return ' ';
  });
  return [...out, ...(rest.match(ID) || [])];
}

/** @type {{check: string, ok: boolean, problems: string[]}[]} */
const results = [];
/** @param {string} check @param {string[]} problems */
const record = (check, problems) => results.push({ check, ok: problems.length === 0, problems });

const prd = docs['prd.md'];
const techDesign = docs['tech-design.md'];
const security = docs['security-review.md'];

// ---- Documents present
{
  const problems = [];
  if (!prd) problems.push('prd.md is missing');
  if (!/^\s*\|\s*\*{0,2}Status/im.test(index)) problems.push('README.md has no Status row');
  record('The package has a PRD and an index with a status', problems);
}

// ---- No open questions
{
  const problems = [];
  const files = { 'README.md': index, ...Object.fromEntries(Object.entries(docs).filter(([, v]) => v)) };
  for (const [name, text] of Object.entries(files)) {
    const status = text.match(/^\s*\|\s*\*{0,2}Status\*{0,2}\s*\|\s*(.*?)\s*\|/im)?.[1] ?? '';
    const n = status.match(/(\d+)\s+open questions?/i);
    if (n && +n[1] > 0) problems.push(`${name}: status says ${n[1]} open question${+n[1] === 1 ? '' : 's'}`);
    const body = section(text, /^(\d+\.\s*)?open questions\b/i);
    const items = (body || '').split('\n').filter((l) => !BLANK.test(l) && !/^\s*_.*_\s*$/.test(l) && !/^\s*(none|n\/a)\b/i.test(l.replace(/^[-*\d.\s]+/, '')));
    if (items.length) problems.push(`${name}: the Open questions section still has ${items.length} line${items.length === 1 ? '' : 's'}`);
  }
  record('No document has open questions', problems);
}

// ---- PRD requirements
/** @type {Map<string, {priority: string, actor: string}>} */
const reqs = new Map();
{
  const body = section(prd, /functional requirements/i);
  for (const rows of tables(body)) {
    for (const r of rows) {
      const id = col(r, 'id').replace(/[`*]/g, '').trim();
      if (/^[A-Z][A-Z0-9]*-\d+$/.test(id)) reqs.set(id, { priority: col(r, 'priority').trim().toUpperCase(), actor: col(r, 'actor').trim() });
    }
  }
  const problems = [];
  if (prd && !reqs.size) problems.push('no requirement rows found under "Functional requirements" (expected tables with ID and Priority columns)');
  for (const [id, r] of reqs) if (!/^P[0-2]\b/.test(r.priority)) problems.push(`${id}: priority "${r.priority}" is not P0, P1 or P2`);
  record('Every requirement has an ID and a priority', problems);
}

// ---- Phasing
{
  const body = section(prd, /^(\d+\.\s*)?phasing/i);
  const problems = [];
  /** @type {Map<string, string[]>} */
  const where = new Map();
  for (const rows of tables(body)) {
    for (const r of rows) {
      const phase = col(r, 'phase').replace(/\*/g, '').trim();
      for (const id of ids(col(r, 'scope'))) where.set(id, [...(where.get(id) || []), phase]);
    }
  }
  if (reqs.size && !where.size) problems.push('no phasing table with a Scope column found');
  else {
    for (const id of reqs.keys()) {
      const phases = where.get(id) || [];
      if (!phases.length) problems.push(`${id} is in no phase`);
      else if (phases.length > 1) problems.push(`${id} is in ${phases.length} phases (${phases.join(', ')})`);
    }
    for (const [id, phases] of where) if (!reqs.has(id) && /^[A-Z]{2,}-\d+$/.test(id) && !/^(A|SC|D|ADR)-/.test(id)) problems.push(`${id} is phased (${phases.join(', ')}) but is not a PRD requirement`);
  }
  record('Every PRD requirement is in exactly one phase', problems);
}

// ---- Security controls and traceability
const secIds = new Set();
{
  for (const rows of tables(section(security, /required controls/i))) {
    for (const r of rows) {
      const id = col(r, 'id').replace(/[`*]/g, '').trim();
      if (/^SEC-\d+$/.test(id)) secIds.add(id);
    }
  }
  const problems = [];
  for (const id of secIds) if (!reqs.has(id)) problems.push(`${id} is a security control but not a PRD requirement`);
  for (const id of reqs.keys()) if (/^SEC-\d+$/.test(id) && security && !secIds.has(id)) problems.push(`${id} is a PRD requirement but not in the security review`);
  record('Every SEC control is a PRD requirement', problems);
}
{
  const body = section(techDesign, /traceability/i);
  const problems = [];
  const traced = new Set();
  for (const rows of tables(body)) {
    for (const r of rows) {
      const cells = Object.values(r);
      const first = cells[0] || '';
      const mine = ids(first);
      mine.forEach((id) => traced.add(id));
      if (mine.length && cells.some((c) => BLANK.test(c))) problems.push(`${mine.join(', ')}: the traceability row has a blank cell`);
    }
  }
  if (techDesign && !traced.size) problems.push('no traceability table found in the tech design (expected Requirement, Implemented in, Verified by)');
  else if (techDesign) {
    for (const [id, r] of reqs) if ((/^P[01]\b/.test(r.priority) || secIds.has(id)) && !traced.has(id)) problems.push(`${id} (${secIds.has(id) ? 'SEC control' : r.priority}) is not in the traceability table`);
    for (const id of secIds) if (!reqs.has(id) && !traced.has(id)) problems.push(`${id} is not in the traceability table`);
  }
  record('Every P0, P1 and SEC requirement is in the tech design traceability table', problems);
}

// ---- Actors and scenarios
{
  const problems = [];
  const actors = new Set();
  for (const rows of tables(section(prd, /^(\d+\.\s*)?actors/i))) {
    for (const r of rows) {
      const id = col(r, 'id').replace(/[`*]/g, '').trim();
      if (/^A-\d+$/.test(id)) actors.add(id);
    }
  }
  const scenarios = (section(prd, /key scenarios/i) || '').split('\n').filter((l) => /\bSC-\d+\b/.test(l));
  const withScenario = new Set(scenarios.flatMap((l) => ids(l).filter((i) => /^A-\d+$/.test(i))));
  if (prd && !actors.size) problems.push('no actors table found (expected IDs A-1, A-2, ...)');
  for (const [id, r] of reqs) {
    if (BLANK.test(r.actor) && r.actor !== '') continue;
    if (r.actor === '') problems.push(`${id}: the Actor cell is empty (name an actor, or "—" for system-wide)`);
    else if (!/^[—–-]+$/.test(r.actor)) for (const a of ids(r.actor)) if (/^A-\d+$/.test(a) && !actors.has(a)) problems.push(`${id}: actor ${a} is not defined in the PRD's actors table`);
  }
  for (const a of actors) if (!withScenario.has(a)) problems.push(`${a} has no key scenario`);
  record('Every requirement names a defined actor, and every actor has a scenario', problems);
}

// ---- Codebases
{
  const problems = [];
  const rows = tables(section(index, /^codebases/i)).flat();
  if (!rows.length) problems.push('the index has no Codebases table');
  for (const r of rows) {
    const name = Object.values(r)[0] || '(row)';
    if (isPlaceholder(name)) continue;
    const commit = col(r, 'commit').replace(/[`*]/g, '').trim();
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) problems.push(`${name}: no commit recorded (got "${commit || 'blank'}")`);
  }
  record('Every codebase the design was grounded in records its commit', problems);
}

// ---- Engineering feedback
{
  const problems = [];
  for (const r of tables(section(index, /^engineering feedback/i)).flat()) {
    if (isTemplateRow(r)) continue;
    const n = Object.values(r)[0]?.trim() || '?';
    const status = col(r, 'status').replace(/[*_]/g, '').trim().toLowerCase();
    if (!/^(open|decided|declined)$/.test(status)) problems.push(`feedback #${n}: status "${status || 'blank'}" is not Open, Decided or Declined`);
    else if (status === 'open') problems.push(`feedback #${n} is still Open: ${col(r, 'problem').slice(0, 80)}`);
    else if (BLANK.test(col(r, 'resolution'))) problems.push(`feedback #${n} is ${status} but has no Resolution`);
  }
  record('No engineering feedback is still open', problems);
}

const advice = [];

// ---- UX prototypes linked (a package written before the Prototypes section existed gets advice, not a failure)
if (docs['ux.md']) {
  const body = section(docs['ux.md'], /^(\d+\.\s*)?prototypes\b/i);
  if (body === null) {
    advice.push(`ux.md has no Prototypes section; list each prototype with its ${localPrototypes ? 'ux/ path' : 'claude.ai link'} there, or mark it N/A with a reason`);
  } else {
    const problems = [];
    let primary = '';
    for (const r of tables(body).flat()) {
      if (isTemplateRow(r)) continue;
      const cells = Object.values(r).map((c) => c.trim());
      const name = cells[0] || '(row)';
      // A table written before the Link column existed: look for the link in any cell.
      const hasLinkCol = Object.keys(r).some((k) => k.includes('link'));
      const link = hasLinkCol ? col(r, 'link') : cells.find((c) => prototypeTarget(c)) ?? cells.find((c) => firstUrl(c)) ?? '';
      const target = prototypeTarget(link);
      if (!target) {
        const path = localPrototypes && uxPath(link);
        problems.push(path ? `${name}: ${path} is not in the package` : `${name}: no ${localPrototypes ? 'claude.ai link or ux/ path' : 'published claude.ai link'} (got "${link || 'blank'}")`);
      } else if (!primary) primary = target;
      // "stale" is a marker only in Synced to; elsewhere it can be a state's name ("stale model").
      // A table with no Synced to column: a cell that starts with "stale", the template's form.
      const hasSyncedCol = Object.keys(r).some((k) => k.includes('synced'));
      const synced = col(r, 'synced');
      let stale = '';
      if (hasSyncedCol && /\bstale\b/i.test(synced)) stale = synced;
      else if (!hasSyncedCol) stale = cells.find((c) => /^stale\b/i.test(c)) ?? '';
      if (stale) problems.push(`${name}: marked stale (${stale}); update it at the same link`);
    }
    // The index's Prototype row is what the review page and the hub link to; it must be the table's first row.
    const indexRow = index.match(/^\s*\|\s*\*{0,2}Prototype\*{0,2}\s*\|\s*(.*?)\s*\|/im);
    const indexTarget = indexRow ? firstUrl(indexRow[1]) || (localPrototypes ? uxPath(indexRow[1]) : '') : '';
    if (primary && indexRow && indexTarget !== primary) {
      problems.push(`README.md's Prototype row (${indexTarget || indexRow[1] || 'blank'}) is not ux.md's primary prototype (${primary})`);
    } else if (primary && !indexRow) {
      advice.push(`README.md has no Prototype row; add one with ux.md's primary prototype (${primary}) so the review page and hub link it`);
    }
    record(localPrototypes ? 'Every UX prototype is in the package and linked from ux.md' : 'Every UX prototype is published and linked from ux.md', problems);
  }
}

// ---- ADRs referenced (advice, not a failure: only ADRs that constrain implementation must be)
{
  const adrs = [...new Set((docs['architecture.md'] || '').match(/^#{2,4}\s+ADR-\d+/gim)?.map((h) => h.match(/ADR-\d+/i)?.[0].toUpperCase()) ?? [])];
  const unreferenced = adrs.filter((a) => techDesign && !new RegExp(`\\b${a}\\b`, 'i').test(techDesign));
  if (unreferenced.length) advice.push(`${unreferenced.join(', ')} not mentioned in the tech design; fine for an ADR that doesn't constrain implementation, otherwise reference it`);
}

// ---- Status and ticks, for the engineering side
if (ready) {
  const problems = [];
  const status = index.match(/^\s*\|\s*\*{0,2}Status\*{0,2}\s*\|\s*(.*?)\s*\|/im)?.[1] ?? '';
  if (!/ready for engineering/i.test(status.replace(/\*/g, ''))) problems.push(`status is "${status || 'missing'}", not Ready for engineering`);
  const unticked = (section(index, /^readiness/i) || '').split('\n').filter((l) => /^\s*-\s*\[ \]/.test(l));
  for (const l of unticked) problems.push(`not ticked: ${l.replace(/^\s*-\s*\[ \]\s*/, '').slice(0, 90)}`);
  record('The index says Ready for engineering with every readiness item ticked', problems);
}

const failed = results.filter((r) => !r.ok);
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results, advice }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}`);
    for (const p of r.problems) console.log(`        - ${p}`);
  }
  for (const a of advice) console.log(`NOTE  ${a}`);
  console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed. The judgment checks (documents agree, ADRs constrain, states defined) are still yours.`);
}
process.exit(failed.length ? 1 : 0);
