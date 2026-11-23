// check-package.mjs does the counting part of a design package's readiness check: the
// things a model gets wrong by skimming. Each test starts from a package that passes and
// breaks one thing, because the useful question is whether the right problem is named.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox, runNode, script } from './helpers.mjs';

const CHECK = script('design-team', 'check-package.mjs');

const INDEX = `# Pick waves

| | |
| --- | --- |
| **Status** | Ready for engineering |
| **Owner** | Sam |

## Documents

| Document | Author | Status | Open questions |
| --- | --- | --- | --- |
| [PRD](prd.md) | product-lead | Done | 0 |

## Codebases

| Codebase | Role | Commit grounded at | Slices that change it |
| --- | --- | --- | --- |
| orders-service | this repo | 4f2a9c1 | S1, S2 |
| billing-contract | contract | \`a1b2c3d4e5f6\` | — |

## Readiness

- [x] No document has open questions.
- [x] Every PRD requirement is in exactly one phase.
`;

const PRD = `| | |
| --- | --- |
| **Status** | Decided |

## 4. Actors

| ID | Actor | Kind | Context | Need | Identity & permissions |
| --- | --- | --- | --- | --- | --- |
| A-1 | Warehouse picker | human | shift start | fast scan | badge |
| A-2 | Wave scheduler | system | nightly | release waves | service account |

## 5. Key scenarios

> **SC-1 — Shift start** (A-1, requirements PCK-1, PCK-2)
> As A-1 I scan a tote.

> **SC-2 — Nightly release** (A-2, requirements WAV-1)
> As A-2 the scheduler releases wave 14.

## 7. Functional requirements

### Picking

| ID | Requirement | Actor | Priority |
| --- | --- | --- | --- |
| PCK-1 | Scan confirms a pick | A-1 | P0 |
| PCK-2 | Short pick is flagged | A-1 | P1 |
| PCK-3 | Pick history export | A-1 | P2 |

### Waves

| ID | Requirement | Actor | Priority |
| --- | --- | --- | --- |
| WAV-1 | Wave released nightly | A-2 | P0 |

### Security

| ID | Requirement | Actor | Priority |
| --- | --- | --- | --- |
| SEC-1 | Scanner tokens expire | — | P0 |

## 10. Phasing

| Phase | Scope (requirement IDs) | Exit criteria |
| --- | --- | --- |
| 1 | PCK-1, PCK-2, WAV-1, SEC-1 | A pick completes end to end |
| 2 | PCK-3 | Export downloads |

## 13. Decisions

| # | Question | Decision |
| --- | --- | --- |
| D-1 | Scope | Picking first |
`;

const SECURITY = `| | |
| --- | --- |
| **Status** | Decided |

## 6. Required controls

| ID | Control | Mitigates | Priority | Verified by |
| --- | --- | --- | --- | --- |
| SEC-1 | Tokens expire in 8h | T-1 | P0 | integration test |

## 10. Resolved

None.
`;

const TECH = `| | |
| --- | --- |
| **Status** | Decided |

## 11. Traceability

| Requirement | Implemented in | Verified by |
| --- | --- | --- |
| PCK-1 | pick-service | e2e pick |
| PCK-2 | pick-service | unit |
| WAV-1 | scheduler | nightly test |
| SEC-1 | auth middleware | integration test |

## 14. Resolved

D-1 settled scope.
`;

const GOOD = { 'README.md': INDEX, 'prd.md': PRD, 'security-review.md': SECURITY, 'tech-design.md': TECH };

/**
 * Writes a package, with some files replaced, and runs the check.
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} [over] replacement text per file
 * @param {string[]} [extra] extra arguments
 */
async function check(t, over = {}, extra = []) {
  const sb = sandbox(t);
  const dir = join(sb.root, 'pkg');
  mkdirSync(dir);
  for (const [name, text] of Object.entries({ ...GOOD, ...over })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return runNode(CHECK, { args: [dir, ...extra] });
}
const edit = (text, from, to) => {
  assert.ok(text.includes(from), `fixture lacks: ${from}`);
  return text.replace(from, to);
};

describe('check-package.mjs', () => {
  test('a consistent package passes every check', async (t) => {
    const r = await check(t);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /All \d+ checks passed/);
  });

  test('--json reports each check, for a script to read', async (t) => {
    const r = await check(t, {}, ['--json']);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.ok(out.checks.length >= 7);
  });

  test('a requirement in no phase is named', async (t) => {
    const r = await check(t, { 'prd.md': edit(PRD, '| 2 | PCK-3 |', '| 2 | |') });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /PCK-3 is in no phase/);
  });

  test('a requirement in two phases is named, with both', async (t) => {
    const r = await check(t, { 'prd.md': edit(PRD, '| 2 | PCK-3 |', '| 2 | PCK-3, PCK-1 |') });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /PCK-1 is in 2 phases \(1, 2\)/);
  });

  test('a phase scope written as a range covers every ID in it', async (t) => {
    const prd = edit(edit(PRD, '| 1 | PCK-1, PCK-2, WAV-1, SEC-1 |', '| 1 | PCK-1–PCK-2, WAV-1, SEC-1 |'), '| 2 | PCK-3 |', '| 2 | PCK-3 |');
    assert.equal((await check(t, { 'prd.md': prd })).status, 0);
    const split = edit(prd, '| 2 | PCK-3 |', '| 2 | PCK-1..3 |');
    assert.match((await check(t, { 'prd.md': split })).stdout, /PCK-1 is in 2 phases/);
  });

  test('a P0 or P1 requirement missing from the traceability table is named; P2 need not be there', async (t) => {
    const r = await check(t, { 'tech-design.md': edit(TECH, '| PCK-2 | pick-service | unit |\n', '') });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /PCK-2 \(P1\) is not in the traceability table/);
    assert.doesNotMatch(r.stdout, /PCK-3/);
  });

  test('a blank cell in the traceability table fails', async (t) => {
    const r = await check(t, { 'tech-design.md': edit(TECH, '| WAV-1 | scheduler | nightly test |', '| WAV-1 | scheduler | |') });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /WAV-1: the traceability row has a blank cell/);
  });

  test('a security control that is not a PRD requirement, or not traced, fails', async (t) => {
    const security = edit(SECURITY, '| SEC-1 | Tokens expire in 8h | T-1 | P0 | integration test |', '| SEC-1 | Tokens expire in 8h | T-1 | P0 | integration test |\n| SEC-2 | Audit log | T-2 | P1 | review |');
    const r = await check(t, { 'security-review.md': security });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SEC-2 is a security control but not a PRD requirement/);
    assert.match(r.stdout, /SEC-2 is not in the traceability table/);
  });

  test('open questions fail whether the status line or the section says so', async (t) => {
    const byStatus = await check(t, { 'tech-design.md': edit(TECH, '| **Status** | Decided |', '| **Status** | Draft — 2 open questions |') });
    assert.match(byStatus.stdout, /tech-design\.md: status says 2 open questions/);
    const bySection = await check(t, { 'prd.md': edit(PRD, '## 13. Decisions', '## 13. Open questions\n\n1. Should exports be async?\n\n## 15. Decisions') });
    assert.match(bySection.stdout, /prd\.md: the Open questions section still has 1 line/);
  });

  test('an emptied Open questions section, or one that says none, passes', async (t) => {
    const prd = edit(PRD, '## 13. Decisions', '## 13. Open questions\n\nNone.\n\n## 14. Decisions');
    assert.equal((await check(t, { 'prd.md': prd })).status, 0);
  });

  test('a requirement naming an actor the PRD never defines fails, and an actor with no scenario fails', async (t) => {
    const r = await check(t, { 'prd.md': edit(PRD, '| PCK-3 | Pick history export | A-1 | P2 |', '| PCK-3 | Pick history export | A-9 | P2 |') });
    assert.match(r.stdout, /PCK-3: actor A-9 is not defined/);
    const noScenario = edit(PRD, '> **SC-2 — Nightly release** (A-2, requirements WAV-1)', '> **SC-2 — Nightly release** (requirements WAV-1)');
    assert.match((await check(t, { 'prd.md': noScenario })).stdout, /A-2 has no key scenario/);
  });

  test('a requirement with an empty Actor cell fails; "—" for system-wide is fine', async (t) => {
    const r = await check(t, { 'prd.md': edit(PRD, '| PCK-3 | Pick history export | A-1 | P2 |', '| PCK-3 | Pick history export |  | P2 |') });
    assert.match(r.stdout, /PCK-3: the Actor cell is empty/);
  });

  test('a codebase with no commit recorded fails', async (t) => {
    const r = await check(t, { 'README.md': edit(INDEX, '| 4f2a9c1 |', '| <commit> |') });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /orders-service: no commit recorded/);
  });

  test('an unreferenced ADR is advice, not a failure', async (t) => {
    const r = await check(t, { 'architecture.md': '## 11. Decisions\n\n### ADR-1: Use a queue\n\nBecause.\n' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /NOTE\s+ADR-1 not mentioned/);
  });

  test('Windows line endings do not change the result', async (t) => {
    const crlf = Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]));
    assert.equal((await check(t, crlf)).status, 0);
    assert.equal((await check(t, { ...crlf, 'prd.md': edit(PRD, '| 2 | PCK-3 |', '| 2 | |').replace(/\n/g, '\r\n') })).status, 1);
  });

  test('a heading inside a code fence is not a section', async (t) => {
    const prd = PRD + '\n```markdown\n## 13. Open questions\n\n1. Quoted from the template\n```\n';
    assert.equal((await check(t, { 'prd.md': prd })).status, 0);
  });

  test('--ready also requires the status and every readiness box', async (t) => {
    assert.equal((await check(t, {}, ['--ready'])).status, 0);
    const drafting = edit(INDEX, '| **Status** | Ready for engineering |', '| **Status** | In review |');
    const r = await check(t, { 'README.md': drafting }, ['--ready']);
    assert.match(r.stdout, /status is "In review"/);
    const unticked = await check(t, { 'README.md': edit(INDEX, '- [x] No document', '- [ ] No document') }, ['--ready']);
    assert.match(unticked.stdout, /not ticked: No document has open questions/);
    // The product lead runs it before ticking anything.
    assert.equal((await check(t, { 'README.md': drafting })).status, 0);
  });

  test('a directory with no index is not a package', async (t) => {
    const sb = sandbox(t);
    const r = await runNode(CHECK, { args: [sb.root] });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: check-package\.mjs/);
  });
});

test('the two copies of check-package.mjs are identical', () => {
  // The tech lead runs it from engineering-team, and the plugins can't import each other,
  // so each ships a copy (as with profile.mjs).
  const a = readFileSync(script('design-team', 'check-package.mjs'), 'utf8');
  const b = readFileSync(script('engineering-team', 'check-package.mjs'), 'utf8');
  assert.equal(b.replace(/\r\n/g, '\n'), a.replace(/\r\n/g, '\n'));
});

describe('engineering feedback in the index', () => {
  const HEAD = '\n## Engineering feedback\n\n| # | Raised | Where | Problem | Status | Resolution |\n| --- | --- | --- | --- | --- | --- |\n';
  const withRows = (...rows) => ({ 'README.md': INDEX + HEAD + rows.join('\n') + '\n' });

  test('a package with no feedback section, or "None yet", is unaffected', async (t) => {
    assert.equal((await check(t)).status, 0);
    assert.equal((await check(t, { 'README.md': INDEX + '\n## Engineering feedback\n\nNone yet.\n' })).status, 0);
  });

  test('an Open row fails, and says what it is about', async (t) => {
    const r = await check(t, withRows('| 1 | 2026-10-14 CLOUD-7 | PCK-2 | The scanner API has no short-pick event | Open | |'));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /feedback #1 is still Open: The scanner API has no short-pick event/);
  });

  test('Decided and Declined rows with a resolution pass, whatever the emphasis', async (t) => {
    const r = await check(t, withRows(
      '| 1 | 2026-10-14 | PCK-2 | No short-pick event | **Decided** | D-4: added an event to the tech design |',
      '| 2 | 2026-10-15 | ADR-1 | Queue is slow | Declined | D-5: accepted risk |',
    ));
    assert.equal(r.status, 0, r.stdout);
  });

  test('a settled row with no resolution, or a status that is not one of the three, fails', async (t) => {
    const r = await check(t, withRows('| 1 | d | PCK-2 | x | Decided | |', '| 2 | d | PCK-1 | y | In progress | D-3 |'));
    assert.match(r.stdout, /feedback #1 is decided but has no Resolution/);
    assert.match(r.stdout, /feedback #2: status "in progress" is not Open, Decided or Declined/);
  });

  test('an unfilled template row is ignored, and --ready is blocked by an Open one', async (t) => {
    assert.equal((await check(t, withRows('| <n> | <date> | <ID> | <problem> | <Open> | <D-n> |'))).status, 0);
    const r = await check(t, withRows('| 1 | d | PCK-2 | x | Open | |'), ['--ready']);
    assert.equal(r.status, 1);
  });
});

describe('UX prototypes', () => {
  const UX = (rows) => `| | |\n| --- | --- |\n| **Status** | All open questions resolved |\n\n## 4. Prototypes\n\n| Prototype | Kind | Link | Shows | Synced to |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## 5. Flows\n\nNone.\n`;
  const CANVAS = '| Picker flow | Claude Design canvas | [canvas](https://claude.ai/artifact/abc) | S-1, S-2 | round 2, D-1 |';

  test('every prototype with a published link passes; an unfilled template row is ignored', async (t) => {
    const r = await check(t, { 'ux.md': UX([CANVAS, '| <name> | <kind> | <link> | <S-n> | <round> |', '|  |  |  |  |  |']) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /PASS\s+Every UX prototype is published and linked from ux\.md/);
  });

  test('a prototype with only a ux/ path, or none, is named', async (t) => {
    const r = await check(t, { 'ux.md': UX([CANVAS, '| Settings | HTML prototype | not published — `ux/settings.html` | S-3 | round 2 |', '| Empty | HTML prototype | | S-4 | round 1 |']) });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Settings: no published claude\.ai link \(got "not published — `ux\/settings\.html`"\)/);
    assert.match(r.stdout, /Empty: no published claude\.ai link \(got "blank"\)/);
    assert.doesNotMatch(r.stdout, /Picker flow:/);
  });

  test('--local-prototypes: a ux/ file in the package counts as linked; a missing one is named', async (t) => {
    const SETTINGS = '| Settings | HTML prototype | `ux/settings.html` | S-3 | round 2 |';
    const ok = await check(t, { 'ux.md': UX([CANVAS, SETTINGS]), 'ux/settings.html': '<!doctype html>' }, ['--local-prototypes']);
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /PASS\s+Every UX prototype is in the package and linked from ux\.md/);
    const missing = await check(t, { 'ux.md': UX([SETTINGS, '| Empty | HTML prototype | | S-4 | round 1 |']) }, ['--local-prototypes']);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /Settings: ux\/settings\.html is not in the package/);
    assert.match(missing.stdout, /Empty: no claude\.ai link or ux\/ path \(got "blank"\)/);
  });

  test('without --local-prototypes a ux/ file is not published, even when it exists', async (t) => {
    const r = await check(t, { 'ux.md': UX(['| Settings | HTML prototype | `ux/settings.html` | S-3 | round 2 |']), 'ux/settings.html': '<!doctype html>' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Settings: no published claude\.ai link/);
  });

  test('--local-prototypes: the index Prototype row must name the primary ux/ path', async (t) => {
    const ux = UX(['| Picker flow | HTML prototype | `ux/picker.html` | S-1 | round 2 |']);
    const withRow = (cell) => ({ 'ux.md': ux, 'ux/picker.html': '<!doctype html>', 'README.md': INDEX.replace('| **Owner** | Sam |', `| **Owner** | Sam |\n| **Prototype** | ${cell} |`) });
    assert.equal((await check(t, withRow('`ux/picker.html`'), ['--local-prototypes'])).status, 0);
    const other = await check(t, withRow('`ux/old.html`'), ['--local-prototypes']);
    assert.match(other.stdout, /README\.md's Prototype row \(ux\/old\.html\) is not ux\.md's primary prototype \(ux\/picker\.html\)/);
  });

  test('a prototype marked stale fails', async (t) => {
    const r = await check(t, { 'ux.md': UX(['| Picker flow | Claude Design canvas | https://claude.ai/artifact/abc | S-1 | stale — synced to round 1 |']) });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Picker flow: marked stale/);
  });

  test('"stale" elsewhere in the row, such as a state named "stale model", is not a stale marker', async (t) => {
    // Regression: a real package's Shows cell listed the S-1 dialog states, one named "stale model".
    const row = '| Semantic Routing beta surfaces (primary) | Claude Design canvas | https://claude.ai/artifact/abc | S-1 dialog: empty, loading, stale model, error | Review round 2 … round 4, last D-decision drawn D-48 |';
    const r = await check(t, { 'ux.md': UX([row]) });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /PASS\s+Every UX prototype is published and linked from ux\.md/);
    const marked = await check(t, { 'ux.md': UX([row.replace('Review round 2 … round 4, last D-decision drawn D-48', 'stale — synced to round 3')]) });
    assert.equal(marked.status, 1);
    assert.match(marked.stdout, /Semantic Routing beta surfaces \(primary\): marked stale \(stale — synced to round 3\)/);
  });

  test('a table with no Synced to column: a cell starting "stale" fails, one merely containing it does not', async (t) => {
    const legacy = (cell) => `### Prototypes\n\n| Surface | Prototype | Notes |\n| --- | --- | --- |\n| Picker | https://claude.ai/artifact/abc | ${cell} |\n`;
    assert.equal((await check(t, { 'ux.md': legacy('shows the stale model state') })).status, 0);
    const r = await check(t, { 'ux.md': legacy('stale — synced to round 1') });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Picker: marked stale \(stale — synced to round 1\)/);
  });

  test('a legacy Prototypes table with no Link column passes when its rows hold URLs', async (t) => {
    const legacy = '### Prototypes\n\n| Surface | Prototype | Published |\n| --- | --- | --- |\n| Picker | https://claude.ai/artifact/abc | yes |\n';
    const ok = await check(t, { 'ux.md': legacy });
    assert.equal(ok.status, 0, ok.stdout);
    const missing = await check(t, { 'ux.md': legacy.replace('https://claude.ai/artifact/abc', '`ux/picker.html`') });
    assert.match(missing.stdout, /Picker: no published claude\.ai link \(got "blank"\)/);
  });

  test('a link to any host other than claude.ai is not a published prototype', async (t) => {
    const r = await check(t, { 'ux.md': UX(['| Picker flow | HTML prototype | https://internal-wiki.example/x | S-1 | round 2 |']) });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Picker flow: no published claude\.ai link \(got "https:\/\/internal-wiki\.example\/x"\)/);
    const legacy = '### Prototypes\n\n| Surface | Prototype |\n| --- | --- |\n| Picker | https://www.figma.com/file/abc |\n';
    assert.match((await check(t, { 'ux.md': legacy })).stdout, /Picker: no published claude\.ai link \(got "https:\/\/www\.figma\.com\/file\/abc"\)/);
  });

  test('the index Prototype row must match the primary prototype; a missing row is advice', async (t) => {
    const ux = UX([CANVAS]);
    const withRow = (url) => ({ 'ux.md': ux, 'README.md': INDEX.replace('| **Owner** | Sam |', `| **Owner** | Sam |\n| **Prototype** | ${url} |`) });
    assert.equal((await check(t, withRow('[canvas](https://claude.ai/artifact/abc)'))).status, 0);
    const stale = await check(t, withRow('https://claude.ai/artifact/old'));
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /README\.md's Prototype row \(https:\/\/claude\.ai\/artifact\/old\) is not ux\.md's primary prototype \(https:\/\/claude\.ai\/artifact\/abc\)/);
    const noRow = await check(t, { 'ux.md': ux });
    assert.equal(noRow.status, 0, noRow.stdout);
    assert.match(noRow.stdout, /NOTE\s+README\.md has no Prototype row/);
  });

  test('a Prototypes section marked N/A passes; a ux.md with no section gets advice, not a failure', async (t) => {
    const na = '## 4. Prototypes\n\nN/A — `ux_prototypes: wireframes`.\n';
    assert.equal((await check(t, { 'ux.md': na })).status, 0);
    const old = await check(t, { 'ux.md': '## 3. Surface inventory\n\nNone.\n' });
    assert.equal(old.status, 0, old.stdout);
    assert.match(old.stdout, /NOTE\s+ux\.md has no Prototypes section/);
  });
});

test('the UX template has the Prototypes section and columns the check reads', () => {
  const tpl = readFileSync(join(script('design-team', 'check-package.mjs'), '..', '..', 'templates', 'ux-template.md'), 'utf8');
  assert.match(tpl, /^## (\d+\. )?Prototypes$/m);
  assert.match(tpl, /Table with columns `Prototype \| Kind \| Link \| Shows \| Synced to`/);
});

test('the package index template has the feedback section the check reads', () => {
  const tpl = readFileSync(join(script('design-team', 'check-package.mjs'), '..', '..', 'templates', 'package-index.md'), 'utf8');
  assert.match(tpl, /^## Engineering feedback$/m);
  assert.match(tpl, /Table with columns `# \| Raised \| Where \| Problem \| Status \| Resolution`/);
});
