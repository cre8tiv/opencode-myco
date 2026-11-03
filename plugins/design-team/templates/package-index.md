# Package index template

This becomes `docs/design/<slug>/README.md`: the first file anyone opens, and the contract the engineering tech lead reads before decomposing the work. Keep it current as documents change. Replace guidance with content.

---

```markdown
# <Initiative name>

| | |
| --- | --- |
| **Status** | <Framing | Drafting | In decision loop | In review | Ready for engineering> |
| **Owner** | <name> |
| **Last updated** | <date> |
| **Adopted from** | <source link, its version or date, and when it was fetched — or "new"> |
| **Review page** | <claude.ai artifact link, once published — or "not published"> |

<One paragraph: what this is and why, from the PRD's problem and positioning.>
```

## Documents

Table with columns `Document | Author | Status | Open questions`. List only the documents agreed for this package; for any standard document left out, add a row saying why (for example "UX — N/A, no user-facing surface").

| Document | Author | Status | Open questions |
| --- | --- | --- | --- |
| [PRD](prd.md) | product-lead | | |
| [Architecture](architecture.md) | architect | | |
| [Security review](security-review.md) | security-reviewer | | |
| [Tech design](tech-design.md) | tech-designer | | |
| [UX](ux.md) | ux-designer | | |

**Prototypes:** one line per prototype — surface, link or `ux/` path, and whether it has been published.

**Published copies:** one line per destination — where, link, date, and the version published.

## Codebases

The code this package was designed against, so engineering knows where the work lands and how far the code has moved since. Table with columns `Codebase | Role | Commit grounded at | Slices that change it`. One row per codebase from the architecture's *Grounded against* table — this repository included when it holds the code. *Role* is *this repo*, *system*, *contract* or *reference*, as in `.claude/team/knowledge.md`.

## Readiness

The product lead checks each item before setting status to **Ready for engineering**. Each is verifiable against the documents; tick it only after checking.

- [ ] No document has open questions.
- [ ] Every PRD requirement is in exactly one phase.
- [ ] Every P0 and P1 requirement appears in the tech design's traceability table.
- [ ] Every `SEC-n` control is a PRD requirement and appears in the tech design's traceability table.
- [ ] Every user-facing P0 requirement is covered by a UX flow, and every surface has its states defined. *(N/A without UX.)*
- [ ] Every ADR that constrains implementation is referenced from the tech design.
- [ ] No document contradicts a D-decision.
- [ ] Every dependency between delivery slices has a seam in the tech design, with failure and concurrency behavior.
- [ ] Every requirement names its actor (or "—" for system-wide), and every actor has at least one key scenario.
- [ ] Every actor, human or not, has an identity and permissions row in the security review. *(N/A without a security review.)*
- [ ] Each phase-1 scenario, traced through every document, agrees everywhere it appears: same actor, entity, values, field names, error codes and states.
- [ ] Reviewed: the review page's latest round has no thread still needing a decision, and sign-off is recorded. *(N/A when `design.md` sets `review_pages: none`.)*
- [ ] Every codebase grounded in is recorded with its commit, and every delivery slice names the one repository it changes.

## Review

Written by the `publish-review` skill. The review page is rendered from this package, with `review.md` as its Overview; comments on it feed the next decision round.

Table with columns `Round | Published | Commit | Threads (new / addressed / still open) | Decisions`. One row per publish.

**Sign-off:** who approved, when, and the round and commit they approved — or "pending".

## Handoff to engineering

Written for the engineering tech lead. It will turn this into tickets; don't pre-empt that by writing them here.

- **Build first:** the phase and requirement IDs that make up the first deliverable, and why they come first.
- **Suggested slices:** a pointer to the tech design's delivery slices.
- **Work in other repositories:** slices that change a repository other than this one, and who builds them. The tech lead in this repository builds only what lands here; the rest is handed over with the same package. Write "None" if everything lands here.
- **Constraints to honor:** the ADRs and `SEC-n` controls that are non-negotiable, by ID.
- **Acceptance comes from:** PRD requirements for behavior, UX state tables for what QA exercises, `SEC-n` "verified by" for security checks.
- **Deliberately undecided:** anything the package intentionally leaves to engineering, so it isn't mistaken for an oversight.
- **Route design questions back:** if implementation finds the design wrong, raise it against this package rather than silently diverging.

To start:

```
opencode        # select the engineering-team/tech-lead agent (Tab cycles agents)
> Implement phase 1 of <packages_dir>/<slug>/
```

## Engineering feedback

Written by the engineering tech lead when implementation shows part of the design is wrong, missing or impossible; triaged by the product lead as a decision round. Table with columns `# | Raised | Where | Problem | Status | Resolution`. One row per problem; never delete a row.

- **Raised:** the date, and the ticket or slice that hit it.
- **Where:** the requirement, ADR, `SEC-n` control or UX state the problem is about, by ID.
- **Problem:** what implementation found, with the evidence (the code, the contract, the error), so the product lead can decide without the engineering context.
- **Status:** *Open* until the product lead decides, then *Decided* (the design changed) or *Declined* (the design stands). An *Open* row blocks **Ready for engineering**.
- **Resolution:** the D-decision that settled it, and what it changed.

Write "None yet" when there are no rows.

## Change log

One line per update: date, what changed, and the decisions applied.
