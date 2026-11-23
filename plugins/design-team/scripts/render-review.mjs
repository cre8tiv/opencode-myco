#!/usr/bin/env node
// Renders a design package, or the hub listing every package, as one self-contained
// HTML page for publishing as a claude.ai artifact. The package documents are rendered
// faithfully from their markdown, so the page never drifts from what engineering reads.
//
//   node render-review.mjs package --dir <packages_dir>/<slug> --title "<page title>"
//        --out <file.html> [--round <n>] [--summary <file.md>] [--standalone]   (default summary: review.md)
//   node render-review.mjs hub --dir <packages_dir> --title "<page title>" --out <file.html> [--standalone]
//
// Standard library only. The output has no <html>/<head>/<body>: the artifact host
// wraps it. Mermaid fences become <pre class="mermaid">, which the host renders.
// --standalone is for a page opened as a file rather than published: it writes a whole
// HTML document, and the package page loads one pinned, integrity-checked Mermaid build
// from a CDN to draw the diagrams. Offline, the diagram source stays readable.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Package documents in reading order: [file, section id, nav label]. */
const DOCS = [
  ['README.md', 'package', 'Package'],
  ['prd.md', 'prd', 'PRD'],
  ['ux.md', 'ux', 'UX'],
  ['architecture.md', 'architecture', 'Architecture'],
  ['security-review.md', 'security', 'Security review'],
  ['tech-design.md', 'tech-design', 'Tech design'],
];
const DOC_LINKS = { ...Object.fromEntries(DOCS.map(([f, id]) => [f.toLowerCase(), id])), 'review.md': 'overview' };

// ---------- arguments ----------

/** @param {string[]} argv @returns {{cmd: string, opts: Record<string,string>}} */
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  /** @type {Record<string,string>} */
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    // A flag with no value (--standalone) is 'true'; it must not swallow the next flag.
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) opts[rest[i].slice(2)] = 'true';
    else opts[rest[i].slice(2)] = rest[++i];
  }
  return { cmd, opts };
}

// ---------- markdown ----------

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @param {string} s */
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Requirement, decision, actor, scenario, control, threat, ADR and surface IDs.
const ID_RE = /\b((?:[A-Z]{1,5}-\d+)|(?:ADR-\d+))\b/g;
// Standard names that look like IDs.
const NOT_IDS = /^(UTF|SHA|ISO|RFC|HTTP|TLS|SSL|MD|AES|RSA|ES|IEEE|CVE|CWE|OWASP|PEP|WCAG)-/;

// ---------- design IDs: what each one means ----------
//
// An ID is meaningless to a reader who hasn't opened the PRD. So before rendering, the
// package's own documents are scanned for where each ID is defined (a table row whose first
// cell is the ID, a heading that starts with it, or a bold lead-in), and each chip then
// shows that definition on hover and links to it. A first definition wins. State is
// module-level because inline() is called from everywhere and one process renders one page.

/** @typedef {{doc: string, text: string, anchor: string, placed: boolean}} IdDef */
/** @type {Map<string, IdDef>} */
let ID_DEFS = new Map();
/** @type {Map<string, string>} area names from headings like "Enforcement (ENF)", by prefix */
let ID_AREAS = new Map();
/** What a prefix means when no heading names it. */
const KINDS = { A: 'Actors', F: 'User flows', SC: 'Key scenarios', D: 'Decisions', R: 'Risks', T: 'Threats', S: 'Screens and surfaces', ADR: 'Architecture decisions', SEC: 'Security controls' };
const ONE_ID = /^[A-Z]{1,5}-\d+$/;
const ID_LIST = /^[A-Z]{1,5}-\d+(?:\s*[,;]\s*[A-Z]{1,5}-\d+)*$/;
const isId = (c) => ONE_ID.test(c) && !NOT_IDS.test(c);
const isTableSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l);
const tableCells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
// A bold lead-in or heading that starts with an ID: "**SC-1 — Rotate a credential**", "### ADR-1: Release gate".
const DEF_LEAD = /^(?:#{1,6}\s+|>\s*)?(\*\*)?([A-Z]{1,5}-\d+)\s*[—–:.]\s*(.+?)\s*$/;

/** Markdown reduced to plain text, for a tooltip. @param {string} t */
const plain = (t) => t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
/** @param {string} t @param {number} n */
const clip = (t, n) => (t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '')}…`);

/**
 * Records where the IDs in one document are defined.
 * @param {string} md @param {string} doc section id of the document
 */
function collectIds(md, doc) {
  const lines = normalize(md);
  const add = (id, text, anchor) => {
    if (!ID_DEFS.has(id)) ID_DEFS.set(id, { doc, text: clip(text, 160), anchor, placed: anchor !== `${doc}-id-${slug(id)}` });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const def = isTableSep(l) || isTableSep(lines[i + 1] ?? '') ? null : rowDef(tableCells(l));
      if (def) add(def.id, def.text, `${doc}-id-${slug(def.id)}`);
      continue;
    }
    const h = l.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      const area = h[1].match(/^(?:\d+(?:\.\d+)*\.?\s+)?(.+?)\s*\(([A-Z]{1,5})\)$/);
      if (area && !ID_AREAS.has(area[2])) ID_AREAS.set(area[2], plain(area[1]));
    }
    const d = l.match(DEF_LEAD);
    if (d && isId(d[2]) && (h || d[1])) {
      const title = plain(d[1] ? d[3].split('**')[0] : d[3]);
      if (title) add(d[2], title, h ? `${doc}-${slug(h[1])}` : `${doc}-id-${slug(d[2])}`);
    }
  }
}

/**
 * The ID a table row defines and what it says: the ID alone in the first cell, or an ID
 * led into the cell as "Accepted risk: R-01: text".
 * @param {string[]} cells @returns {{id: string, text: string} | null}
 */
function rowDef(cells) {
  const first = plain(cells[0] ?? '');
  if (isId(first)) return { id: first, text: rowText(cells) };
  const m = first.match(/^(?:[A-Za-z][A-Za-z ]*:\s*)?([A-Z]{1,5}-\d+)\s*[:—–]\s*(.+)$/);
  return m && isId(m[1]) ? { id: m[1], text: m[2] } : null;
}

/** A table row's text: its second cell, plus the third when the second is short. @param {string[]} cells */
function rowText(cells) {
  const a = plain(cells[1] ?? '');
  const b = plain(cells[2] ?? '');
  return a.length < 60 && b.length >= 12 && !ID_LIST.test(b) ? (a ? `${a} — ${b}` : b) : a;
}

/** The anchor id the element defining `id` should carry, the first time it is rendered in `doc`; otherwise null. */
function claimAnchor(id, doc) {
  const d = ID_DEFS.get(id);
  if (!d || d.doc !== doc || d.placed) return null;
  d.placed = true;
  return d.anchor;
}

/**
 * One ID as a chip. A defined ID shows its definition on hover and links to it, except
 * inside a link (anchors can't nest) and at its own definition.
 * @param {string} id @param {boolean} plainChip
 */
function chip(id, plainChip) {
  const d = ID_DEFS.get(id);
  if (!d) return `<span class="id">${id}</span>`;
  const title = d.text ? ` title="${esc(d.text)}"` : '';
  return plainChip ? `<span class="id"${title}>${id}</span>` : `<a class="id" href="#${d.anchor}"${title}>${id}</a>`;
}

/** The "what the codes mean" key: one row per prefix in use. @returns {string} */
function renderKey() {
  /** @type {Map<string, {n: number, first: string}>} */
  const byPrefix = new Map();
  for (const id of ID_DEFS.keys()) {
    const p = id.slice(0, id.lastIndexOf('-'));
    const e = byPrefix.get(p);
    if (e) e.n++;
    else byPrefix.set(p, { n: 1, first: id });
  }
  if (!byPrefix.size) return '';
  const rows = [...byPrefix].map(([p, e]) => {
    const means = ID_AREAS.get(p) || KINDS[p] || '';
    const d = ID_DEFS.get(e.first);
    return `<tr><td><code>${p}-n</code></td><td>${esc(means)}</td><td>${e.n}</td><td>${chip(e.first, true)} ${esc(clip(d.text, 90))}</td></tr>`;
  }).join('\n');
  return `<details class="key"><summary>What do codes like <span class="id">SC-1</span> and <span class="id">A-1</span> mean?</summary>
<p>Each code labels one numbered item in the documents below. Hover a code to read what it stands for, or click it to jump to its definition.</p>
<div class="scroll"><table><thead><tr><th>Code</th><th>Stands for</th><th>Count</th><th>First one</th></tr></thead><tbody>
${rows}
</tbody></table></div>
</details>`;
}

/**
 * Renders inline markdown: code spans, links, bold, italic, and design IDs as chips.
 * @param {string} text
 * @param {string} prefix section id, for in-page anchors
 * @param {boolean} [inLink] the text is inside a link, so IDs can't be links too
 * @returns {string}
 */
function inline(text, prefix, inLink = false) {
  /** @type {string[]} */
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  // One pass, so a code span inside a link label renders inside the link, and link syntax
  // inside a code span stays literal.
  let s = text.replace(/`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g, (_, c, label, href) =>
    hold(c !== undefined ? `<code>${esc(c)}</code>` : link(label, href, prefix)));
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`));
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s.,;:)!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(ID_RE, (m) => (NOT_IDS.test(m) ? m : chip(m, inLink)));
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[Number(n)]);
  return s;
}

/**
 * A link to another package document becomes an in-page anchor; an external URL opens
 * in a new tab; a repository path, which a reviewer can't open, is shown as code.
 * @param {string} label @param {string} href @param {string} prefix
 */
function link(label, href, prefix) {
  const text = inline(label, prefix, true);
  if (/^https?:\/\//.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
  if (href.startsWith('#')) return `<a href="#${prefix}-${slug(href.slice(1))}">${text}</a>`;
  const [file, anchor] = href.split('#');
  const doc = DOC_LINKS[path.basename(file).toLowerCase()];
  if (doc) return `<a href="#${anchor ? `${doc}-${slug(anchor)}` : doc}">${text}</a>`;
  return `${text} <code class="path">${esc(href)}</code>`;
}

/**
 * Renders a markdown document to HTML. Covers what the design templates use: headings,
 * paragraphs, nested lists and task lists, tables, fenced code, Mermaid, blockquotes,
 * rules. Raw HTML in the source is escaped, not passed through.
 * @param {string} md
 * @param {string} prefix section id, prefixed to heading ids so documents can't collide
 * @returns {string}
 */
function renderMarkdown(md, prefix) {
  return blocks(normalize(md), prefix);
}

/** A document's lines: no byte-order mark, comments or front matter. @param {string} md @returns {string[]} */
function normalize(md) {
  return stripFrontMatter(md.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n'));
}

/**
 * Drops a YAML front-matter block: `---` on the first line through the next line that is
 * exactly `---`, plus the blank lines after it. Only at the start, so a `---` rule later
 * in a document still renders. An unclosed block is left alone.
 * @param {string[]} lines @returns {string[]}
 */
function stripFrontMatter(lines) {
  if (lines[0]?.trimEnd() !== '---') return lines;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return lines;
  let i = end + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i);
}

/** @param {string[]} lines @param {string} prefix @returns {string} */
function blocks(lines, prefix) {
  let out = '';
  let i = 0;
  const isList = (l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l);
  const startsBlock = (l, next) =>
    /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || isList(l) ||
    /^\s*(-{3,}|\*{3,})\s*$/.test(l) || (/^\s*\|/.test(l) && next !== undefined && isTableSep(next));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^(\s*)```\s*([\w-]*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++].slice(fence[1].length));
      i++;
      const code = esc(body.join('\n'));
      out += fence[2] === 'mermaid'
        ? `<div class="scroll diagram"><pre class="mermaid">${code}</pre></div>\n`
        : `<div class="scroll"><pre><code>${code}</code></pre></div>\n`;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      // Document h1 renders as h2: the section heading sits above it on the page.
      const level = Math.min(6, h[1].length + 1);
      out += `<h${level} id="${prefix}-${slug(h[2])}">${inline(h[2], prefix)}</h${level}>\n`;
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out += '<hr>\n'; i++; continue; }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out += `<blockquote>${blocks(body, prefix)}</blockquote>\n`;
      continue;
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = tableCells(line);
      i += 2;
      let rows = '';
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const r = tableCells(lines[i++]);
        const def = rowDef(r);
        const rowId = def ? claimAnchor(def.id, prefix) : null;
        // The defining row carries the anchor, and its own ID needn't link to itself.
        rows += `<tr${rowId ? ` id="${rowId}"` : ''}>${head.map((_, k) => `<td>${inline(r[k] ?? '', prefix, k === 0 && !!rowId)}</td>`).join('')}</tr>\n`;
      }
      out += `<div class="scroll"><table><thead><tr>${head.map((c) => `<th>${inline(c, prefix)}</th>`).join('')}</tr></thead><tbody>\n${rows}</tbody></table></div>\n`;
      continue;
    }

    if (isList(line)) {
      const r = list(lines, i, prefix);
      out += r.html;
      i = r.next;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    if (!para.length) { para.push(lines[i++].trim()); }
    const text = para.join(' ');
    const lead = text.match(/^\*\*([A-Z]{1,5}-\d+)\s*[—–:.]/);
    const leadId = lead && isId(lead[1]) ? claimAnchor(lead[1], prefix) : null;
    out += `<p${leadId ? ` id="${leadId}"` : ''}>${inline(text, prefix)}</p>\n`;
  }
  return out;
}

/**
 * Renders a list starting at lines[start], including nested lists and continuation lines.
 * @param {string[]} lines @param {number} start @param {string} prefix
 * @returns {{html: string, next: number}}
 */
function list(lines, start, prefix) {
  const first = lines[start].match(/^(\s*)([-*+]|\d+[.)])\s+/);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  let i = start;
  let items = '';
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    i++;
    // The item continues through blank lines and lines indented deeper than its marker.
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        const nxt = lines.slice(i + 1).find((x) => x.trim());
        if (nxt && nxt.match(/^\s*/)[0].length > indent) { body.push(''); i++; continue; }
        break;
      }
      if (l.match(/^\s*/)[0].length > indent) { body.push(l.slice(Math.min(l.match(/^\s*/)[0].length, indent + 2))); i++; continue; }
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(l)) break;
      if (/^\s*(```|#|>|\|)/.test(l)) break;
      body.push(l.trim()); // lazy continuation
      i++;
    }
    let head = body[0];
    let check = '';
    const task = head.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      check = `<span class="check${task[1] === ' ' ? '' : ' done'}" aria-label="${task[1] === ' ' ? 'not done' : 'done'}"></span>`;
      head = task[2];
    }
    const rest = body.slice(1);
    const firstPara = [head];
    while (rest.length && rest[0].trim() && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(rest[0]) && !/^\s*(```|#|>|\|)/.test(rest[0])) firstPara.push(rest.shift().trim());
    const inner = rest.some((l) => l.trim()) ? blocks(rest, prefix) : '';
    items += `<li${check ? ' class="task"' : ''}>${check}${inline(firstPara.join(' '), prefix)}${inner}</li>\n`;
    while (i < lines.length && !lines[i].trim()) {
      const nxt = lines.slice(i).find((x) => x.trim());
      const nm = nxt && nxt.match(/^(\s*)([-*+]|\d+[.)])\s+/);
      if (nm && nm[1].length === indent) i++;
      else break;
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>\n${items}</${tag}>\n`, next: i };
}

// ---------- package facts ----------

/**
 * Reads the package index's header table (`| **Status** | ... |` rows) and title.
 * @param {string} readme
 * @returns {{name: string, fields: Record<string,string>}}
 */
function indexFacts(readme) {
  const name = (readme.match(/^#\s+(.+)$/m) || [])[1]?.trim() || '';
  /** @type {Record<string,string>} */
  const fields = {};
  for (const m of readme.matchAll(/^\|\s*\*\*([^*]+)\*\*\s*\|\s*(.*?)\s*\|\s*$/gm)) fields[m[1].trim().toLowerCase()] = m[2].trim();
  return { name, fields };
}

/** @param {string} status */
function statusClass(status) {
  const s = status.toLowerCase();
  if (s.includes('ready')) return 'ready';
  if (s.includes('review')) return 'review';
  if (s.includes('decision')) return 'loop';
  return 'draft';
}

/** @param {string} dir @returns {string} short commit of the package's last change, or '' */
function lastCommit(dir) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%h', '--', '.'], { cwd: dir, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** @param {string} dir */
function uncommitted(dir) {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: dir, encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
}

// ---------- page ----------

const STYLE = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a design dossier. Sticky document index on the left, one long reading column. */
:root {
  --bg: #f4f6f9; --surface: #ffffff; --fg: #18202c; --muted: #5a6677; --line: #d9dfe8;
  --accent: #1f56c3; --accent-soft: #e5edfb;
  --ok: #1d7a4c; --ok-soft: #e1f3e9; --warn: #9a5b00; --warn-soft: #fbf0dc; --neutral-soft: #eceff4;
  --font-body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-head: "IBM Plex Sans Condensed", "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0e131a; --surface: #151c26; --fg: #e2e8f0; --muted: #98a4b5; --line: #263142;
  --accent: #7fa6ff; --accent-soft: #1b2944;
  --ok: #6fd19f; --ok-soft: #14301f; --warn: #f0b85a; --warn-soft: #33270f; --neutral-soft: #1d2531;
  color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0e131a; --surface: #151c26; --fg: #e2e8f0; --muted: #98a4b5; --line: #263142;
  --accent: #7fa6ff; --accent-soft: #1b2944;
  --ok: #6fd19f; --ok-soft: #14301f; --warn: #f0b85a; --warn-soft: #33270f; --neutral-soft: #1d2531;
  color-scheme: dark; }
body { background: var(--bg); color: var(--fg); font: 15px/1.6 var(--font-body); }
.wrap { max-width: 1180px; margin: 0 auto; padding-inline: 16px; padding-block: 24px 64px;
  display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 40px; }
header.top { grid-column: 1 / -1; display: grid; gap: 10px; border-bottom: 1px solid var(--line); padding-bottom: 20px; }
.eyebrow { font: 500 12px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { font: 600 clamp(26px, 4vw, 36px)/1.15 var(--font-head); margin: 0; text-wrap: balance; }
.facts { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--muted); font-size: 13px; }
.facts b { color: var(--fg); font-weight: 500; }
.pill { display: inline-block; font: 500 12px/1 var(--font-mono); padding: 5px 9px; border-radius: 999px; background: var(--neutral-soft); color: var(--fg); }
.pill.ready { background: var(--ok-soft); color: var(--ok); }
.pill.review, .pill.loop { background: var(--warn-soft); color: var(--warn); }
.pill.draft { background: var(--neutral-soft); color: var(--muted); }
nav.index { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 16px); align-self: start; display: grid; gap: 2px; font-size: 14px; }
nav.index a { color: var(--muted); text-decoration: none; padding: 6px 10px; border-radius: 6px; border-left: 2px solid transparent; }
nav.index a:hover, nav.index a:focus-visible { color: var(--fg); background: var(--accent-soft); outline: none; }
nav.index a.here { color: var(--accent); border-left-color: var(--accent); background: var(--accent-soft); }
main { min-width: 0; display: grid; gap: 56px; }
section.doc { min-width: 0; }
section.doc > .doc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  border-bottom: 2px solid var(--fg); padding-bottom: 8px; margin-bottom: 8px; }
section.doc > .doc-head h2 { font: 600 24px/1.2 var(--font-head); margin: 0; }
section.doc > .doc-head .src { font: 12px var(--font-mono); color: var(--muted); }
.body { max-width: 72ch; overflow-wrap: anywhere; }
.body th, .body td, .body pre { overflow-wrap: normal; }
.body h2 { font: 600 20px/1.3 var(--font-head); margin: 32px 0 8px; text-wrap: balance; }
.body h3 { font: 600 17px/1.35 var(--font-head); margin: 28px 0 6px; text-wrap: balance; }
.body h4, .body h5, .body h6 { font: 600 15px/1.4 var(--font-body); margin: 20px 0 4px; }
.body p { margin: 8px 0; }
.body ul, .body ol { margin: 8px 0; padding-left: 22px; }
.body li { margin: 3px 0; }
.body li.task { list-style: none; margin-left: -20px; display: flex; gap: 8px; align-items: baseline; }
.check { flex: none; width: 13px; height: 13px; border: 1.5px solid var(--muted); border-radius: 3px; transform: translateY(2px); }
.check.done { background: var(--ok); border-color: var(--ok); }
.body a { color: var(--accent); }
.body code { font: .9em var(--font-mono); background: var(--neutral-soft); padding: 1px 5px; border-radius: 4px; }
.body code.path { color: var(--muted); }
.body hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
.body blockquote { margin: 12px 0; padding: 4px 16px; border-left: 3px solid var(--accent); background: var(--surface); }
.key { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; max-width: 72ch; }
.key summary { cursor: pointer; font-weight: 500; }
.key p { color: var(--muted); font-size: 14px; margin: 8px 0 0; }
a.id { text-decoration: none; }
a.id:hover, a.id:focus-visible { background: var(--accent); color: var(--surface); outline: none; }
.id[title] { cursor: help; }
a.id[title] { cursor: pointer; }
tr:target, p:target, h2:target, h3:target, h4:target { background: var(--accent-soft); }
tr[id], p[id], h2[id], h3[id], h4[id] { scroll-margin-top: calc(env(safe-area-inset-top, 0px) + 16px); }
.id { font: 500 .82em var(--font-mono); color: var(--accent); background: var(--accent-soft); padding: 1px 5px; border-radius: 4px; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; margin: 12px 0; max-width: 100%; }
.body .scroll { max-width: min(100%, calc(100vw - 32px)); }
table { border-collapse: collapse; font-size: 14px; background: var(--surface); min-width: 60%; }
th, td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid var(--line); }
th { font: 600 12px/1.3 var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--muted); border-bottom: 1.5px solid var(--fg); white-space: nowrap; }
pre { margin: 0; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; font: 13px/1.5 var(--font-mono); }
pre code { background: none; padding: 0; }
.diagram pre.mermaid { background: var(--surface); text-align: center; }
.note { font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 12px; }
.top-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.theme-toggle { font: 500 12px/1 var(--font-mono); color: var(--muted); background: var(--surface); border: 1px solid var(--line);
  border-radius: 999px; padding: 6px 11px; cursor: pointer; }
.theme-toggle:hover, .theme-toggle:focus-visible { color: var(--fg); border-color: var(--accent); outline: none; }
@media (max-width: 760px) {
  .wrap { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  nav.index { position: static; display: flex; flex-wrap: wrap; gap: 4px; }
  nav.index a { border-left: 0; border: 1px solid var(--line); }
}
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
</style>`;

// Light/dark toggle. The stylesheet follows the system setting until the reader picks
// one; the pick sets data-theme on <html> and is remembered per page where storage works.
const THEME_KEY = 'design-review-theme';

/** Applies a remembered theme before the page paints, so it doesn't flash the other one. */
const THEME_BOOT = `
<script>
(function () {
  try {
    var t = localStorage.getItem('${THEME_KEY}');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
</script>`;

/** The toggle button; hidden until the script below wires it, so it never shows dead. */
const THEME_BUTTON = '<button type="button" class="theme-toggle" hidden></button>';

const THEME_SCRIPT = `
<script>
(function () {
  var root = document.documentElement;
  var btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function current() { return root.getAttribute('data-theme') || (mq && mq.matches ? 'dark' : 'light'); }
  function label() {
    var next = current() === 'dark' ? 'light' : 'dark';
    btn.textContent = next === 'dark' ? '\\u263E Dark' : '\\u2600 Light';
    btn.setAttribute('aria-label', 'Switch to ' + next + ' mode');
  }
  btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('${THEME_KEY}', next); } catch (e) {}
    label();
  });
  if (mq && mq.addEventListener) mq.addEventListener('change', label);
  label();
  btn.hidden = false;
})();
</script>`;

const SCRIPT = `
<script>
// Highlight the document being read in the index.
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('nav.index a'));
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  if (!('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a) { a.classList.remove('here'); });
      var a = byId[e.target.id];
      if (a) a.classList.add('here');
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  document.querySelectorAll('section.doc').forEach(function (s) { io.observe(s); });
})();
</script>`;

// Mermaid for --standalone pages. Pinned with a Subresource Integrity hash, so a changed
// file on the CDN is refused rather than run. The UMD build sets globalThis.mermaid.
const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
const MERMAID_SRI = 'sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I';

/**
 * Draws every pre.mermaid in the page's light or dark scheme, and again when the reader
 * switches. Each diagram keeps its source, so a redraw starts from it; a diagram Mermaid
 * can't parse, or a failed load (offline, blocked, integrity mismatch), leaves the source.
 */
const MERMAID_SCRIPT = `
<script src="${MERMAID_SRC}" integrity="${MERMAID_SRI}" crossorigin="anonymous"></script>
<script>
(function () {
  var m = window.mermaid;
  var blocks = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid'));
  if (!m || !blocks.length) return;
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var sources = blocks.map(function (b) { return b.textContent; });
  var n = 0;
  function dark() {
    var t = root.getAttribute('data-theme');
    return t ? t === 'dark' : !!(mq && mq.matches);
  }
  function draw() {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark() ? 'dark' : 'default' });
    blocks.forEach(function (b, i) {
      m.render('mermaid-' + (n++), sources[i]).then(function (r) { b.innerHTML = r.svg; }, function () { b.textContent = sources[i]; });
    });
  }
  draw();
  new MutationObserver(draw).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (!root.getAttribute('data-theme')) draw(); });
})();
</script>`;

/**
 * Wraps a fragment as a whole HTML document, for a page opened as a file: the doctype
 * keeps it out of quirks mode, which the artifact host otherwise provides.
 * @param {string} html @returns {string}
 */
function standaloneDocument(html) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
${html}</body>
</html>
`;
}

/**
 * The first http(s) URL in an index field, as a new-tab link; '' when there is none.
 * @param {string | undefined} value @param {string} label @returns {string}
 */
function fieldLink(value, label) {
  const m = (value || '').match(/https?:\/\/[^\s)>\]|]+/);
  return m ? `<a href="${esc(m[0])}" target="_blank" rel="noopener">${esc(label)}</a>` : '';
}

/** @param {Record<string,string>} opts */
function renderPackage(opts) {
  const dir = path.resolve(opts.dir);
  const readmePath = path.join(dir, 'README.md');
  if (!fs.existsSync(readmePath)) throw new Error(`No README.md in ${dir} — is this a design package?`);
  const { name, fields } = indexFacts(fs.readFileSync(readmePath, 'utf8'));
  const title = opts.title || name;
  const status = (fields.status || 'Draft').replace(/[<>]/g, '');
  const commit = lastCommit(dir);
  const dirty = uncommitted(dir);
  const date = new Date().toISOString().slice(0, 10);
  const prototype = fieldLink(fields.prototype, 'Open prototype');

  /** @type {[string, string, string][]} id, label, html */
  const sections = [];
  const summary = opts.summary || path.join(dir, 'review.md');
  /** @type {[string, string, string][]} id, label, markdown source, in reading order */
  const sources = [];
  if (fs.existsSync(summary)) sources.push(['overview', 'Overview', fs.readFileSync(summary, 'utf8')]);
  for (const [file, id, label] of DOCS) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) sources.push([id, label, fs.readFileSync(p, 'utf8')]);
  }
  // Every document is scanned before any is rendered, so an ID can point at a later document.
  ID_DEFS = new Map();
  ID_AREAS = new Map();
  for (const [id, , md] of sources) collectIds(md, id);
  for (const [id, label, md] of sources) sections.push([id, label, renderMarkdown(md, id)]);

  const facts = [
    `<span class="pill ${statusClass(status)}">${esc(status)}</span>`,
    fields.owner ? `<span>Owner <b>${esc(fields.owner)}</b></span>` : '',
    opts.round ? `<span>Review round <b>${esc(opts.round)}</b></span>` : '',
    prototype ? `<span>${prototype}</span>` : '',
    `<span>Rendered <b>${date}</b>${commit ? ` from <b>${esc(commit)}</b>` : ''}${dirty ? ' (with uncommitted edits)' : ''}</span>`,
  ].filter(Boolean).join('');

  return `<title>${esc(title)}</title>
${STYLE}
${THEME_BOOT}
<div class="wrap">
<header class="top">
  <div class="top-row"><div class="eyebrow">Design package · ${esc(path.basename(dir))}</div>${THEME_BUTTON}</div>
  <h1>${esc(name || title)}</h1>
  <div class="facts">${facts}</div>
</header>
<nav class="index" aria-label="Documents">
${sections.map(([id, label]) => `  <a href="#${id}">${esc(label)}</a>`).join('\n')}
</nav>
<main>
${renderKey()}
${sections.map(([id, label, html]) => `<section class="doc" id="${id}">
<div class="doc-head"><h2>${esc(label)}</h2>${id === 'overview' ? '' : `<span class="src">${esc(DOCS.find((d) => d[1] === id)[0])}</span>`}</div>
<div class="body">
${html}</div>
</section>`).join('\n')}
<p class="note">Rendered from the markdown in the repository, which stays the source of truth. Comment on anything here; the product lead collects comments into the next decision round.</p>
</main>
</div>
${THEME_SCRIPT}
${SCRIPT}
${opts.standalone && sections.some(([, , html]) => html.includes('<pre class="mermaid">')) ? MERMAID_SCRIPT : ''}
`;
}

/** @param {Record<string,string>} opts */
function renderHub(opts) {
  const root = path.resolve(opts.dir);
  const pkgs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'README.md')))
    .map((d) => {
      const { name, fields } = indexFacts(fs.readFileSync(path.join(root, d.name, 'README.md'), 'utf8'));
      return { slug: d.name, name: name || d.name, fields };
    })
    .sort((a, b) => (b.fields['last updated'] || '').localeCompare(a.fields['last updated'] || ''));
  const date = new Date().toISOString().slice(0, 10);
  /**
   * An index field's link, or muted fallback text when it holds no URL.
   * @param {string | undefined} v @param {string} label @param {string} none @returns {string}
   */
  const linkOf = (v, label, none) => fieldLink(v, label) || `<span class="note-inline">${esc(none)}</span>`;
  const rows = pkgs.map((p) => {
    const status = (p.fields.status || 'Draft').replace(/[<>]/g, '');
    return `<tr><td><b>${esc(p.name)}</b><br><code class="path">${esc(p.slug)}</code></td>
<td><span class="pill ${statusClass(status)}">${esc(status)}</span></td>
<td>${esc(p.fields.owner || '')}</td><td style="font-variant-numeric: tabular-nums">${esc(p.fields['last updated'] || '')}</td>
<td>${linkOf(p.fields['review page'], 'Open review', 'Not published')}</td>
<td>${linkOf(p.fields.prototype, 'Open prototype', '—')}</td></tr>`;
  }).join('\n');
  const title = opts.title || 'Design packages';

  return `<title>${esc(title)}</title>
${STYLE}
<style>.wrap.hub { grid-template-columns: minmax(0, 1fr); } .note-inline { color: var(--muted); font-size: 13px; }</style>
${THEME_BOOT}
<div class="wrap hub">
<header class="top">
  <div class="top-row"><div class="eyebrow">Design hub · ${esc(path.basename(root))}</div>${THEME_BUTTON}</div>
  <h1>${esc(title)}</h1>
  <div class="facts"><span><b>${pkgs.length}</b> package${pkgs.length === 1 ? '' : 's'}</span><span>Updated <b>${date}</b></span></div>
</header>
<main>
<section class="doc" id="packages">
<div class="body" style="max-width:none">
${pkgs.length ? `<div class="scroll"><table><thead><tr><th>Initiative</th><th>Status</th><th>Owner</th><th>Last updated</th><th>Review page</th><th>Prototype</th></tr></thead><tbody>
${rows}
</tbody></table></div>` : '<p>No design packages yet.</p>'}
</div>
</section>
<p class="note">Each review page and prototype is private until its owner shares it. The markdown packages in the repository are the source of truth.</p>
</main>
</div>
${THEME_SCRIPT}
`;
}

// ---------- main ----------

const { cmd, opts } = parseArgs(process.argv.slice(2));
try {
  if (!opts.dir || !opts.out || !['package', 'hub'].includes(cmd)) {
    throw new Error('usage: render-review.mjs package --dir <package> --title <t> --out <file> [--round n] [--summary <file>] [--standalone]\n       render-review.mjs hub --dir <packages_dir> --title <t> --out <file> [--standalone]');
  }
  const fragment = cmd === 'package' ? renderPackage(opts) : renderHub(opts);
  const html = opts.standalone ? standaloneDocument(fragment) : fragment;
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, html, 'utf8');
  console.log(`wrote ${opts.out} (${Math.round(html.length / 1024)} KB)`);
} catch (err) {
  console.error(String(err.message || err));
  process.exit(1);
}
