# design-team

Takes an idea — or an existing PRD or spec — to a decided **design package**: PRD, architecture, security review, tech design, and UX where there's a user surface, ready to hand to an engineering team.

| Agent | Writes | Runs |
| ----- | ------ | ---- |
| `product-lead` | `README.md` (package index), `prd.md` | As the session agent. Owns the conversation and the decision loop. |
| `architect` | `architecture.md` | Dispatched by the lead once positioning and deployment are decided. |
| `ux-designer` | `ux.md`, prototypes under `ux/` | Dispatched when there's a user-facing surface; alongside the architect. |
| `security-reviewer` | `security-review.md` | Dispatched once the architecture exists. |
| `tech-designer` | `tech-design.md` | Dispatched once architecture and security review exist. |

Plus two skills: `init-design`, which profiles where this project's design work lives and goes, and `publish-review`, which renders a package as a page to share.

Depends on [`team-ops`](../team-ops), installed with it, which captures how the team works so `agent-coach` can analyze it alongside any other team.

## Set up

Just start the product lead (below). If the project has no design profile yet, it offers to run setup first, in the same session, and carries straight on afterwards. You can also ask any session to run the `init-design` skill at any time, to refresh the profile.

Setup runs once per project. It detects where design docs already live in the repo, which systems this session can reach (tracker, Confluence, Notion, Linear, Figma). It asks only what it can't infer — where packages are published, who signs off, which design files to use — verifies each destination and source with a read-only call, and writes `.claude/team/design.md`. It also records the documentation and knowledge sources the team should ground in — product docs, API references, knowledge bases, including MCP servers that exist but aren't authorized yet — in `.claude/team/knowledge.md`, shared with the engineering team. The same file lists the codebases the designs ground in when they aren't this repository: the system being changed, contracts it builds against, references to imitate. Commit both files.

Skipping it works: the product lead asks the minimum as it goes. But it asks again next time, and it won't know about your Confluence space or Figma file unless told.

When setup finishes it ends on one concrete next step — adopting the PRD you mentioned, say. Inside the product lead's session it asks whether to go ahead; from any other session it gives you the command and a first message to paste.

## Start a session

In OpenCode's terminal UI, press Tab to cycle to the `design-team/product-lead` agent. For one unattended request:

```sh
opencode run --agent design-team/product-lead "Adopt the PRD at docs/prd.md"
```

The product lead has to run as the session agent rather than being dispatched from another session, because the decision loop needs you in the conversation. It works out which of three situations it's in:

- **A new idea** — describe it.
- **An existing PRD, spec or design** — point it at the file path, link, or paste it. It fetches the whole document, records where it came from, maps it into the package without dropping anything (content that doesn't fit goes to an *Imported — unplaced* appendix for you to place), keeps existing requirement IDs and decisions, and makes the gaps — missing sections, untestable requirements, unresolved "TBD"s, unverified dependencies — your first round of questions. The original is left untouched; the package becomes the working copy and is published back at milestones.
- **A package in progress** — it reads the package, tells you where it stands, and continues from the next step.

## How it works

1. **Frame** — what the thing is, who has the problem, and its positioning. Who has it means named **actors** — people, AI agents and systems — with the context they act in, not a generic "user". Confirmed with you before going further.
2. **Ground** — searches the tracker, wiki, design files and code for what already exists, classifying each dependency as exists-public, exists-internal, planned, or missing, with sources.
3. **Recommend** — a position with named wrinkles, plus which documents this work needs. A small change gets a smaller package.
4. **Draft** — the PRD, with actors, key scenarios told from each actor's point of view, IDed and phased requirements that name their actor, and open questions phrased as decisions.
5. **Dispatch** — each specialist as soon as the questions that would change its output are decided. Independent specialists run in parallel, dispatched with the `delegate` tool.
6. **Decision loop** — questions from every document, merged into one list, put to you in rounds. Every decision is logged once, in the PRD; a reversed decision is superseded, never rewritten.
7. **Check** — traceability is verified across documents, and each phase-1 scenario is traced through every document to check they agree.
8. **Review and hand off** — the package can be rendered as a readable review page for people; their comments feed further decision rounds until it's signed off and marked **Ready for engineering**.

**Only the product lead talks to you.** Specialists write their document and return questions, missing requirements and consequential decisions to the lead, which puts them to you. You get one conversation and one decision log, not five.

## The package

```
<packages_dir>/<slug>/     (docs/design/ by default)
  README.md            index, readiness checklist, review rounds, engineering handoff
  review.md            the review page's Overview, written for people
  prd.md               actors, scenarios, requirements, phasing, decision log
  architecture.md      components, flows, Mermaid diagrams, ADRs
  security-review.md   threat model, SEC-n controls
  tech-design.md       contracts, data, rollout, test strategy, traceability
  ux.md                flows, surfaces, states, wireframes
  ux/                  prototypes
```

The markdown in the repo is the working source of truth. If `design.md` names a destination — Confluence, Notion, Linear — the product lead publishes there at the milestones it records, and checks the published copy for edits made there before overwriting it.

**IDs trace across documents.** Actors are `A-n` and key scenarios `SC-n`: UX flows, architecture sequence diagrams and the tech design's flows and tests each name the actor and scenario they serve, and the security review gives every actor an identity and permissions row. Naming the actor and their context — "a picker at shift start on a shared handheld", "the customer's AI agent" — is what makes a design possible to evaluate. PRD requirements carry area-prefixed IDs (`APR-3`) and name their actor. Security controls are `SEC-n`, and become PRD requirements so they're phased. The tech design's traceability table maps every P0/P1 requirement and every `SEC-n` control to where it's implemented and how it's verified. The readiness checklist is checked against those tables before handoff.

## Review pages

The package is written for engineering. For people, the product lead can render it as a **review page**: one standalone HTML file with an Overview written for readers who haven't opened the package (what it is, who it's for, the key scenarios, phase 1, the decisions worth challenging, and the specific questions it wants answered), followed by every document rendered faithfully from the markdown, Mermaid diagrams included. The page is generated by `scripts/render-review.mjs`, never written by hand, so reviewers read exactly what engineering will build from.

- **A file, not a published page.** Publishing review pages, with comment threads the lead can reply in, uses claude.ai artifacts, which OpenCode doesn't have. The lead renders the file and says where it is; you send it to reviewers however you like. `design.md` records `review_pages: none`.
- **Feedback comes back through you.** When you tell the product lead what reviewers said, it sorts each point into a decision, a correction, something already decided, or out of scope, then puts them to you as a decision round. A comment is a proposal: nothing changes until you decide it.
- **A snapshot.** The file names the commit it was rendered from and goes stale when the package changes; the lead re-renders after each round.
- **The design hub.** On request the lead renders `<product> design packages`, listing every package with its status and owner, the same way.

Ask the product lead to run the `publish-review` skill to render a draft early, to triage feedback, or to refresh the hub.

## Prototypes

The ux-designer builds prototypes for surfaces where layout or interaction is the question, in the mode `design.md` records:

- **`html`** (the default) — self-contained HTML under `ux/`, opening straight from disk, with every state reachable.
- **`wireframes`** — text wireframes only.

Claude Design canvases, which the Claude Code version could draft, have no OpenCode equivalent; a profile that says `claude-design` is treated as `html`.

`ux.md` always carries the flows, states table and text wireframes, whatever the mode — it's what engineering and QA read. The product lead records each prototype's path in the package index.

`init-design` also takes stock of the design systems that already exist — the repo's tokens and component library, Figma libraries — and records the relevant ones, and which is canonical, in `design.md`. The ux-designer reads them before designing, applies the canonical tokens even to HTML prototypes, and extends existing Figma frames and components rather than approximating them.

## Handing off to engineering

With the `engineering-team` plugin installed:

In OpenCode's terminal UI, press Tab to cycle to the `engineering-team/tech-lead` agent, then:

```
> Implement phase 1 of docs/design/<slug>/
```

The tech lead reads the package index first. Requirement IDs become tickets, `SEC-n` controls and UX state tables become acceptance criteria and QA scenarios, and design questions discovered during implementation are routed back to the package rather than quietly diverging: the tech lead adds a row to the index's **Engineering feedback** table (through a docs-only PR), and the product lead takes each open row as a decision round. A package with an open row is not ready for engineering. The two plugins share no code; the package directory is the whole contract.

## Troubleshooting

**The `design-team/product-lead` agent isn't offered.** Run `myco doctor` and reinstall with `node scripts/install.mjs` if an agent is missing.

**The product lead can't reach Confluence, Figma or another system `design.md` names.** The MCP server isn't connected in this session, or the tool prefix in the profile is wrong. Ask for the `init-design` skill again to re-detect and re-verify (`opencode mcp list` shows what is connected).

**An adopted PRD lost a section.** It shouldn't — check the *Imported — unplaced* appendix, where anything that didn't map lands.

**A specialist says its inputs are missing.** Expected ordering: the security reviewer needs `architecture.md`; the tech designer needs both `architecture.md` and `security-review.md`.

**A specialist edited the PRD.** It shouldn't — specialists propose PRD changes to the lead. Revert the edit and ask the lead to apply it as a proposal.

**A review file shows an old version.** It is a snapshot of the commit it names. Ask the product lead to re-render it, and send the new file.

**You expected Claude Design prototypes.** OpenCode can't reach Claude Design; prototypes are HTML files.

## Files

```
agents/           product-lead, architect, security-reviewer, tech-designer, ux-designer
skills/
  init-design/    the setup interview
  publish-review/ renders review pages and the design hub, and triages feedback
scripts/
  render-review.mjs   renders a package or the hub as one page (standard library only)
  check-package.mjs   counts the mechanical readiness checks for a package (standard library only)
templates/
  prd-template.md
  architecture-template.md
  security-review-template.md
  tech-design-template.md
  ux-template.md
  package-index.md        becomes <packages_dir>/<slug>/README.md
  review-summary.md       becomes <packages_dir>/<slug>/review.md
  design-profile.md       becomes .claude/team/design.md
```
