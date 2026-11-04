# opencode-myco

Agent teams for [OpenCode](https://opencode.ai): a design team, an engineering team, and a shared ops layer that watches how they work. It is a port of [myco](https://github.com/cre8tiv/myco), which does the same for Claude Code. The agent prompts, templates and review process are shared with it; the installer, plugin and guards are specific to OpenCode.

| Team | What it is |
| ---- | ---------- |
| [`design-team`](plugins/design-team) | From idea to a decided design package: product lead, architect, security reviewer, tech designer, UX designer. Produces the PRD, architecture, security review, tech design and UX that engineering builds from. |
| [`engineering-team`](plugins/engineering-team) | Engineering delivery: tech lead, ICs, independent code review, QA validation with a persistent test library, and an enforced human merge gate. |
| [`team-ops`](plugins/team-ops) | Shared by both: the list of docs and knowledge sources agents consult, event capture, friction reporting, model mapping, the doctor, and `agent-coach`, which analyzes how the teams work and proposes improvements. |

Together they cover idea to merged code:

```
  design-team/product-lead                       engineering-team/tech-lead
  ------------------------                       --------------------------
  frame > ground > recommend > PRD               decompose > implement > review > QA > merge
     architect | ux > security > tech design
                        |
                        v
            docs/design/<slug>/  ------ handoff ------>  tickets, traced by requirement ID
```

The package directory is the only contract between the teams; they share no code.

## Status

This is a port in progress. Read this before relying on a part of it.

**Works, and checked against OpenCode 2.2.5 with a live model:**

- Installing the teams, mapping your own models to them, and the eleven agents loading as `team/role`.
- The guards: the merge gate and the `agent-coach` write guard, including through command-rewriting plugins, and the native `gh pr merge` backstop.
- The event stream (tool failures, permission denials, dispatches, compaction hook, run end), `start_work` and `log_friction`.
- [`myco doctor`](#myco-doctor), which finds the failures that make no noise.
- The cost report, read from OpenCode's own sessions. Checked against the shape of real session data and run against a real OpenCode; no team run has been priced end to end yet.

**Installed, but not yet run end to end under OpenCode:**

- The leads' whole workflows: design to a signed-off package; tech lead through review and QA to a merge handoff.
- The setup skills `init-team`, `init-design` and `init-knowledge`. Parts of their text still describe Claude Code (connectors in claude.ai, `/mcp`, Claude Design).

**Not ported yet:**

- **Delegation has not been run end to end with a model.** The leads' prompts now dispatch with `delegate` (the tech lead isolates every IC and QA run in its own worktree; the product lead leaves specialists in the shared tree), continue an agent by its `sessionID`, and no longer mention Claude Code's agent, message and task tools. What is checked: the host-side behavior of `delegate` against a real OpenCode with no model, and the stand-in tests. Not yet seen: a lead choosing the tool, an agent working in its worktree, abort on a live server. Until you have watched one run, treat parallel ICs on overlapping files with care.
- **Review pages** (`publish-review`) are claude.ai artifacts, and Claude Design prototypes have no OpenCode equivalent.
- **`agent-coach`** reads the event stream, friction reports and your team profiles; its transcript-based sources aren't ported.
- **Evals** (`evals/`) run on the Claude Code eval harness only.

The per-team READMEs under `plugins/` have not been updated yet and still describe the Claude Code version.

## Requirements

- [OpenCode](https://opencode.ai) 2.x. Developed and tested against 2.2.5.
- Node 22 or later. The installer and the team-ops scripts use only Node's standard library; there is nothing to `npm install`.
- `git`, and `gh` for the engineering team's pull request flow.
- At least one model provider configured in OpenCode. The teams don't name a model; see [Models](#models).

## Install

```sh
git clone https://github.com/cre8tiv/opencode-myco
cd opencode-myco
node scripts/install.mjs --global
```

OpenCode has no plugin marketplace, and a plugin can't add agents, so the installer copies files into its config directory. It also prints how to check the result:

```
Installed 11 agents, 8 skills and the myco plugin into ~/.config/opencode (no model mapping: agents use your default model)
Check it from any project, at any time: node "~/.config/opencode/myco/team-ops/scripts/doctor.mjs"
```

| Option | What it does |
| ------ | ------------ |
| `--global` | Install into your OpenCode user config (`~/.config/opencode`). **Prefer this.** |
| `--project` | Install into `./.opencode`. OpenCode finds agents and plugins per directory, and a git worktree holds only committed files, so a project install is invisible from a worktree unless you commit `.opencode`. |
| `--target <dir>` | Install somewhere else, such as a config directory OpenCode isn't using yet. |
| `--models <file>` | Map your models to the teams as you install; see [Models](#models). |
| `--allow-autonomous-merge` | Leave out the native `gh pr merge` deny. Needed only for projects that set `merge_policy: autonomous`; see [What stops agents](#what-stops-agents). It applies to the whole install and isn't remembered, so give it on every reinstall. |

What it puts where:

| Path (under the target) | What |
| ----------------------- | ---- |
| `agents/<team>/<role>.md` | The eleven agents, with their frontmatter rewritten for OpenCode |
| `skills/<name>/` | The eight skills |
| `plugins/myco/` | The plugin: guards, event capture, `start_work`, `log_friction`, `delegate` |
| `myco/<team>/` | Each team's scripts and templates |
| `myco/models.json` | Your model mapping, if you made one |
| `myco/install.json` | What was installed, for the doctor |

**To update**, pull and run the installer again. It replaces only what it owns: your own agents and skills, and `models.json`, are left alone.

## First run in a project

1. **Map your models** if you want more than your default for every role. Ask any agent to "run the init-models skill", or see [Models](#models).
2. **Start a lead** (below). The first time you start one in a project, it offers to set the project up (`init-design` or `init-team`). Say yes: it runs in the same session and carries on when it's done. Setup writes `.claude/team/design.md` or `.claude/team/project.md`, plus `.claude/team/knowledge.md`. Commit them. The agents ship generic and rely on these profiles, so without them they ask rather than guess.
3. **Run the doctor** from the project, once, to confirm the agents are visible and the guards are active.

## Usage

Each team is run by its lead, started as the session agent, because the lead works in conversation with you. In OpenCode's terminal UI, press Tab to cycle through the primary agents and pick one (`design-team/product-lead`, `engineering-team/tech-lead` or `team-ops/agent-coach`). For a single unattended request:

```sh
opencode run --agent design-team/product-lead "Adopt the PRD at docs/prd.md"
```

### Design: idea to decided design package

Tell the product lead where you're starting from:

```
> I want to let admins approve connection requests from Teams      # a new idea
> Adopt the PRD at https://acme.atlassian.net/wiki/x/AbCd           # an existing PRD: Confluence, Notion, Linear, a file, or pasted
> Resume docs/design/teams-approvals/                               # a package already in progress
```

It frames and grounds the work, writes the PRD, dispatches the architect, UX designer, security reviewer and tech designer as their inputs become ready, and runs one decision loop with you over every open question. It finishes with a signed-off package in `docs/design/<slug>/` marked **Ready for engineering**. (Publishing it as a shareable review page is [not ported yet](#status).)

### Engineering: package or ticket to merged code

```
> Implement phase 1 of docs/design/teams-approvals/                 # from a design package
> Pick up ABC-123                                                   # straight from a ticket
```

It decomposes the work, delegates to ICs, and gates every change through code review and then QA. By default a human merges: when both gates are green it hands the PR to you instead of merging it itself.

### Keeping the teams healthy

Every few weeks, or after a batch of work, select `team-ops/agent-coach` and ask for a process report over a window. It reads the event stream, the friction agents reported and your team profiles, and writes proposed changes to `.claude/ops/reports/`. It proposes; you decide what to apply.

### Running unattended

`opencode run` takes `--agent`, and `--auto` to approve permissions that aren't explicitly denied. The guards and the denials in the agent files still apply under `--auto`.

```sh
opencode run --agent engineering-team/tech-lead --auto "Implement phase 1 of docs/design/<slug>/"
```

Resume an interrupted run with `--continue` or `--session <id>`; the tech lead rebuilds its state from the tracker and GitHub. Without `--auto`, anything not already allowed waits for you.

### Re-running setup

Ask for `init-design`, `init-team` or `init-knowledge` again whenever tools, destinations, commands or workflow states change. They are safe to re-run: they read the existing profile, confirm what's still true, keep any prose a human added, and `init-team` never overwrites accumulated QA plans.

## Models

The teams don't name any model. Which models exist differs for every user, so you map your own, and a role with nothing mapped runs on your OpenCode default.

Roles are grouped into three tiers, by what they need from a model:

| Tier | Roles | What it needs |
| ---- | ----- | ------------- |
| `lead` | product-lead, tech-lead | Long decision loops, the largest prompts, reliable tool use |
| `reasoning` | architect, security-reviewer, tech-designer, code-reviewer, qa-specialist, agent-coach | Careful analysis. Reviewers and QA are worth most on a **different model from the one that writes the code**, because a review is only independent of its author if the model is |
| `worker` | ic-generalist, ic-specialist-backend, ux-designer | Coding and drafting, in volume |

Ask an agent to run the `init-models` skill and it lists your models, asks one question per tier, saves the mapping and applies it. Or use the script directly, with `provider/model` or `provider/model#variant`:

```sh
M="node ~/.config/opencode/myco/team-ops/scripts/models.mjs"
$M set --lead anthropic/big-model --reasoning openai/other-model --worker local/small-model
$M set --agent engineering-team/code-reviewer=openai/other-model     # one role as an exception
$M show                                                              # the mapping, and each agent's model
$M check                                                             # warnings, changing nothing
```

`set` replaces the whole mapping. `check` asks OpenCode which models exist and warns about a model or variant it doesn't list, a context window too small for the largest agent prompt, and reviewers on the same model as the ICs. Warnings are advice and never block. The mapping lives in `myco/models.json`, and reinstalling keeps it.

## What stops agents

Three protections, in different places, because each has a gap the others cover:

**The merge gate.** With `merge_policy: human-approval` (the default, and what you get with no profile), no team agent can merge a PR or push to the trunk. The agent prepares the merge, then stops and hands off; a human merges. With `merge_policy: autonomous`, a PR merge is still blocked unless the PR's branch carries a QA report with a Pass for the code being merged. The gate applies to team agents only (named `team/role`), never to your own session. It recognizes `gh pr merge`, the `gh api` merge endpoints, `az repos pr`, a push to the trunk (`trunk_branch`, default `main`), and MCP merge tools, and it looks through `bash -c`, `sudo`, `env`, `time`, `rtk`, and plugins that wrap commands, such as `node …/caveman shrink -- gh pr merge`. It judges the command *text*: a mention in quotes is not a merge, and an unquoted `echo gh pr merge` is treated as one.

**The coach guard.** `agent-coach` is propose-only, and that is enforced. It may write into `.claude/ops/reports/` and scratch locations, and nowhere else. File writes are limited by the agent's own permission rules; shell commands are checked by the plugin for what they write, since OpenCode's rules don't see a redirect or an `rm`.

**The native backstop.** Every agent is installed with a rule denying `gh pr merge`, which OpenCode enforces itself, so it holds even if the plugin fails to load. It is a partial net: it matches the command as the last plugin left it, so a wrapped merge or a push to the trunk gets past it. The plugin's gate is the real check. A project that sets `merge_policy: autonomous` needs an install made with `--allow-autonomous-merge`, or the backstop blocks its merges regardless; the doctor warns when the two disagree.

The guards exist only while the plugin is loaded, and OpenCode keeps running if it isn't. That is what the doctor is for.

## myco doctor

Several failures under OpenCode make no noise. If the plugin fails to load, OpenCode logs one warning and carries on. If one of the plugin's guards fails to load, the plugin still loads and that guard is simply absent. A project install is invisible from a git worktree. In every case the agents run, unprotected, and nothing says so. The doctor looks for these, and for quieter problems.

```sh
node ~/.config/opencode/myco/team-ops/scripts/doctor.mjs [--cwd <project>] [--no-live] [--json]
```

Run it from the project you work in. It checks:

| Area | What it looks at |
| ---- | ---------------- |
| Files | Every agent, skill, plugin file and guard module is present; the agents carry the merge backstop the install says they should |
| Project | Its `merge_policy` against the install (a project that allows merging next to an install that forbids it); whether the event stream can be written |
| Models | The same warnings as `models.mjs check` |
| Agents, live | Which team agents OpenCode, started in this directory, can see, and in a worktree, why not |
| Plugin, live | Whether a command run in a session sees the plugin, and which of its parts report they came up: `capture`, `coach-guard`, `merge-gate`, `start_work`, `log_friction`, `delegate` |

A healthy install, with a model mapping. Without one, the `models` line is an `info` note that every agent uses your default model, and nothing is flagged:

```
ok    install: design-team 0.7.0, engineering-team 0.6.2, team-ops 0.10.0; installed 2026-11-04
ok    agents: all 11 installed
ok    skills: all 8 installed
ok    plugin: files present
ok    cores: guards, capture and friction code present
info  backstop: every agent denies gh pr merge natively (the plugin guard is the real check)
ok    project: merge_policy: human-approval (default)
ok    stream: myproject: events and friction are written to ~/.claude/ops/myproject
ok    models: mapping has no problems
ok    opencode: opencode v2.2.5
ok    agents (live): all 11 team agents are visible from ~/code/myproject
ok    plugin (live): loaded
ok    features: all active: capture, coach-guard, merge-gate, start_work, log_friction, delegate

everything checks out
```

A guard that silently failed to load, which a file check alone would not catch because the file exists:

```
FAIL  merge-gate: not active: the plugin loaded but merge-gate-core.mjs did not load, so merge-gate is silently absent
      fix: Reinstall: node scripts/install.mjs --global (from the myco checkout).

1 problem, 0 warnings
```

Each finding is `ok`, `info`, `warn` or `FAIL`, with a fix when it has one. The exit status is 1 if anything failed and 0 otherwise, so warnings never fail a script. `--json` prints the findings for a program to read, and `--no-live` skips the checks that start OpenCode. The live checks open a session in your directory and delete it afterwards.

**When to run it:**

- **After installing or updating**, once from a project, to confirm the install is what you meant.
- **After upgrading OpenCode.** Its plugin API is young, and a change can stop the plugin loading without an error you'd see.
- **When agents stop showing up**, or aren't what you expect: it says whether they're not installed, or installed but not visible from where you are.
- **Before trusting a worktree-based run**, from inside the worktree.
- **After a merge or write went through that shouldn't have**: it tells you whether the guards were even running.
- **When you change who may merge** (`merge_policy`, or `--allow-autonomous-merge`): it warns if the project and the install disagree.

**What it can't tell you:** that a guard *works*, only that it is loaded. A guard judges a tool call made by a team agent, and nothing but a model run makes one. It also checks the OpenCode on your `PATH`, in the directory you run it from.

## Knowledge sources

The `init-knowledge` skill records the documentation and knowledge sources every team should consult (product docs, API references, internal engineering docs, runbooks) in one shared file, `.claude/team/knowledge.md`. Both team setups run it. It checks every MCP server your session has, not just familiar kinds like trackers and wikis, so a docs server built for your product is found, and it asks what any server it can't identify is for. Docs reachable by URL and docs in the repo count too. Each source is recorded with:

- **how to reach it**: an MCP server, a URL, or a repo path;
- **what it answers**: the questions an agent would bring to it, which is how agents decide when to use it;
- **who uses it**: which roles, from product lead to QA;
- **authority**: *authoritative* (published docs and API references), *internal* (accurate but not a promise), or *community* (unverified);
- **access**: whether it's ready to use or needs authorizing.

Agents check the sources the list names before inferring from the code or from memory. MCP servers are configured in OpenCode (`opencode mcp`, or the `mcp` section of `opencode.json`); a connector that is configured but not authorized is listed under *Needs authorization* instead of being skipped. (This skill's text still points at Claude-specific places to authorize; see [Status](#status).)

**Other codebases count too.** Agents read the repository they run in and nothing else unless told. If the system your designs change lives in another repository, `init-knowledge` records it in a *Codebases* section with a role: **system** (code this work changes, living elsewhere), **contract** (built against but not changed) or **reference** (prior art). Every codebase is read-only to the agents. Design packages record the commit each was grounded at, and which repository each delivery slice changes. The tech lead builds only the slices that land in its own repository and hands the rest over.

## What your project owns

Agent definitions are installed content, and a reinstall overwrites them, so nothing project-specific lives inside them: not your tracker's field IDs, not your dev server URL, not your ephemeral-environment tooling. All of it lives in files your project owns:

```
.claude/team/project.md      engineering profile
.claude/team/design.md       design profile
.claude/team/knowledge.md    knowledge sources
```

`project.md` records what the software is, the tracker and its real MCP tool prefix, workflow state names, branch and PR conventions, the merge policy and who to notify, any automated PR reviewers, build/run/test/lint/typecheck commands, which environments exist, and how QA should exercise this kind of software. The team doesn't assume you're building a web app: QA's execution mode comes from the profile, whether that is a browser, HTTP probes, invocation of a CLI, a consumer harness for a library, or migration against realistic data.

The paths are `.claude/...` even under OpenCode, deliberately. They are shared with the Claude Code version, so a project can use either and keep one set of profiles, QA plans and reports; OpenCode reads `.claude/skills` too.

| Path | Committed? | Why |
| ---- | ---------- | --- |
| `.claude/team/project.md`, `design.md` | Yes | Each team's profile. **Worktrees read them, so they must be committed.** |
| `.claude/team/knowledge.md` | Yes | Docs, knowledge sources and codebases every team consults |
| `.claude/qa/plans`, `scripts`, `fixtures` | Yes | Project assets; merge with the change they cover |
| `.claude/qa/runs/**` captures | No | Heavy; referenced by path from run reports |
| `.claude/ops/reports/*.md` | Yes | The durable artifact; history enables attribution |
| `~/.claude/ops/<stream>/*.jsonl` | No (outside the repo) | Machine-local telemetry; contains command lines |

## What it records

team-ops writes to a stream under `~/.claude/ops/<stream>/`, named by `stream:` in your profile (so every worktree of a project shares one):

- **`events.jsonl`**: team activity, for team agents only. Tool failures (`PostToolUseFailure`), refused calls (`PermissionDenied`, whether a permission rule refused it or a guard did), dispatches with the agent's own report (`SubagentStart`, `SubagentStop`), compaction (`PreCompact`; the hook registers cleanly, but no run has compacted yet, so it hasn't been seen firing), runs that ended on an error (`StopFailure`), and the end of a lead's run (`SessionEnd`). Successful tool calls are deliberately not recorded.
- **`friction.jsonl`**: reports agents file about their own instructions being unclear, a tool missing, a task too vague, or a handoff losing information, through the `log_friction` tool. An agent is the only witness to its own instructions being ambiguous, so `agent-coach` weighs these heavily.
- **Usage and cost**: nothing is recorded as it happens. `cost-report` (`node "$MYCO_ROOT/team-ops/scripts/cost.mjs"`) asks OpenCode for the sessions of this project that changed since they were last recorded, and reads the tokens each response used, by agent and model. Cost is an estimate at API list prices, by unit of work; a model with no list price (a local one) shows as `unpriced`. It needs the `opencode` command on your `PATH`, and only counts team agents.
- **Work tags**: leads name a design package round or an engineering phase with the `start_work` tool, and the tech lead prefixes each dispatched agent's task with its ticket (`[CLOUD-123] implement retry`). Records carry the work, so activity can be joined to what it was for.

If you set `TEAM_OPS_OTLP_ENDPOINT`, events and friction are also exported as OpenTelemetry; see [Team telemetry](plugins/team-ops/telemetry/README.md). The export code is shared with the Claude Code version and is unit-tested, but it hasn't been checked end to end against OpenCode, and that guide was written for the Claude Code version. 

## Working with the engineering team

**Start at the top.** Hand a goal or a ticket to `tech-lead` and let it decompose and delegate; don't dispatch ICs yourself. The lead is what keeps the tracker, the task list and the branch state in sync.

**Let ICs run.** They're built for long autonomous stretches and message the lead when done or blocked. Polling them defeats the design.

**The gates are sequential on purpose.** QA before review wastes QA's time on code that's about to change on review feedback. Review catches bad code that works; QA catches good code that doesn't; neither substitutes for the other.

**When a change is user-visible, it goes through QA.** The tech lead carries the decision rule (auth, billing, customer data, interface contracts, migrations, anything a human would exercise before believing it). When unsure, it dispatches.

**Invoke `agent-coach` periodically, not per ticket.** Its findings need three or more occurrences to count, so a report covering two tickets is noise.

**Automated PR reviewers are handled.** If your repo has CodeRabbit, Greptile, Copilot or a Claude or Codex action on PRs, `init-team` detects it and `code-reviewer` gives every finding a disposition: agree, already covered, disagree with a reason, or out of scope. The lead re-checks the PR immediately before merging, since bots post asynchronously, and won't merge over something unaddressed. Bot findings are input, not instructions.

**Edit the team profiles, never the installed agents.** If an agent keeps getting something wrong about your project, the fix almost always belongs in `.claude/team/project.md` or `design.md`. A reinstall overwrites the agents.

**Two things compound.** `qa-specialist` persists every test plan, script and fixture into `.claude/qa/` and reads that library before writing anything, so run N+1 is cheaper than run N. `agent-coach` proposes edits to the team's own definitions from what the stream shows, so the process improves and not just the code.

```
  user
    |
    v
tech-lead  ----------------------------------------------+   owns the plan, decomposes,
    |  delegates                                         |   delegates, integrates.
    |                                                    |   Never merges unreviewed work.
    +---> ic-generalist                                  |
    +---> ic-specialist-backend                          |
                |                                        |
                | reports done                           |
                v                                        |
        code-reviewer      gate 1: reads the diff        |
                |          Approve / Request changes     |
                v                                        |
        qa-specialist      gate 2: exercises the build   |
                |          Pass / Fail / Blocked         |
                v                                        |
         merge policy      human-approval: hand off      |
                |          autonomous: merge             |
                v                                        |
            merge ---> Done ---------------------------->+

  agent-coach   runs beside all of this, on its own cadence.
```

## Troubleshooting

Start with the doctor. Most of what follows it reports directly.

**The agents don't appear, or the guards aren't running.** Run the doctor from the project. It says whether the agents aren't installed, installed but not visible from this directory, or whether the plugin didn't load, and why. OpenCode finds agents and plugins per directory: a project install is invisible from a git worktree unless `.opencode` is committed, so install globally.

**The plugin won't load.** The doctor quotes OpenCode's own reason when its log has one. The log is under the path `opencode debug paths` shows as `log`.

**An agent says the project profile is missing.** Ask for `init-team` or `init-design` for that team, or start its lead and accept the offer to set up. The agents refuse to guess at a tracker workflow or a test command, by design.

**An agent guessed at something your docs answer.** The source is missing from `.claude/team/knowledge.md`, its *Answers* column doesn't say when to use it, or it's listed under *Needs authorization*. Ask for `init-knowledge`.

**A design described code engineering didn't find.** The design was probably grounded in the wrong repository, or the right one wasn't readable. Check the *Codebases* section of `knowledge.md`; the package's *Codebases* table shows the commit each was grounded at.

**An agent was blocked from merging.** Expected under `merge_policy: human-approval`: it should hand off with a PR summary, a review request and a notification. To let a project merge, set `merge_policy: autonomous` in its profile **and** install with `--allow-autonomous-merge`; otherwise the native backstop still blocks it. The doctor flags the mismatch.

**A command was blocked that only mentioned a merge.** An unquoted `gh pr merge` anywhere in a command counts as a merge. Quote it (`echo "to merge, run gh pr merge 42"`) or reword.

**A merge was blocked on a branch that isn't your trunk.** `trunk_branch` in the profile doesn't match reality; the gate protects whatever it names.

**`agent-coach` says it can't write a file.** Working as designed: it may write only into `.claude/ops/reports/`. Its proposals are diffs inside the report; a human applies them.

**The event stream is split across directories, or lands in one named after the project folder.** `stream:` isn't being read from `.claude/team/project.md`, so each worktree falls back to its own directory name. Commit the profile and check the key is spelled exactly.

**A run's first request times out, then works.** With a large local model, the first request after a model loads can take longer than the provider's header timeout; OpenCode retries and the retry is quick once the prompt is cached. A run that exhausts its retries ends with a `StopFailure` in the stream.

**Tracker transitions fail silently.** The MCP tool prefix recorded in `project.md` doesn't match the server actually available in your session. Check the real prefix and correct the profile.

**An IC's changes land in the wrong place.** Worktree isolation isn't ported yet (see [Status](#status)); ICs work in the checkout the session runs in.

**A reinstall reverted a change I made to an agent.** Expected: agent definitions are installed content. Project-specific behavior belongs in `.claude/team/project.md`; if the change is general, send it upstream.

## How it relates to myco

This repository began as a copy of [cre8tiv/myco](https://github.com/cre8tiv/myco) and keeps its history. Most of it is meant to stay identical to upstream so upstream fixes merge cleanly: the templates, `check-package`, `otlp`, `profile`, the review-page renderer and the telemetry stack. `drift-manifest.json` lists those files with a hash and the upstream commit they match, and the test suite fails if one changes without a recorded reason.

```sh
node scripts/drift.mjs check                        # shared files still match upstream (the tests run this)
node scripts/drift.mjs report                       # what changed upstream since the recorded commit
node scripts/drift.mjs release <path> --reason "…"  # a shared file now differs on purpose, with why
```

The agent sources keep their Claude Code frontmatter, so they stay mergeable too; the installer rewrites it into OpenCode's (`mode`, `permission`, `model`) and drops every Claude-only key, because OpenCode forwards unknown keys to the model provider.

## Contributing

If you change an agent definition:

- **Bump the plugin's `version` in its `meta.json`.** CI fails a pull request that changes a plugin without raising its version. Use a minor bump for behavior changes and a patch bump for fixes.
- Say what signal you expect to move.
- Prefer deleting or tightening over appending.
- **Text that several agents share lives in one place.** Wrapped in `<!-- shared:NAME -->` markers, it is copied from `shared/agent-blocks/NAME.md`. Edit that file, run `npm run sync:agents`, and commit the result; a test fails if any copy differs.
- Keep project-specific knowledge out of the agents: if it's true of one company's setup and not another's, it belongs in a profile template or a setup skill's interview.
- Write paths as `$MYCO_ROOT/<team>/…`; the installer replaces it with the real install path, because a model's `read` call can't expand a variable.

### Tests

```sh
npm test                                          # Node 22 or later; nothing to install
node --test test/merge-gate.test.mjs              # one file
MYCO_TEST_OPENCODE=1 npm test                     # also run against a real OpenCode
node scripts/check-version-bumps.mjs              # the version check CI runs on pull requests
```

The suite runs scripts as processes and the plugin through a stand-in for OpenCode's plugin context, against a throwaway home directory, so it never touches your `~/.claude` or `~/.config/opencode`. With `MYCO_TEST_OPENCODE=1` it also installs into a throwaway HOME and runs a real OpenCode against it, which checks that the agents load as intended, that nothing Claude-specific reaches the model provider, that the plugin loads and reports its features, and that the doctor catches a broken install. That mode needs the `opencode` binary and uses no model. CI runs the default suite on Linux, macOS and Windows; the real-OpenCode tests have only been run on macOS. If you change a guard, add the case that motivated the change to its test file.

Behavior evals, which check what the agents and skills do with a real model, live in [`evals/`](evals/README.md). They run on the Claude Code eval harness, so they aren't part of this port yet.

Internals are documented in [`plugins/engineering-team/README.md`](plugins/engineering-team/README.md) (written for the Claude Code version; not updated yet).
