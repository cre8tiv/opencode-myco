# Team telemetry

The `cost-report` skill and `agent-coach` answer "what did this cost?" and "where did the teams struggle?" for one person's work in one project. This guide is for answering them across a team, in any observability tool: the agent teams' cost, friction, tool failures and handoffs per design round, build phase and ticket.

It uses [OpenTelemetry](https://opentelemetry.io/) (OTel), the open standard most observability tools accept. team-ops exports its own records:

| Source | What it knows | Exported as |
| --- | --- | --- |
| **team-ops** | Cost, tokens, friction and events per **unit of work** — the tags leads set with the `start_work` tool — and per agent | Metrics `team_ops.work.*`; events `team_ops.*` |

OpenCode has its own telemetry setting (`openTelemetry` in its config); this guide doesn't cover it. Sessions that aren't team agents' (your own plain sessions) aren't in team-ops' export either, so it is the agent teams' cost, not everything OpenCode spent.

Costs are API-equivalent estimates at list prices. A subscription bills differently, and a model with no list price (a local one) is exported with no cost; for billing, use your model provider's dashboard.

## Where to send it

You need somewhere that accepts OTLP — the OTel protocol — and can chart it. Pick one:

| You have | Do this |
| --- | --- |
| **An observability platform already** (Datadog, Grafana, New Relic, Honeycomb, an OTel collector) | Point team-ops at its OTLP endpoint. Import [the dashboard](stack/grafana/dashboards/agent-teams.json) if it's Grafana. |
| **Nothing, and data may leave your network** | A hosted service's free tier — Grafana Cloud and Honeycomb both take OTLP metrics and logs directly, with an endpoint URL and an API key. No servers to run. |
| **Nothing, and data must stay in** | Run [the example stack](#the-example-stack): an OTel collector, Prometheus, Loki and Grafana in Docker, with the dashboard ready. |
| **Only your provider's view** | Your model provider's dashboard shows cost per key or per person — not per agent or unit of work. No setup. |

## Turn on team-ops' export

team-ops reads its own variables, from the environment OpenCode runs in. Set them where you start OpenCode (your shell profile, say), and restart it: OpenCode keeps a background server, which has the environment it started with.

```sh
export TEAM_OPS_OTLP_ENDPOINT=https://otlp.example.com
export TEAM_OPS_OTLP_HEADERS="Authorization=Bearer <token>"
export TEAM_OPS_OTLP_RESOURCE_ATTRIBUTES="team.id=platform"
```

| Variable | |
| --- | --- |
| `TEAM_OPS_OTLP_ENDPOINT` | Turns the export on. The OTLP/HTTP base URL (`…:4318`); metrics go to `/v1/metrics` and events to `/v1/logs` under it. |
| `TEAM_OPS_OTLP_HEADERS` | Optional. `key=value` pairs, comma-separated, URL-encoded — the same format as `OTEL_EXPORTER_OTLP_HEADERS`. |
| `TEAM_OPS_OTLP_RESOURCE_ATTRIBUTES` | Optional. `key=value` pairs added to every export, such as a team name to filter the dashboard by. |
| `TEAM_OPS_OTLP_LOG_CONTENT` | Optional. `1` adds free text to events: friction notes, agents' final reports, error messages, commands and file paths. Off by default — see [What leaves the machine](#what-leaves-the-machine). |

It sends OTLP over HTTP with a JSON body, which most backends and every OTel collector accept; a backend that takes only gRPC or protobuf needs a collector in front of it. Each send waits at most 2 seconds and never fails a session or an agent's work.

**When it sends.** Events as they happen, once, by the myco plugin: a failed send is noted and the event stays in the local file. **Cost is sent when a cost report runs**, not when an agent finishes: OpenCode keeps the sessions, and `cost.mjs` reads the ones that changed and exports their cost, carrying each session's whole running total, so a resend is harmless and a failed one is made good by the next. Run the report from your own terminal after a batch of work, or on a schedule, so the export isn't waiting for someone to ask: `node "<config>/myco/team-ops/scripts/cost.mjs" --json > /dev/null` in each project. (Run from a terminal it uses your shell's environment, so the variables above must be set there.)

**History.** Cost the report has already recorded stays local until you send it: run `node "<config>/myco/team-ops/scripts/cost.mjs" --export` in each project. Earlier events aren't re-sent.

**Is it working?** `~/.claude/ops/<stream>/otlp-status.json` records the last send of each signal: when, where, how much, and the error if it failed.

## The data

Everything team-ops records — locally in `~/.claude/ops/<stream>/` and in the export — shares one set of fields, so friction, failures and cost can be joined on the work they belong to.

### Shared fields

| OTel attribute | Local field | |
| --- | --- | --- |
| `session.id` *(resource)* | `session` | The OpenCode session of the lead (an agent it dispatched reports under its lead's session). Also `service.instance.id`. |
| `service.name` *(resource)* | — | Always `team-ops`. |
| `team_ops.stream` | the directory name | The project's stream, from `stream:` in its team profile. |
| `agent` | `agent` | The full agent name: `design-team/architect`, `engineering-team/ic-generalist`. |
| `agent.id` | `agent_id` | One run of a subagent. Events only; metrics add up across runs. |
| `work` | `work` | The unit of work: a tag set with `start_work` (`order-exceptions/round-2`, `order-exceptions/phase-1`), an agent's own `[TICKET]` tag, or `(untagged)`. |
| `parent_work` | `parent_work` | The lead's tag when the agent had its own — the phase a ticket belongs to. |
| custom | — | Anything in `TEAM_OPS_OTLP_RESOURCE_ATTRIBUTES`. |

### Metrics

| Name | Unit | Extra attributes |
| --- | --- | --- |
| `team_ops.work.cost` | USD | `model`, `speed` |
| `team_ops.work.token.usage` | tokens | `model`, `speed`, `type` — `input`, `output` (reasoning included), `cacheRead`, `cacheCreation` (OpenCode reports one cache-write number, exported as 5-minute writes) |

Cumulative sums, one series per session. A session's cost in a time range is the largest value its series reached; a range's cost is the sum of those:

```promql
# Agent-team cost per unit of work, over the dashboard's range
sum by (work) (max_over_time(team_ops_work_cost_USD_total[$__range]))

# The same, per agent
sum by (agent) (max_over_time(team_ops_work_cost_USD_total[$__range]))
```

A session that runs across the start of the range is counted whole. `increase()` undercounts a series with only one sample, which team-ops' often have, so don't use it for totals. Prometheus names, with the collector's default translation: `team_ops_work_cost_USD_total`, `team_ops_work_token_usage_tokens_total`.

### Events

OTel log records, with the event name in both `eventName` and the `event.name` attribute.

| Event | When | Severity | Extra attributes | With content on |
| --- | --- | --- | --- | --- |
| `team_ops.friction` | An agent reported friction with the `log_friction` tool | WARN | `friction.kind` — `instructions`, `tooling`, `permissions`, `scope`, `environment`, `handoff` | body: the note |
| `team_ops.tool_failure` | A team agent's tool call failed | WARN | `tool.name`, `hook.event` | `tool.target`, `error.message`; body: the error |
| `team_ops.permission_denied` | A team agent was refused a tool call | WARN | `tool.name`, `hook.event` | `tool.target`, `reason` |
| `team_ops.stop_failure` | A turn ended on an error | WARN | `hook.event` | `error.message` |
| `team_ops.agent_start` | A team agent started | INFO | `hook.event` | `task.description` |
| `team_ops.agent_stop` | A team agent finished | INFO | `hook.event` | body: its final report |
| `team_ops.compaction` | A team agent's context was compacted — usually a task scoped too large (the hook is registered, but no run has compacted yet, so it hasn't been seen) | INFO | `hook.event` | |
| `team_ops.session_end` | A team lead's run ended | INFO | `hook.event` | |

Every event may also carry `permission.mode` and `effort`. Design problems engineering sends back to a design package are `team_ops.friction` with `friction.kind` `handoff` and `work` set to the package — the cross-team signal the coach weighs most.

```logql
# Friction per unit of work and kind, in Loki
sum by (work, friction_kind) (count_over_time({service_name="team-ops"} | event_name="team_ops.friction" [$__range]))
```

Loki stores OTel attributes as structured metadata, with dots turned into underscores.

### What leaves the machine

By default, events carry only names and categories: which agent, which work, which tool, what kind of friction. The free text — friction notes, agents' final reports, error messages, commands, file paths, task descriptions — can contain code, customer names or credentials that leaked into an error, so it stays in the local files unless `TEAM_OPS_OTLP_LOG_CONTENT=1`. Turn it on only if your backend is approved to hold what your sessions see.

### Local files

The same records, in `~/.claude/ops/<stream>/`: `events.jsonl` (events, one per line, with `ts` and `event` — the event's name), `friction.jsonl` (with `ts`, `kind` and `note`), and `usage.jsonl` (token snapshots; see the team-ops README). They always hold the free text. Friction recorded before this version has `ticket` where newer records have `work`, and no `session`.

## The example stack

[`stack/`](stack/) is an OTel collector, Prometheus for metrics, Loki for events and Grafana in Docker Compose, with the dashboard provisioned. It's a starting point for a team to run and secure itself, not a supported service.

```sh
cd plugins/team-ops/telemetry/stack
GRAFANA_ADMIN_PASSWORD=<choose one> docker compose up -d
```

Then point team-ops at it, with no headers:

```sh
export TEAM_OPS_OTLP_ENDPOINT=http://localhost:4318
```

Grafana is at http://localhost:3000 (set `GRAFANA_PORT` if 3000 is taken); the *Agent teams* dashboard is its home page: cost by work, agent and model, then friction by kind and agent, tool failures, problems per unit of work, and the friction reports themselves. team-ops exports cost when a cost report runs and events as they happen, and Prometheus scrapes every 15 seconds. The dashboard's per-person panels were built for Claude Code's own metrics, which OpenCode doesn't send, so they stay empty.

**Before a team shares it:** every port is bound to the machine it runs on. To collect from a team, put the collector behind TLS with authentication (an `Authorization` header checked by a reverse proxy or the collector's `bearertokenauth` extension), put Grafana behind your sign-in, and change the admin password. Prometheus and Loki keep 400 days of data in Docker volumes; back them up if the history matters.

**Already have Grafana?** Import [`agent-teams.json`](stack/grafana/dashboards/agent-teams.json) and pick your Prometheus and Loki data sources. It assumes the collector's Prometheus exporter naming (`translation_strategy: UnderscoreEscapingWithSuffixes`) with resource attributes as labels, and Loki's native OTLP ingestion — see [`otel-collector.yaml`](stack/otel-collector.yaml).
