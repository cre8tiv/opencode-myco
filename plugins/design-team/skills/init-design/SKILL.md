---
name: init-design
description: Set up the design-team agents for this project. Detects where design documents already live, which systems and codebases are reachable for grounding and context (tracker, wiki, Figma, Notion, Linear, and the repositories the designs will change or build against), where packages should be published (repo only, Confluence, Notion, Linear), and which design systems the ux-designer should work within; asks only what it cannot infer; then writes .claude/team/design.md. Use after installing the design-team plugin, when the product-lead reports the profile is missing, or when destinations, sources or the design system have changed.
---

# init-design

The design-team agents ship generic. Everything specific to this project — where packages live and get published, where to look for context, how prototypes are made, what compliance applies — lives in one file, `.claude/team/design.md`. Your job is to produce it and verify that what it names actually works.

**Detect before you ask.** Read the repo and probe the tools available in this session first; ask only about what you can't determine; show the user what you found so they can correct it.

Run this in the user's main session, not as a subagent, so you can ask them questions.

## 1. Detect

- **Prior profile.** If `.claude/team/design.md` exists, this is a refresh: confirm what's still true, update what isn't, and keep any prose a human has written.
- **The engineering profile.** If `.claude/team/project.md` exists, reuse its `stream` value and what it says about the product and tracker rather than asking again. Both teams must write telemetry to the same stream.
- **Existing design documents in the repo.** Look for directories like `docs/`, `docs/design/`, `design/`, `rfcs/`, `adr/`, `specs/`, `prd/`, and files whose names suggest PRDs, specs, RFCs or ADRs. Where the team already keeps design docs is the best default for `packages_dir`; the format of their existing ADRs is the one to keep.
- **Where the code lives.** Notice whether this repository holds the system the designs will change, or is a docs or design repository, one service of several, or new and empty. Don't settle it here: the knowledge-sources step below asks the user and records the codebases for both teams. Just carry what you noticed into it.
- **Reachable systems.** Check which MCP tools this session actually has (`opencode mcp list` shows the configured servers; the tools you can see carry the real names). Look for trackers (Jira, Linear, GitHub, Azure DevOps), wikis (Confluence, Notion), design sources (Figma), document stores (Google Drive, SharePoint), and chat (Slack, Teams). Record the **real tool prefix** you see; a guessed prefix is how an agent ends up silently without a tool.
- **Design systems.** Take an inventory so the ux-designer can design within what exists instead of reinventing it:
  - *The repo* — design tokens or theme files, a component library package, Storybook, a Tailwind config, and any design-system section in `AGENTS.md` or `CLAUDE.md`. Engineering builds with these, so they're the design system of record unless the user says otherwise.
  - *Design files* — Figma libraries or files, if a Figma MCP server is reachable.

## 2. Ask only the gaps

Use `question`, batching related questions, and offer what you detected as the recommended option. Realistic gaps:

- **Where packages live** — confirm the detected directory, or propose `docs/design/`.
- **Where packages are published, if anywhere.** Offer only destinations whose tools you found. For a destination, get the exact location — look up real spaces, parent pages, databases or projects with its tools and offer those, rather than asking the user to type an ID. Ask what gets published, and when.
- **How packages are reviewed and who signs off.**
- **Where existing PRDs and specs usually come from**, so adopting one later starts with a fetch rather than a search.
- **Which design files to use** if Figma or another design source is reachable — which file or team holds this product's designs.
- **Prototype mode**, when there's a real choice: `html` (the default; prototypes are HTML files) or `wireframes` if the team wants no prototypes. `claude-design` needs Claude's Design tool, which OpenCode doesn't have; never record it.
- **Which design system is canonical**, when the inventory found more than one — a Figma library, a design-system package and a component package can all exist and disagree. Engineering builds from the code, so recommend the repo's design system unless the user says the others lead.
- **Review pages.** Record `review_pages: none` and leave `review_hub` as `none`. Review pages are published as claude.ai artifacts, which OpenCode can't do; the `publish-review` skill can still render a package to a standalone HTML file for a human to share. Ask for the **product name** used in page titles (`<product> <initiative> design`), offering the one the repo or `project.md` uses, and who besides the sign-off names usually reviews.
- **Compliance context** — frameworks, the data classification scheme, and anyone who must be consulted on security changes.

Don't ask about anything the user can't act on, and take a correction without re-litigating it.

### Knowledge sources

Run the `init-knowledge` skill now. It finds every documentation and knowledge source this project can reach — including MCP servers named after the product or an internal system, and servers that are configured but not authorized — and every codebase the work touches beyond this repository, asks what each is for, and writes the shared `.claude/team/knowledge.md` that every team's agents read. If the file already exists because the other team's setup wrote it, the skill confirms and fills gaps rather than asking again. When it finishes, carry on here.

For the design team, its question **"is the code this work changes in this repository, or somewhere else?"** matters most: if it's elsewhere, that repository is what the architect and tech designer ground in, and the design is worth little if they can't read it. Make sure the answer is recorded and the repository is readable before moving on.

## 3. Write the profile

Copy `$MYCO_ROOT/design-team/templates/design-profile.md` to `.claude/team/design.md` and fill it in.

- **Replace or remove every placeholder.** An agent will read a leftover `<...>` as literal.
- **Keep the frontmatter keys exactly as templated.** `stream` is read by the team-ops telemetry — if both profiles exist it must match `project.md`, or the teams' activity splits across two streams and cross-team handoffs become invisible. `packages_dir`, `publish_to`, `ux_prototypes`, `review_pages`, `product_name` and `review_hub` are read by the agents.
- **Name tools and locations exactly.** "Publish to Confluence" is not actionable; a space key, a parent page and a tool prefix are.
- **Prefer honest gaps over invention.** "No design system" is useful. A plausible-looking Figma URL nobody verified is a trap.
- **The profile must be committed.** Tell the user.

## 4. Verify

Check each thing the profile names, with a cheap read-only call, and report which you verified and which you took on trust:

- `packages_dir` exists or can be created.
- Each publishing destination is reachable: read the named space, parent page, database or project.
- Each grounding and context source answers a read: a tracker search, a wiki page, a Figma file's metadata.
- Each repo design-system path you recorded exists.
- Telemetry resolves to the configured stream: invoke the `log-friction` skill once with kind `tooling` and the note "init-design smoke test", and check the entry landed in `~/.claude/ops/<stream>/friction.jsonl`. If it landed in a directory named after the working directory, `stream:` isn't being read — check the frontmatter.

Never write to a destination to test it. A test page in someone's Confluence space is a mess you've made in their system.

## 5. Hand off

Summarize briefly:

1. **What you detected and what you asked**, so they can spot a wrong inference.
2. **What you verified** vs. took on trust.
3. **What to commit:** `.claude/team/design.md` and `.claude/team/knowledge.md`.
4. **Anything you deliberately left blank** and what would fill it in.

Don't paste the generated file into the chat; say where it is.

Then end with **one concrete next step**, not a menu. Pick it from what you learned: if the user named an existing PRD or spec during setup, the next step is adopting it; if there's a package already in progress, resuming it; otherwise, describing the idea. Name the actual document, link or package.

How you phrase that step depends on where you're running — check before you write it:

- **You are the product lead** — this session was started as `design-team/product-lead`, so your own instructions describe that role. Don't tell the user to start a session; they're in it. Ask whether to go ahead — *"Setup's done. Shall I adopt the PRD at <link> now?"* — and on a yes, continue straight into the product lead's step 0 in this conversation.
- **You're in any other session** — the product lead has to be the session agent for its decision loop, so the user needs a new session. Give them the exact command and a first message they can paste, and say why it's a new session:

  ```
  opencode        # select the design-team/product-lead agent (Tab cycles agents)
  > Adopt the PRD at <link>
  ```

Either way, describe the next step as what will actually happen. Adopting a PRD starts with a gap check even when the document looks fully decided, so don't promise the user it will skip straight to the specialists.
