# engineering-team

A delivery agent team with two quality gates and an enforced human merge gate.

| Agent | Role | Isolation | Writes code? |
| ----- | ---- | --------- | ------------ |
| `tech-lead` | Decomposes goals, delegates, integrates, owns tracker truth | — | Only trivially |
| `ic-generalist` | Takes one scoped task end-to-end | git worktree | Yes |
| `ic-specialist-backend` | Same, with backend/schema/API defaults | git worktree | Yes |
| `code-reviewer` | Independent review of the diff | — | No (enforced) |
| `qa-specialist` | Test plans + execution against a running build | git worktree | Tests only |

Plus one skill, `/init-team`, which profiles the host project and writes the config the agents read.

Depends on [`team-ops`](../team-ops), installed automatically, which captures how the team works and provides `agent-coach` to analyze it.

## The contract with the host project

The agents ship **generic**. Everything project-specific lives in one file the host project owns:

```
.claude/team/project.md      <- tracker, field IDs, states, branch/PR conventions,
                                merge policy, automated PR reviewers,
                                build & run commands, verification commands,
                                environments, how QA exercises this software
```

Every agent reads it on dispatch. Agent definitions are installed plugin content that a plugin update overwrites, so nothing project-specific can live in them. `/init-team` generates the file; a human edits it thereafter.

`/init-team` also records the documentation, knowledge sources and other codebases agents should consult — API references, internal engineering docs, knowledge bases, the SDKs and services this repository builds against — in `.claude/team/knowledge.md`, shared with the design team, and scaffolds the QA library the `qa-specialist` builds up over time:

```
.claude/qa/                  <- plans, scripts, fixtures, run evidence
```

## Starting from a design package

If the `design-team` plugin produced a package for the work, point the tech lead at it:

```sh
claude --agent engineering-team:tech-lead
> Implement phase 1 of docs/design/<slug>/
```

It reads the package index first, decomposes from the tech design's delivery slices, keeps requirement IDs in tickets, and carries security controls and UX states through as acceptance criteria. Design problems found during implementation are raised against the package — and logged, so the design team sees what its packages cost engineering.

A package can span repositories: the tech design names the repository each slice changes. The tech lead builds the slices that land in this repository, and tells you which ones need building elsewhere.

## Tools and role boundaries

Agents don't pin a `tools:` list — a pinned list would have to name the host's tracker MCP tools, which differ per installation. Agents inherit the session's tools, and role boundaries are enforced where they matter:

- `code-reviewer` — `disallowedTools: Edit, Write, NotebookEdit`. It reviews; the IC fixes.

**The limit:** an agent with `Bash` can still write files through the shell. For `code-reviewer` the boundary is the frontmatter plus its instructions. Tighten further in project settings if your situation calls for it.

## Merge policy

`merge_policy` in the profile frontmatter, enforced by `scripts/merge-gate-core.mjs`, called from the OpenCode plugin:

- **`human-approval`** (the default, and what a missing profile resolves to) — no agent may complete a merge. `gh pr merge`, `az repos pr ... completed`, and a direct push to `trunk_branch` are blocked. The lead hands off instead: PR summary comment, review request to the named human, notification, ticket left in its review state.
- **`autonomous`** — agents may merge once every gate is green. For `gh pr merge` (and the REST merge endpoint) the gate checks it: the PR branch must carry a QA `report.md` under `.claude/qa/runs/` whose `Verdict:` is Pass (or Pass with caveats), with a `Tested SHA:` that is the branch head or followed only by QA files. Otherwise the merge is refused and the lead is told to run QA. If `gh` or `git` can't be queried, the merge is allowed, and pushes to the trunk and other tools' merges aren't checked.

The gate keys on `agent_type`, so a human working in a plain session is never blocked — it gates autonomous merges, not the person who asked for one. It is deliberately narrow: `git merge origin/main` into a feature branch, pushing a feature branch, and opening a PR all stay allowed, because that is how an IC keeps its worktree current.

The gate covers `gh`, `az repos` and direct trunk pushes. It's a guardrail against forgetting, not a security boundary — an agent calling a hosting API another way isn't caught.

## Files

```
agents/                  five definitions, generic
skills/init-team/        the setup interview
scripts/
  merge-gate-core.mjs    merge policy enforcement, called by the OpenCode plugin
  profile.mjs            reads the project profile's frontmatter
templates/
  team/project.md        the profile /init-team fills in
  qa/                    QA library scaffold
```

No `.mcp.json` ships with the plugin. `/init-team` adds a Playwright server to the host project's `.mcp.json` only when the project actually has a web surface — a SQL or CLI project shouldn't launch a browser server every session.
