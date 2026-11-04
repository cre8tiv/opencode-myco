---
name: init-knowledge
description: Record the documentation, knowledge sources and codebases every agent team in this project should consult — product docs, API references, internal engineering docs, knowledge graphs, runbooks, and the other repositories the work changes, builds against or imitates — with what each answers, which roles use it, how authoritative it is, and how to reach it. Detects every connected MCP server (including connectors that exist but aren't authorized) and every related repository (workspaces, submodules, sibling clones, internal packages, repos the docs name), asks what each is for, and writes .claude/team/knowledge.md. Run by the init-design and init-team skills as part of setup; run it directly to refresh the list when sources or repositories change.
---

# init-knowledge

Both teams start their work by grounding: the design team before it recommends anything, the engineering team before it decides how to build. Grounding is only as good as the sources the agents know about, and a connected documentation server nobody told them about might as well not exist. The same goes for code: agents read the repository they're running in, and nothing else unless told. When the system being changed lives in another repository, or the work builds against a shared SDK or service, the agents design and build without having seen it. Your job is to find every source and codebase worth consulting, record what each one is *for*, and write `.claude/team/knowledge.md` so every agent in every team can use it.

If `.claude/team/knowledge.md` already exists — the other team's setup may have written it — this is a refresh: confirm what's there, verify it still works, add what's new, and keep anything a human wrote.

## 1. Detect

- **Every MCP server configured for this project.** `opencode mcp list` shows each configured server and whether it is connected; group the tools you can see by server (a server's tools carry its name as a prefix). Don't stop at the servers you recognize by type: a server named after the product, a team, or an internal system is often the most valuable source in the project, and it's exactly the one a fixed checklist misses. For each server, read its tool names and descriptions to work out what it serves.
- **Servers that are configured but not authorized.** `opencode mcp list` marks a remote server that needs OAuth sign-in as not authenticated. It's invisible to every agent until someone notices. Flag each one.
- **Knowledge reached another way.** Session context that names a knowledge tool or CLI (a session-start note describing an internal knowledge base, say); documentation URLs in the repo's `README`, `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`; docs directories in the repo; an `llms.txt` on a docs site. A docs site with no MCP server is still reachable by URL.
- **What's already recorded.** Trackers, wikis and design tools named in `.claude/team/project.md` or `design.md` are configured there for their operational role. List them here too only if agents should also *consult* them for answers — a wiki usually should.

Leave out servers that do things rather than answer things — browser automation, chat, calendars — unless the user says otherwise.

### Codebases

- **What this repository is.** The system being changed, a docs or design repository for a system that lives elsewhere, one service of several, or new and empty. Read the README, the top-level layout and the git remote. A repository holding mostly markdown, or nothing yet, almost always means the code lives somewhere else.
- **Repositories it already points at:**
  - monorepo workspaces (`package.json` workspaces, `pnpm-workspace.yaml`, `go.work`, a `.sln`, Cargo workspaces) — these are parts of this repository, not separate codebases, but note which parts the work is likely to touch;
  - git submodules (`.gitmodules`);
  - `additionalDirectories` in `.claude/settings.json` and `.claude/settings.local.json` — someone already decided agents need these;
  - sibling git repositories in this repository's parent directory;
  - internal packages it depends on (an organization scope like `@org/*`, a private registry, a `replace` directive, a project reference) and the repositories they come from;
  - images built from other repositories in `docker-compose` files or deployment manifests;
  - repositories named in `README`, `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`.
- **Candidates from the hosting service.** If `gh` is authenticated or a GitHub or Azure DevOps MCP server is connected, list the organization's repositories so you can offer names in step 2 rather than asking the user to type them. Don't record the whole organization.

For each candidate, note its remote URL, a local clone if there is one (as a path relative to this repository's root — the file is committed, and an absolute path is right for one teammate only), and its default branch.

## 2. Ask

Use `question`, batched, with what you detected as the recommended answers. For each source:

- **What it answers.** One line, in terms of the questions an agent would bring to it: "what the product publicly supports", "how this service's internals work", "known issues customers hit". For a source you couldn't identify from its tools, ask outright.
- **Who uses it.** Which roles should consult it. Product docs usually serve the product lead, architect and QA; internal engineering docs serve the tech designer, ICs and reviewers; security policy serves the security reviewer.
- **Authority.** *Authoritative* (the published, supported contract), *internal* (accurate but not a promise), or *community* (unverified). This matters more than it looks: for the design team, a capability documented in an authoritative source is *exists-public*; one found only in an internal source is *exists-internal*, and the PRD can't build on it as if it were supported.

Then ask one open question: **is anything missing?** A docs site, a knowledge base, a runbook collection, a support FAQ — anything a new engineer on this product would be told to read. Record what they name even if it isn't reachable yet.

### Codebases

Start with the question everything else hangs on: **is the code this work changes in this repository, or somewhere else?** Offer what you detected as the recommended answer. If it's elsewhere, that repository is a *system* codebase and the design team's main grounding target. Then, for each candidate you found:

- **Is it in scope?** Propose the ones the evidence ties to this product; don't record every sibling directory or every repository in the organization.
- **Its role** — *system* (this work changes it, but it lives elsewhere), *contract* (built against, not changed: an SDK, a shared library, a consumed service), or *reference* (prior art to imitate).
- **What it answers and who uses it**, as for any source. A system codebase serves the architect, tech designer and security reviewer; a contract serves them and the ICs; a reference often serves the ux-designer or tech designer.
- **The ref** agents should read — usually the default branch; a release tag for a contract pinned to a version.

Then ask whether any codebase is missing — "a new engineer would also need to read…".

If a codebase that matters has a local clone outside this repository, tell the user that agents can only read it without a prompt once OpenCode's `external_directory` permission allows its path, and offer to add an allow rule for it to their own `opencode.json` (per person, since clone locations differ; not the project's committed config). Don't edit settings without their yes. A codebase without a local clone is still readable remotely through `gh` or a hosting MCP server, more slowly.

### Unauthorized servers

For each server that is configured but isn't authorized, tell the user plainly and ask them to authorize it:

> `<server>` is configured but not authorized, so no agent can use it. If it's worth using, run `opencode mcp auth <server>` in a terminal, then tell me and I'll check it works. Authorization is per person, so each teammate who runs the agents does this once.

You can't authorize on their behalf. Re-check once they confirm. Whatever they decide, record the server — under **Needs authorization** if they skip it, so the gap stays visible.

## 3. Write

Copy `$MYCO_ROOT/team-ops/templates/knowledge.md` to `.claude/team/knowledge.md` and fill it in, or update the existing file.

- **One row per source**, with exactly how to reach it: an MCP tool prefix, a URL, or a repo path.
- **"Answers" is the column that matters.** An agent decides whether to consult a source by matching its question against this column. "Docs" tells it nothing; "what the product publicly supports: connectors, query features, limits" tells it when.
- **Replace or remove every placeholder.** An agent will read a leftover `<...>` as literal.
- **Record honest gaps** under *Not available* rather than leaving them out.
- **Codebases go in the *Codebases* section**, not the sources table, starting with the one-line description of this repository. Record the remote as the codebase's identity and the local path only as a relative convenience. If there are no other codebases, say so in that section — "None: everything this work touches is in this repository" — so agents know the list wasn't skipped.

## 4. Verify

For each source, make one cheap read-only call — a search for the product's own name, a top-level page, a list of spaces — and report which you verified, which you took on trust, and which still need authorization. Never write to a source to test it.

For each codebase, confirm it can be read at the recorded ref: list the local path, or fetch its README remotely (`gh api repos/<owner>/<repo>/readme`). Report which are readable locally, which only remotely, and which not at all — a codebase nobody on the team can read goes under *Not available*.

## 5. Report

In two or three lines: how many sources and codebases you recorded, which need authorizing or access and by whom, and what's missing. If you were invoked by the `init-design` or `init-team` skill, return to that skill's next step rather than ending the conversation. Remind the user to commit `.claude/team/knowledge.md`.
