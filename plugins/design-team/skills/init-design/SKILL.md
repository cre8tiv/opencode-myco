---
name: init-design
description: Set up the design-team agents for this project. Detects where design documents already live, whether packages get published as readable review pages with a design hub, which systems and codebases are reachable for grounding and context (tracker, wiki, Figma, Notion, Linear, and the repositories the designs will change or build against), where packages should be published (repo only, Confluence, Notion, Linear), whether Claude Design is available for prototypes (walking the user through the one-time /design consent if needed), and which design systems and existing design artifacts the ux-designer should work within; asks only what it cannot infer; then writes .claude/team/design.md. Use after installing the design-team plugin, when the product-lead reports the profile is missing, or when destinations, sources or the design system have changed.
---

# init-design

The design-team agents ship generic. Everything specific to this project — where packages live and get published, where to look for context, how prototypes are made, what compliance applies — lives in one file, `.claude/team/design.md`. Your job is to produce it and verify that what it names actually works.

**Detect before you ask.** Read the repo and probe the tools available in this session first; ask only about what you can't determine; show the user what you found so they can correct it.

Run this in the user's main session, not as a subagent: some of what you detect — notably Claude Design — is only visible there.

## 1. Detect

- **Prior profile.** If `.claude/team/design.md` exists, this is a refresh: confirm what's still true, update what isn't, and keep any prose a human has written.
- **The engineering profile.** If `.claude/team/project.md` exists, reuse its `stream` value and what it says about the product and tracker rather than asking again. Both teams must write telemetry to the same stream.
- **Existing design documents in the repo.** Look for directories like `docs/`, `docs/design/`, `design/`, `rfcs/`, `adr/`, `specs/`, `prd/`, and files whose names suggest PRDs, specs, RFCs or ADRs. Where the team already keeps design docs is the best default for `packages_dir`; the format of their existing ADRs is the one to keep.
- **Where the code lives.** Notice whether this repository holds the system the designs will change, or is a docs or design repository, one service of several, or new and empty. Don't settle it here: the knowledge-sources step below asks the user and records the codebases for both teams. Just carry what you noticed into it.
- **Reachable systems.** Check which MCP tools this session actually has — load deferred tools with `ToolSearch` to see their real names. Look for trackers (Jira, Linear, GitHub, Azure DevOps), wikis (Confluence, Notion), design sources (Figma), document stores (Google Drive, SharePoint), and chat (Slack, Teams). Record the **real tool prefix** you see; a guessed prefix is how an agent ends up silently without a tool.
- **Claude Design.** It needs Claude Code v2.1.265 or later (`claude --version`), a session signed in to claude.ai, and the `Artifact` tool. If you have the tool, run a quickstart with intent `design`: it tells you whether a Design type is available and which design systems the account offers.

  **If no Design type is listed, don't conclude the account lacks Claude Design.** The usual cause is that the user hasn't granted agents access to their Claude Design projects yet. That's a one-time consent the user gives themselves by running `/design consent`, and you can't do it for them. See *Claude Design access* in step 2.

  If you don't have the `Artifact` tool at all, don't guess; record `html` and say why.
- **Design systems and existing design artifacts.** Take an inventory so the ux-designer can design within what exists instead of reinventing it:
  - *claude.ai design systems* — the ones the Claude Design quickstart lists, with their names and links.
  - *Existing design artifacts* — if you have the `Artifact` tool, list the user's artifacts (and those shared with them), and pick out canvases, prototypes and design-system pages that relate to this product. Propose the relevant ones to the user; don't record everything in their gallery.
  - *The repo* — design tokens or theme files, a component library package, Storybook, a Tailwind config, and any design-system section in `CLAUDE.md`. Engineering builds with these, so they're the design system of record unless the user says otherwise.
  - *Design files* — Figma libraries or files, if a Figma MCP server is reachable.

## 2. Ask only the gaps

Use `question`, batching related questions, and offer what you detected as the recommended option. Realistic gaps:

- **Where packages live** — confirm the detected directory, or propose `docs/design/`.
- **Where packages are published, if anywhere.** Offer only destinations whose tools you found. For a destination, get the exact location — look up real spaces, parent pages, databases or projects with its tools and offer those, rather than asking the user to type an ID. Ask what gets published, and when.
- **How packages are reviewed and who signs off.**
- **Where existing PRDs and specs usually come from**, so adopting one later starts with a fetch rather than a search.
- **Which design files to use** if Figma or another design source is reachable — which file or team holds this product's designs.
- **Prototype mode**, when there's a real choice: `claude-design` if a Design type is available, `html` otherwise, `wireframes` if the team wants no prototypes.
- **Which design system is canonical**, when the inventory found more than one — a claude.ai design system, a Figma library and a component package can all exist and disagree. Engineering builds from the code, so recommend the repo's design system unless the user says the others lead.
- **Which existing design artifacts are references** for this product, from the ones you found.
- **Review pages.** Whether to publish each package as a readable page people can share and comment on, with a design hub listing every package. Recommend `artifact` if you have the `Artifact` tool; otherwise record `none` and say publishing needs an interactive session signed in to claude.ai. Ask for the **product name** used in page titles (`<product> <initiative> design`), offering the one the repo or `project.md` uses, and who besides the sign-off names usually reviews. Leave `review_hub` as `none`: the first publish creates the hub and records its link.

### Claude Design access

If the user wants Claude Design prototypes and the quickstart listed no Design type, ask them to grant access, and say plainly what it does:

> To let the design agents create Claude Design canvases, run `/design consent`. It grants agents access to your Claude Design projects. It's tied to your claude.ai login, not this project, so each teammate who runs the design team does this once for themselves.

Wait for them to confirm, then run the quickstart again. If a Design type now appears, record `claude-design` and the design systems it lists. If it still doesn't, the plan or organization doesn't offer it — Enterprise owners enable the Design template under *Organization settings → Artifacts* — so record `html` and say which of those it appears to be. If the user doesn't want to grant access now, record `html`, and tell them that granting it later and re-running `/init-design` switches prototypes over.
- **Compliance context** — frameworks, the data classification scheme, and anyone who must be consulted on security changes.

Don't ask about anything the user can't act on, and take a correction without re-litigating it.

### Knowledge sources

Run the `init-knowledge` skill now. It finds every documentation and knowledge source this project can reach — including MCP servers named after the product or an internal system, and connectors that exist but aren't authorized — and every codebase the work touches beyond this repository, asks what each is for, and writes the shared `.claude/team/knowledge.md` that every team's agents read. If the file already exists because the other team's setup wrote it, the skill confirms and fills gaps rather than asking again. When it finishes, carry on here.

For the design team, its question **"is the code this work changes in this repository, or somewhere else?"** matters most: if it's elsewhere, that repository is what the architect and tech designer ground in, and the design is worth little if they can't read it. Make sure the answer is recorded and the repository is readable before moving on.

## 3. Write the profile

Copy `$MYCO_ROOT/design-team/templates/design-profile.md` to `.claude/team/design.md` and fill it in.

- **Replace or remove every placeholder.** An agent will read a leftover `<...>` as literal.
- **Keep the frontmatter keys exactly as templated.** `stream` is read by the team-ops telemetry hooks — if both profiles exist it must match `project.md`, or the teams' activity splits across two streams and cross-team handoffs become invisible. `packages_dir`, `publish_to`, `ux_prototypes`, `review_pages`, `product_name` and `review_hub` are read by the agents.
- **Name tools and locations exactly.** "Publish to Confluence" is not actionable; a space key, a parent page and a tool prefix are.
- **Prefer honest gaps over invention.** "No design system" is useful. A plausible-looking Figma URL nobody verified is a trap.
- **The profile must be committed.** Tell the user.

## 4. Verify

Check each thing the profile names, with a cheap read-only call, and report which you verified and which you took on trust:

- `packages_dir` exists or can be created.
- Each publishing destination is reachable: read the named space, parent page, database or project.
- Each grounding and context source answers a read: a tracker search, a wiki page, a Figma file's metadata.
- If `ux_prototypes` is `claude-design`, a Design type was present in a quickstart you ran after any consent was granted.
- Each design artifact you recorded as a reference can be read (`Artifact` read), and each repo design-system path exists.
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
