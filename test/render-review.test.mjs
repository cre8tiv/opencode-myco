// render-review turns a design package's markdown into one page reviewers read and
// comment on. It must show what's written faithfully, and it must never let text in a
// package, which people and agents edit, become live markup on a page shared in a
// company's workspace.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { sandbox, runNode, script } from './helpers.mjs';

const RENDER = script('design-team', 'render-review.mjs');

const README = [
  '# Order exceptions',
  '',
  '| | |',
  '| --- | --- |',
  '| **Status** | Ready for engineering |',
  '| **Owner** | Dana Whitfield |',
  '| **Last updated** | 2026-10-10 |',
  '| **Review page** | [open](https://claude.ai/artifact/abc123) |',
  '',
  'Index of the package.',
].join('\n');

/** Writes a package directory and returns its path. */
function pkg(sb, docs = {}, name = 'order-exceptions') {
  const dir = join(sb.root, 'docs', 'design', name);
  mkdirSync(dir, { recursive: true });
  const files = { 'README.md': README, ...docs };
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text, 'utf8');
  return dir;
}

/** Renders a package and returns the HTML. */
async function render(sb, dir, extra = []) {
  const out = join(sb.root, 'out', 'review.html');
  const r = await runNode(RENDER, { args: ['package', '--dir', dir, '--title', 'Order exceptions review', '--out', out, ...extra], cwd: sb.root, env: sb.env });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(out, 'utf8');
}

/** Renders one markdown document as the PRD section and returns just that section's body. */
async function renderDoc(sb, markdown) {
  const html = await render(sb, pkg(sb, { 'prd.md': markdown }));
  const m = html.match(/<section class="doc" id="prd">[\s\S]*?<div class="body">\n([\s\S]*?)<\/div>\n<\/section>/);
  assert.ok(m, 'prd section not found');
  return m[1];
}

describe('the page', () => {
  test('has a section and a nav entry for each document present, in reading order', async (t) => {
    const sb = sandbox(t);
    const html = await render(sb, pkg(sb, {
      'review.md': '# Overview\n\nWhat this is.',
      'prd.md': '# PRD',
      'tech-design.md': '# Tech',
      'architecture.md': '# Arch',
      'ux.md': '# UX',
    }));
    const order = [...html.matchAll(/<section class="doc" id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['overview', 'package', 'prd', 'ux', 'architecture', 'tech-design']);
    const nav = [...html.matchAll(/<a href="#([\w-]+)">/g)].map((m) => m[1]);
    assert.deepEqual(nav, order);
  });

  test('takes its facts from the package index', async (t) => {
    const sb = sandbox(t);
    const html = await render(sb, pkg(sb), ['--round', '3']);
    assert.match(html, /<h1>Order exceptions<\/h1>/);
    assert.match(html, /<span class="pill ready">Ready for engineering<\/span>/);
    assert.match(html, /Owner <b>Dana Whitfield<\/b>/);
    assert.match(html, /Review round <b>3<\/b>/);
    assert.match(html, /<title>Order exceptions review<\/title>/);
  });

  test('has no document shell of its own, since the artifact host supplies one', async (t) => {
    const sb = sandbox(t);
    const html = await render(sb, pkg(sb));
    assert.equal(/<html|<head>|<body/i.test(html), false);
  });

  test('status decides the pill', async (t) => {
    const sb = sandbox(t);
    const cases = [['Ready for engineering', 'ready'], ['In review', 'review'], ['Decision round 2', 'loop'], ['Draft — 4 open questions', 'draft']];
    for (const [status, cls] of cases) {
      const dir = pkg(sb, { 'README.md': README.replace('Ready for engineering', status) });
      assert.match(await render(sb, dir), new RegExp(`<span class="pill ${cls}">`), status);
    }
  });

  test('a package index with no status reads as a draft', async (t) => {
    const sb = sandbox(t);
    const html = await render(sb, pkg(sb, { 'README.md': '# Bare\n\nNo header table.' }));
    assert.match(html, /<span class="pill draft">Draft<\/span>/);
  });

  test('says so, and writes nothing, when the directory is not a package', async (t) => {
    const sb = sandbox(t);
    const empty = join(sb.root, 'empty');
    mkdirSync(empty);
    const out = join(sb.root, 'out.html');
    const r = await runNode(RENDER, { args: ['package', '--dir', empty, '--out', out], cwd: sb.root, env: sb.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No README\.md/);
    assert.equal(existsSync(out), false);
  });

  test('explains usage when called wrongly', async (t) => {
    const sb = sandbox(t);
    for (const args of [[], ['package'], ['package', '--dir', sb.root], ['frobnicate', '--dir', sb.root, '--out', 'x.html']]) {
      const r = await runNode(RENDER, { args, cwd: sb.root, env: sb.env });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /usage: render-review\.mjs/);
    }
  });

  test('uses an explicit summary file as the Overview', async (t) => {
    const sb = sandbox(t);
    const dir = pkg(sb, { 'prd.md': '# PRD' });
    const summary = join(sb.root, 'round-2-summary.md');
    writeFileSync(summary, '# Round 2\n\nWhat changed since round 1.');
    const html = await render(sb, dir, ['--summary', summary]);
    assert.match(html, /<section class="doc" id="overview">[\s\S]*What changed since round 1/);
  });
});

describe('never becomes live markup', () => {
  test('raw HTML in the source is shown as text', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, [
      '# <script>alert(1)</script> PRD',
      '',
      'Plain <img src=x onerror=alert(2)> text and <b>bold</b>.',
      '',
      '| <th onclick=x> | b |',
      '| --- | --- |',
      '| <iframe src=//evil></iframe> | ok |',
    ].join('\n'));
    assert.equal(/<script|<img|<iframe|<b>|onerror=alert\(2\)>/.test(body), false, body);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(body, /&lt;img src=x onerror=alert\(2\)&gt;/);
  });

  test('link labels, hrefs and code are escaped', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, [
      '[<b>x</b>](https://example.com/a"onmouseover="alert(1))',
      '',
      '[click](javascript:alert(1))',
      '',
      '`<script>x</script>`',
      '',
      '```',
      '<script>alert(3)</script>',
      '```',
    ].join('\n'));
    assert.equal(/<script|<b>x|onmouseover="alert/.test(body), false, body);
    // A javascript: URL is not a link at all: it is shown as a path.
    assert.equal(/href="javascript:/i.test(body), false);
    assert.match(body, /click <code class="path">javascript:alert/);
  });

  test('HTML comments, where agents leave notes to themselves, do not render', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, 'Visible.\n\n<!-- TODO ask security about SEC-9 -->\n\nAlso visible.\n\n<!--\nmulti\nline\n-->\n');
    assert.match(body, /Visible\./);
    assert.match(body, /Also visible\./);
    assert.equal(/SEC-9|multi/.test(body), false);
  });
});

describe('markdown fidelity', () => {
  test('headings: the document title sits one level down, and ids are prefixed per document', async (t) => {
    const sb = sandbox(t);
    const html = await render(sb, pkg(sb, { 'prd.md': '# PRD\n\n## Scope\n', 'ux.md': '# UX\n\n## Scope\n' }));
    assert.match(html, /<h2 id="prd-prd">PRD<\/h2>/);
    assert.match(html, /<h3 id="prd-scope">Scope<\/h3>/);
    assert.match(html, /<h3 id="ux-scope">Scope<\/h3>/);
  });

  test('tables: header, rows, escaped pipes, inline code, short rows', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, [
      '| ID | Requirement | Phase |',
      '| --- | --- | :-: |',
      '| APR-1 | Admins approve with `a \\| b` | 1 |',
      '| APR-2 | only two cells |',
    ].join('\n'));
    assert.match(body, /<th>ID<\/th><th>Requirement<\/th><th>Phase<\/th>/);
    assert.match(body, /<code>a \\\| b<\/code>|<code>a \| b<\/code>/);
    // The short row is padded to the header's width rather than breaking the table.
    assert.equal((body.match(/<tr[^>]*><td>/g) || []).length, 2);
    assert.match(body, /<tr id="prd-id-apr-2"><td><span class="id" title="only two cells">APR-2<\/span><\/td><td>only two cells<\/td><td><\/td><\/tr>/);
  });

  test('task lists show done and not-done', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, '- [x] PRD complete\n- [ ] Security sign-off\n- plain item');
    assert.match(body, /<li class="task"><span class="check done" aria-label="done"><\/span>PRD complete<\/li>/);
    assert.match(body, /<li class="task"><span class="check" aria-label="not done"><\/span>Security sign-off<\/li>/);
    assert.match(body, /<li>plain item<\/li>/);
  });

  test('nested and ordered lists keep their structure', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, ['1. First', '2. Second', '   - nested a', '   - nested b', '3. Third', '', '- bullet'].join('\n'));
    assert.match(body, /<ol>\n<li>First<\/li>\n<li>Second<ul>\n<li>nested a<\/li>\n<li>nested b<\/li>\n<\/ul>\n<\/li>\n<li>Third<\/li>\n<\/ol>/);
    assert.match(body, /<ul>\n<li>bullet<\/li>\n<\/ul>/);
  });

  test('mermaid fences become diagram blocks; other fences stay code', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, ['```mermaid', 'flowchart LR', '  A --> B', '```', '', '```json', '{ "a": "<b>" }', '```'].join('\n'));
    assert.match(body, /<pre class="mermaid">flowchart LR\n {2}A --&gt; B<\/pre>/);
    assert.match(body, /<pre><code>\{ &quot;a&quot;: &quot;&lt;b&gt;&quot; \}<\/code><\/pre>/);
  });

  test('blockquotes, rules, emphasis and bold', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, '> Note: *read* this **first**\n\n---\n\nAfter.');
    assert.match(body, /<blockquote><p>Note: <em>read<\/em> this <strong>first<\/strong><\/p>\n<\/blockquote>/);
    assert.match(body, /<hr>/);
  });

  test('Windows line endings render the same as Unix ones', async (t) => {
    const sb = sandbox(t);
    const md = '# PRD\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two\n';
    assert.equal(await renderDoc(sb, md.replace(/\n/g, '\r\n')), await renderDoc(sb, md));
  });
});

describe('design IDs', () => {
  test('requirement, decision, control, threat and ADR IDs become chips', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, 'APR-3 satisfies SEC-2 (threat T-4) per ADR-7 and D-12 for A-2.');
    for (const id of ['APR-3', 'SEC-2', 'T-4', 'ADR-7', 'D-12', 'A-2']) assert.match(body, new RegExp(`<span class="id">${id}</span>`), id);
  });

  test('an ID defined in a table shows its definition and links to its row, from any document', async (t) => {
    const sb = sandbox(t);
    const html = await render(sb, pkg(sb, {
      'prd.md': ['## Actors', '', '| ID | Actor | Context |', '| --- | --- | --- |', '| A-1 | IT operations admin | Rotates credentials in the Admin UI |', '', '## Scenarios', '', '| ID | Actor | What happens |', '| --- | --- | --- |', '| SC-1 | A-1 | Rotates a Salesforce credential while disabled |'].join('\n'),
      'tech-design.md': 'Slice S3 covers SC-1 for A-1 and also NOPE-9.',
    }));
    const prd = html.match(/<section class="doc" id="prd">[\s\S]*?<\/section>/)[0];
    const tech = html.match(/<section class="doc" id="tech-design">[\s\S]*?<\/section>/)[0];
    // The defining row carries the anchor, and its own ID doesn't link to itself.
    assert.match(prd, /<tr id="prd-id-a-1"><td><span class="id" title="IT operations admin — Rotates credentials in the Admin UI">A-1<\/span>/);
    // A later document's chip links to it and carries the same words, in any document.
    assert.match(tech, /<a class="id" href="#prd-id-sc-1" title="A-1 — Rotates a Salesforce credential while disabled">SC-1<\/a>/);
    assert.match(tech, /<a class="id" href="#prd-id-a-1" title="IT operations admin[^"]*">A-1<\/a>/);
    // An ID nothing defines stays a plain chip.
    assert.match(tech, /<span class="id">NOPE-9<\/span>/);
  });

  test('an ID inside a link stays a chip, because links can\'t nest', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, ['| ID | Requirement |', '| --- | --- |', '| CFR-76 | The request |', '', 'See [ticket CFR-76](https://example.com/CFR-76).'].join('\n'));
    assert.match(body, /<a href="https:\/\/example\.com\/CFR-76"[^>]*>ticket <span class="id" title="The request">CFR-76<\/span><\/a>/);
  });

  test('headings and bold lead-ins define IDs too', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, ['### ADR-1: Put a release gate over every release point', '', '> **SC-2 — Pause for maintenance** (A-1)', '> Disable on Saturday, enable on Sunday.', '', 'Both ADR-1 and SC-2 matter.'].join('\n'));
    assert.match(body, /<a class="id" href="#prd-adr-1-put-a-release-gate-over-every-release-point" title="Put a release gate over every release point">ADR-1<\/a>/);
    assert.match(body, /<p id="prd-id-sc-2"><strong>.*SC-2.* — Pause for maintenance<\/strong>/);
    assert.match(body, /<a class="id" href="#prd-id-sc-2" title="Pause for maintenance">SC-2<\/a>/);
  });

  test('a risk led into its first cell defines its ID', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, ['| Risk | Mitigation |', '| --- | --- |', '| **Accepted risk:** R-01: running queries finish | Log it |', '', 'See R-01.'].join('\n'));
    assert.match(body, /<tr id="prd-id-r-01">/);
    assert.match(body, /<a class="id" href="#prd-id-r-01" title="running queries finish">R-01<\/a>/);
  });

  test('a definition is escaped, since it comes from text people and agents edit', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, ['| ID | Requirement |', '| --- | --- |', '| X-1 | a "quoted" <b>bold</b> & more |', '', 'See X-1.'].join('\n'));
    assert.match(body, /title="a &quot;quoted&quot; &lt;b&gt;bold&lt;\/b&gt; &amp; more"/);
    assert.equal(body.includes('<b>'), false);
  });

  test('a key explains each prefix in use, naming areas from headings and falling back to the usual meaning', async (t) => {
    const sb = sandbox(t);
    const html = await render(sb, pkg(sb, {
      'prd.md': ['#### Enforcement on every surface (ENF)', '', '| ID | Requirement | Actor | Priority |', '| --- | --- | --- | --- |', '| ENF-1 | Every surface refuses a disabled connection | A-3 | P0 |', '| ENF-2 | Another one | A-3 | P0 |', '', '| ID | Actor | Context |', '| --- | --- | --- |', '| A-3 | Query user | Queries from a BI tool |'].join('\n'),
    }));
    const key = html.match(/<details class="key">[\s\S]*?<\/details>/)[0];
    assert.match(key, /What do codes like/);
    assert.match(key, /<td><code>ENF-n<\/code><\/td><td>Enforcement on every surface<\/td><td>2<\/td>/);
    assert.match(key, /<td><code>A-n<\/code><\/td><td>Actors<\/td><td>1<\/td>/);
  });

  test('there is no key when the package defines no IDs', async (t) => {
    const sb = sandbox(t);
    const html = await render(sb, pkg(sb, { 'prd.md': 'Plain text, and SEC-2 with no definition anywhere.' }));
    assert.equal(html.includes('class="key"'), false);
  });

  test('standard names that look like IDs are left alone', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, 'Uses UTF-8, SHA-256, TLS-1 and ISO-8601 with RFC-7519 tokens.');
    assert.equal(body.includes('class="id"'), false, body);
  });

  test('IDs inside code spans stay literal', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, 'Run `grep SEC-2 prd.md` to see it.');
    assert.match(body, /<code>grep SEC-2 prd\.md<\/code>/);
    assert.equal(body.includes('class="id"'), false);
  });
});

describe('links', () => {
  test('a link to another package document becomes an in-page anchor', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, [
      '[architecture](architecture.md#components)',
      '[the prd](./prd.md)',
      '[tech design](../order-exceptions/tech-design.md#traceability)',
      '[same page](#open-questions)',
    ].join('\n\n'));
    assert.match(body, /<a href="#architecture-components">architecture<\/a>/);
    assert.match(body, /<a href="#prd">the prd<\/a>/);
    assert.match(body, /<a href="#tech-design-traceability">tech design<\/a>/);
    assert.match(body, /<a href="#prd-open-questions">same page<\/a>/);
  });

  test('external links open in a new tab; repository paths a reviewer cannot open show as code', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, '[docs](https://example.com/docs) and [the handler](src/orders/handler.ts) and <https://example.com/raw>');
    assert.match(body, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener">docs<\/a>/);
    assert.match(body, /the handler <code class="path">src\/orders\/handler\.ts<\/code>/);
    assert.match(body, /<a href="https:\/\/example\.com\/raw" target="_blank" rel="noopener">https:\/\/example\.com\/raw<\/a>/);
  });
});

describe('YAML front matter', () => {
  const FRONT = ['---', 'type: design', 'title: LLM Gateway semantic routing — UX', 'description: >', '  How a user sets up routing.', 'resource: initiatives/ai-gateway-llm-advanced-routing', 'tags: [ux, routing]', 'timestamp: 2026-11-10', '---', '', ''].join('\n');
  /** Page text with tags removed. @param {string} html */
  const text = (html) => html.replace(/<[^>]+>/g, ' ');

  test('is not rendered on the page, in the Overview or any document', async (t) => {
    // Regression: every document in a real package began with this block, and it showed as a paragraph (7 times).
    const sb = sandbox(t);
    const docs = Object.fromEntries(['review.md', 'prd.md', 'architecture.md', 'security-review.md', 'tech-design.md', 'ux.md'].map((f) => [f, `${FRONT}## Section in ${f}\n\nBody.\n`]));
    const html = await render(sb, pkg(sb, { ...docs, 'README.md': `${FRONT}${README}` }));
    assert.equal((text(html).match(/resource: initiatives|type: design/g) || []).length, 0);
    for (const f of Object.keys(docs)) assert.ok(html.includes(`Section in ${f}`), f);
    assert.match(html, /<h1>Order exceptions<\/h1>/);
  });

  test('only a block at the very start counts; a later --- is still a rule', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, `${FRONT}Intro.\n\n---\n\nAfter the rule.\n`);
    assert.doesNotMatch(body, /type: design/);
    assert.match(body, /<p>Intro\.<\/p>/);
    assert.match(body, /<hr>/);
    assert.match(body, /After the rule\./);
  });

  test('a document that opens with a rule and never closes it keeps its text', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, '---\n\nNo front matter here.\n');
    assert.match(body, /No front matter here\./);
  });

  test('Windows line endings and a byte-order mark are handled', async (t) => {
    const sb = sandbox(t);
    const body = await renderDoc(sb, `﻿${FRONT}Body text.\n`.replace(/\n/g, '\r\n'));
    assert.doesNotMatch(body, /type: design/);
    assert.match(body, /Body text\./);
  });
});

describe('the light/dark toggle', () => {
  /** The inline scripts in a page, in order. @param {string} html */
  const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  /**
   * Runs the page's theme scripts against a minimal DOM and returns handles to it.
   * @param {string} html @param {{stored?: string, systemDark?: boolean, storageThrows?: boolean}} env
   */
  function boot(html, { stored = null, systemDark = false, storageThrows = false } = {}) {
    const attrs = {};
    const root = { getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; } };
    let onClick = null;
    const btn = { hidden: true, textContent: '', attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener: (_, f) => { onClick = f; } };
    const store = { value: stored };
    const localStorage = {
      getItem: () => { if (storageThrows) throw new Error('blocked'); return store.value; },
      setItem: (_, v) => { if (storageThrows) throw new Error('blocked'); store.value = v; },
    };
    const sandboxGlobals = {
      document: { documentElement: root, querySelector: (s) => (s === '.theme-toggle' ? btn : null), querySelectorAll: () => [] },
      window: { matchMedia: () => ({ matches: systemDark, addEventListener() {} }) },
      localStorage,
    };
    const theme = scripts(html).filter((s) => s.includes('theme'));
    assert.equal(theme.length, 2, 'expected a boot script and a toggle script');
    for (const s of theme) vm.runInNewContext(s, sandboxGlobals);
    return { attrs, btn, store, click: () => onClick() };
  }

  test('both the package page and the hub get the button, hidden until the script wires it', async (t) => {
    const sb = sandbox(t);
    const page = await render(sb, pkg(sb));
    assert.match(page, /<button type="button" class="theme-toggle" hidden><\/button>/);
    const hubDir = join(sb.root, 'docs', 'design');
    const out = join(sb.root, 'hub.html');
    const r = await runNode(RENDER, { args: ['hub', '--dir', hubDir, '--title', 'Hub', '--out', out], cwd: sb.root, env: sb.env });
    assert.equal(r.status, 0, r.stderr);
    const hubHtml = readFileSync(out, 'utf8');
    assert.match(hubHtml, /class="theme-toggle" hidden/);
    assert.equal(scripts(hubHtml).filter((s) => s.includes('theme')).length, 2);
  });

  test('the stylesheet answers both the system setting and an explicit choice', async (t) => {
    const sb = sandbox(t);
    const page = await render(sb, pkg(sb));
    assert.match(page, /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\)/);
    assert.match(page, /:root\[data-theme="dark"\] \{/);
  });

  test('clicking flips from the system theme and remembers the choice', async (t) => {
    const sb = sandbox(t);
    const page = await render(sb, pkg(sb));
    const ui = boot(page, { systemDark: false });
    assert.equal(ui.btn.hidden, false);
    assert.equal(ui.attrs['data-theme'], undefined);
    assert.equal(ui.btn.attributes['aria-label'], 'Switch to dark mode');
    ui.click();
    assert.equal(ui.attrs['data-theme'], 'dark');
    assert.equal(ui.store.value, 'dark');
    assert.equal(ui.btn.attributes['aria-label'], 'Switch to light mode');
    ui.click();
    assert.equal(ui.attrs['data-theme'], 'light');
  });

  test('a remembered choice applies on load and beats the system setting', async (t) => {
    const sb = sandbox(t);
    const ui = boot(await render(sb, pkg(sb)), { stored: 'light', systemDark: true });
    assert.equal(ui.attrs['data-theme'], 'light');
    assert.equal(ui.btn.attributes['aria-label'], 'Switch to dark mode');
  });

  test('blocked storage still toggles, and a junk stored value is ignored', async (t) => {
    const sb = sandbox(t);
    const page = await render(sb, pkg(sb));
    const blocked = boot(page, { storageThrows: true });
    blocked.click();
    assert.equal(blocked.attrs['data-theme'], 'dark');
    assert.equal(boot(page, { stored: '"><img onerror=alert(1)>' }).attrs['data-theme'], undefined);
  });
});

describe('the prototype link', () => {
  test('the page header links the index\'s Prototype row, and leaves it out when there is none', async (t) => {
    const sb = sandbox(t);
    const withProto = README.replace('| **Review page** |', '| **Prototype** | [canvas](https://claude.ai/artifact/canvas1) |\n| **Review page** |');
    const html = await render(sb, pkg(sb, { 'README.md': withProto }));
    assert.match(html, /<div class="facts">.*<a href="https:\/\/claude\.ai\/artifact\/canvas1" target="_blank" rel="noopener">Open prototype<\/a>/);
    const sb2 = sandbox(t);
    assert.doesNotMatch(await render(sb2, pkg(sb2)), /Open prototype/);
  });

  test('a Prototype row that is not a URL never becomes a link', async (t) => {
    const sb = sandbox(t);
    const bad = README.replace('| **Review page** |', '| **Prototype** | javascript:alert(1) "><b>x</b> |\n| **Review page** |');
    const html = await render(sb, pkg(sb, { 'README.md': bad }));
    assert.doesNotMatch(html, /Open prototype|href="javascript:/i);
  });
});

describe('the design hub', () => {
  const hubPackage = (sb, slug, readme) => {
    const dir = join(sb.root, 'docs', 'design', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), readme);
  };
  const header = (title, status, updated, review) =>
    [`# ${title}`, '', '| | |', '| --- | --- |', `| **Status** | ${status} |`, '| **Owner** | Dana |', `| **Last updated** | ${updated} |`, `| **Review page** | ${review} |`].join('\n');

  async function hub(sb) {
    const out = join(sb.root, 'hub.html');
    const r = await runNode(RENDER, { args: ['hub', '--dir', join(sb.root, 'docs', 'design'), '--title', 'Acme designs', '--out', out], cwd: sb.root, env: sb.env });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(out, 'utf8');
  }

  test('lists packages newest first, with status and a link to each review page', async (t) => {
    const sb = sandbox(t);
    hubPackage(sb, 'older', header('Older work', 'In review', '2026-09-01', '[open](https://claude.ai/artifact/old)'));
    hubPackage(sb, 'newer', header('Newer work', 'Ready for engineering', '2026-10-09', '[open](https://claude.ai/artifact/new)'));
    hubPackage(sb, 'unpublished', header('Not yet shared', 'Draft', '2026-10-01', '—'));
    const html = await hub(sb);
    const order = [...html.matchAll(/<td><b>([^<]+)<\/b>/g)].map((m) => m[1]);
    assert.deepEqual(order, ['Newer work', 'Not yet shared', 'Older work']);
    assert.match(html, /href="https:\/\/claude\.ai\/artifact\/new"/);
    assert.equal((html.match(/Not published/g) || []).length, 1);
    assert.match(html, /<b>3<\/b> packages/);
    assert.match(html, /<h1>Acme designs<\/h1>/);
  });

  test('links each package\'s primary prototype from its Prototype row', async (t) => {
    const sb = sandbox(t);
    hubPackage(sb, 'with', `${header('With canvas', 'In review', '2026-10-09', '[open](https://claude.ai/artifact/rev)')}\n| **Prototype** | [canvas](https://claude.ai/artifact/canvas1) |`);
    hubPackage(sb, 'without', header('No prototype', 'Draft', '2026-10-01', '—'));
    const html = await hub(sb);
    assert.match(html, /<th>Prototype<\/th>/);
    assert.match(html, /<a href="https:\/\/claude\.ai\/artifact\/canvas1" target="_blank" rel="noopener">Open prototype<\/a>/);
    assert.equal((html.match(/Open prototype/g) || []).length, 1);
  });

  test('ignores directories that are not packages, and says so when there are none', async (t) => {
    const sb = sandbox(t);
    mkdirSync(join(sb.root, 'docs', 'design', 'scratch'), { recursive: true });
    writeFileSync(join(sb.root, 'docs', 'design', 'notes.md'), 'not a package');
    const html = await hub(sb);
    assert.match(html, /No design packages yet/);
    assert.match(html, /<b>0<\/b> packages/);
  });

  test('a single package is "1 package"', async (t) => {
    const sb = sandbox(t);
    hubPackage(sb, 'only', header('Only one', 'Draft', '2026-10-01', '—'));
    assert.match(await hub(sb), /<b>1<\/b> package(?!s)/);
  });

  test('package names and owners are escaped', async (t) => {
    const sb = sandbox(t);
    hubPackage(sb, 'x', header('<script>alert(1)</script>', 'Draft', '2026-10-01', '—'));
    const html = await hub(sb);
    assert.equal(html.includes('<script>alert(1)'), false);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});
