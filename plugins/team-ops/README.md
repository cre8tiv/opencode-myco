# team-ops

Observability for agent teams. It captures how every installed team's agents actually work, gives those agents a way to report friction they hit, and provides `agent-coach`, which analyzes both and proposes changes to the teams' definitions and profiles.

It is installed with the other teams, by `node scripts/install.mjs`; the myco plugin it provides loads once however many teams are installed.

| Component | What it does |
| --------- | ------------ |
| `agent-coach` agent | Periodic analysis across every team. Writes one dated report of evidence-backed proposals. Propose-only, enforced. |
| `log-friction` skill | Agents in any team call the `log_friction` tool (the skill describes it) to record process friction they can name. |
| `init-knowledge` skill | Records the docs, knowledge bases and other codebases every team should consult in `.claude/team/knowledge.md`. Run by `init-design` and `init-team`; ask for it directly to refresh. |
| `start-work` skill | Leads name the unit of work they're on — `<package>/round-<n>`, `<package>/phase-<n>`, a ticket — so cost can be attributed to it. The call is the record. |
| `cost-report` skill | What the work cost: per package and round, per ticket or phase, per agent, model or day. |
| myco plugin | Captures tool failures, permission denials, agent start/stop, compaction, errored runs and the end of each lead's run — tagged by namespaced agent — and provides the `start_work`, `log_friction` and `delegate` tools and the guards. |

## What gets captured

**Events** — `PostToolUseFailure`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `PreCompact`, `StopFailure`, `SessionEnd`. Every record carries the namespaced agent that produced it (`engineering-team/ic-generalist`, `design-team/architect`), so one stream covers every team. Only team agents are captured: the plugin runs in every session in the project, and a plain session's events aren't team activity. `SubagentStop` includes each agent's own final report, whether it was dispatched with `subagent` or `delegate`. Successful tool calls are excluded.

**Friction self-reports** — logged by agents through the `log_friction` tool, with a kind: `instructions`, `tooling`, `permissions`, `scope`, `environment`, or `handoff`. The engineering tech lead logs every design problem it routes back to a design package as `handoff`; the design product lead logs specialist rework the same way. Those cross-team handoffs are the strongest signal the coach gets.

**One shape** — every record, event, friction report and usage record alike, carries the same fields: the session, the full agent name, and the unit of work — the tag the lead set with `start_work`, or an agent's own `[TICKET]`. OpenCode tells the plugin the agent and session of every call, so nothing is worked out from transcripts. So friction, failures and cost join on the work they belong to.

**Where it lives** — `~/.claude/ops/<stream>/events.jsonl` and `friction.jsonl`, outside the repo, so every git worktree converges on one stream. The stream name is `stream:` in `.claude/team/project.md`, or in `.claude/team/design.md` if there's no `project.md`, looked up by walking up from the working directory. **The profile must be committed**, or each worktree falls back to its own directory name.

## Knowledge sources

`.claude/team/knowledge.md` is the one list, shared by every team, of the documentation and knowledge sources agents consult before inferring from the code or from memory: product docs, API references, internal engineering docs, knowledge graphs, runbooks. Each row says how to reach the source (an MCP server, a URL, or a repo path), **what questions it answers**, which roles use it, how authoritative it is, and whether it needs authorizing.

The `init-knowledge` skill builds it. It looks at every configured MCP server (`opencode mcp list`) rather than a fixed list of types, so a server named after your product or an internal system gets found, and asks what each unrecognized one is for. It flags servers that are configured but not authorized: authorization is per person, so each teammate runs `opencode mcp auth <server>` once.

A *Codebases* section lists the repositories the work touches beyond this one, each with a role: *system* (code this work changes, living elsewhere), *contract* (built against, not changed) or *reference* (prior art). Each is identified by its remote URL and ref, with an optional local path relative to the repository root. All of them are read-only to agents. Design packages record the commit each was grounded at.

*Authority* matters most to the design team: a capability documented in an *authoritative* source, such as the product's published docs, is something a design can build on as a supported contract; one found only in an *internal* source isn't.

## Cost

**Nothing is recorded as it happens.** OpenCode keeps every session, and each model response in it carries its agent, model and token counts. `cost-report` (`scripts/cost.mjs`) asks OpenCode (`opencode api`) for this project's sessions that changed since they were last recorded, reads them, and appends the totals per agent, unit of work and model to `~/.claude/ops/<stream>/usage.jsonl`. A lead's session counts for its own usage and everything it dispatched; elsewhere only team agents (`team/role`) count. A session OpenCode no longer has keeps what was recorded before.

**Attribution.** Leads call the `start_work` tool with a tag as they go — the product lead per decision round (`order-exceptions/round-2`), the tech lead per phase or ticket. The call is in the lead's session with a time, and the lead's usage after it, and that of agents it starts, belongs to that tag. The tech lead also prefixes each agent's task description with its ticket (`[CLOUD-123] …`), so tickets within a phase are costed separately. A dispatched agent's session is found from its lead's `subagent` or `delegate` call.

**Append-only, never overwritten.** Records are cumulative per session and agent; the report reads only the latest of each, so reporting again supersedes rather than double-counts. Tokens are what's stored; dollars are computed at report time from `scripts/prices.json`, so correcting a price reprices history. A model with no price (a local one) is reported as unpriced, not as free.

**How accurate.** Token counts are OpenCode's own. A session's total is a little larger than its messages: OpenCode's hidden agents (the one that titles a session) use tokens that appear in no message, so they are reported as an `internal` line to make totals match. Cache writes come as one number and are priced as 5-minute writes. Costs are API list prices — a subscription bills differently.

## Across a team

Set `TEAM_OPS_OTLP_ENDPOINT` and everything above is also exported as OpenTelemetry, to any backend that takes OTLP: cost as metrics, and events and friction as OTel events. Free text — friction notes, agent reports, errors — stays local unless you opt in. [`telemetry/README.md`](telemetry/README.md) documents the format, turning both exports on, choosing a backend when you have none, and an example Docker stack with a Grafana dashboard.

## Running the coach

Invoke `agent-coach` periodically — weekly, or after a batch of work — not per task. Its findings need three or more occurrences to count, so a report covering a couple of tasks is noise.

It writes `.claude/ops/reports/<date>-agent-health.md` in the fixed format from `templates/report-template.md`, and appends a row to `.claude/ops/reports/TRENDS.md`. Commit the reports: their history is how a later report tells whether an applied proposal actually moved anything.

**Propose-only, enforced.** The coach guard, in the myco plugin (`scripts/coach-guard-core.mjs`), runs before every tool call the coach makes and lets it write only into `.claude/ops/reports/` and scratch locations. It reads everything and argues for changes in the report; a human applies them. The guard fails open — an internal error never blocks legitimate work.

## Troubleshooting

**The event stream is empty after real work.** The plugin loads when OpenCode starts — restart after installing, and run the doctor, `node ~/.config/opencode/myco/team-ops/scripts/doctor.mjs` (or the `myco` folder of the config directory you installed into), to see whether it loaded.

**Telemetry lands in a directory named after the project folder.** `stream:` can't be read from either profile. Check the key is present in the frontmatter and the profile is committed.

**Engineering and design activity are in two different streams.** `project.md` and `design.md` name different streams. Make them match — `project.md` wins when both exist.

**`agent-coach` says it can't write a file.** Working as designed. Its proposals are diffs inside the report.

## Files

```
agents/agent-coach.md
skills/log-friction/SKILL.md
skills/start-work/SKILL.md
skills/cost-report/SKILL.md
skills/init-knowledge/SKILL.md
scripts/
  capture-core.mjs          writes an event record, called by the OpenCode plugin
  friction-core.mjs         writes a friction record, called by the log_friction tool
  usage-opencode.mjs        turns OpenCode sessions into usage records
  usage-lib.mjs             the usage log, attribution helpers, pricing
  cost.mjs                  the cost report, called by cost-report
  otlp.mjs                  OpenTelemetry export: cost metrics, events
  prices.json               API list prices per model
  coach-guard-core.mjs      propose-only enforcement, called by the OpenCode plugin
  stream.mjs, profile.mjs   stream resolution from the team profiles
templates/
  report-template.md        the report's fixed format
  knowledge.md              becomes .claude/team/knowledge.md
  TRENDS.md                 seeded into .claude/ops/reports/ on first run
telemetry/
  README.md                 team telemetry: the format, setup, backends
  stack/                    example collector + Prometheus + Loki + Grafana, with dashboard
```
