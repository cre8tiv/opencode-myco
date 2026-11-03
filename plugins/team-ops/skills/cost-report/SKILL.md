---
name: cost-report
description: Report what the agent teams' work cost — per design package and round, per ticket or phase, per agent, model or day — from the token usage team-ops records for this project. API-equivalent estimates at list prices. Use when asked what something cost, how much a design or a build spent, which agents spend the most, or for cost figures in an agent-coach report.
---

# cost-report

team-ops records the token usage of every team lead session and team agent in this project's stream (`~/.claude/ops/<stream>/usage.jsonl`), tagged with the unit of work it was for. This skill reports on it.

```sh
node "$MYCO_ROOT/team-ops/scripts/cost.mjs" [--work <tag or prefix>] [--by work|agent|model|day|session] [--since <YYYY-MM-DD>] [--json] [--export]
```

- `--work` matches by prefix: `order-exceptions` covers every round and phase of that package; `order-exceptions/round-2` just that round; `CLOUD-123` that ticket.
- `--by` groups the result; the default is by unit of work. Each row also names the biggest spenders within it.
- `--json` for figures another agent will process (agent-coach uses it).
- `--export` sends every recorded session to the team's OTel backend, once, after the export is first configured (`TEAM_OPS_OTLP_ENDPOINT`). Only when asked.

Invoked with a bare tag or slug (`/cost-report order-exceptions`), treat it as `--work`.

Run it from inside the project, so it finds the right stream. Show the human the table it prints, then answer their question from it in a sentence or two — what dominated, and anything surprising (one agent far above the rest, a round that cost more than the build).

**Say what the numbers are:**

- **Estimates at API list prices**, from the token counts in Claude Code's transcripts; a Team or Max subscription bills differently. They tend to run a little low against Claude Code's own session figures, mostly on output tokens.
- **Lead coordination is included:** a lead's own usage is reported under the work it tagged, as "(lead)".
- **"(untagged)"** is work done before leads named their work with `start-work`, or by team agents started outside a lead session.
- **Only what was recorded:** usage is captured when a lead session ends and when each team agent finishes, and the report re-reads transcripts that changed since. Transcripts Claude Code has already cleaned up can't be recovered.

This is one person's view of one project. For a team's, see the telemetry guide in the team-ops plugin (`telemetry/README.md`).
