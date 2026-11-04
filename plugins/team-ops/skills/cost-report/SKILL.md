---
name: cost-report
description: Report what the agent teams' work cost — per design package and round, per ticket or phase, per agent, model or day — from the token usage team-ops records for this project. API-equivalent estimates at list prices. Use when asked what something cost, how much a design or a build spent, which agents spend the most, or for cost figures in an agent-coach report.
---

# cost-report

team-ops keeps the token usage of every team lead session and team agent in this project's stream (`~/.claude/ops/<stream>/usage.jsonl`), tagged with the unit of work it was for. Each report first reads the OpenCode sessions that changed since they were last recorded, then reports on the log. This skill reports on it.

```sh
node "$MYCO_ROOT/team-ops/scripts/cost.mjs" [--work <tag or prefix>] [--by work|agent|model|day|session] [--since <YYYY-MM-DD>] [--source opencode|claude] [--json] [--export]
```

- `--work` matches by prefix: `order-exceptions` covers every round and phase of that package; `order-exceptions/round-2` just that round; `CLOUD-123` that ticket.
- `--by` groups the result; the default is by unit of work. Each row also names the biggest spenders within it.
- `--json` for figures another agent will process (agent-coach uses it).
- `--source` says where sessions are read from: `opencode` (the default) or `claude`, for Claude Code transcripts.
- `--export` sends every recorded session to the team's OTel backend, once, after the export is first configured (`TEAM_OPS_OTLP_ENDPOINT`). Only when asked.

Invoked with a bare tag or slug (`/cost-report order-exceptions`), treat it as `--work`.

Run it from inside the project, so it finds the right stream. Show the human the table it prints, then answer their question from it in a sentence or two — what dominated, and anything surprising (one agent far above the rest, a round that cost more than the build).

**Say what the numbers are:**

- **Estimates at API list prices**, from the token counts OpenCode keeps for each response, priced by model name. A model with no list price (a local model, say) is shown as `unpriced`, not as free; and a subscription bills differently. Cache writes are priced as 5-minute writes, OpenCode not saying which kind they were.
- **"internal"** is tokens OpenCode used that appear in no message, such as the agent that titles a session. They are small, and included so totals match OpenCode's own.
- **Lead coordination is included:** a lead's own usage is reported under the work it tagged, as "(lead)".
- **"(untagged)"** is work done before leads named their work with `start_work`, or by team agents started outside a lead session.
- **Only what was recorded:** only team agents (named `team/role`) in this project are counted, and only sessions OpenCode still has. A session deleted from OpenCode keeps whatever was recorded before; one never reported on before its deletion is lost. If the report says it could not refresh from OpenCode, the figures are what was recorded earlier.

This is one person's view of one project. For a team's, see the telemetry guide in the team-ops plugin (`telemetry/README.md`).
