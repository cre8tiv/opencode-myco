---
name: log-friction
description: Record process friction an agent hit — its own instructions were unclear or silent, a tool it needed wasn't available, a task arrived too vague to scope, or a handoff lost information — so agent-coach can find patterns across runs. Use when something about how you were asked to work cost you time. Not for ordinary product bugs.
---

# log-friction

Run this once per incident, then carry on with your work:

```sh
node "$MYCO_ROOT/team-ops/scripts/friction.mjs" --agent <your agent name> --kind <kind> --note "<what cost you time, one sentence>"
```

The report is tied to your session and the unit of work you're on automatically. Add `--work <ticket key or design package slug>` only when it's about different work — a design problem found while building, say, which belongs to the package it came from.

`<kind>` is one of:

- `instructions` — your own definition was wrong, unclear, or silent about the situation.
- `tooling` — a tool you needed was missing, broken, or unavailable.
- `permissions` — you were blocked by a permission prompt or allowlist.
- `scope` — the task was too big or too vague to do well.
- `environment` — build, infrastructure, credentials, or a service that wasn't running.
- `handoff` — information was lost or contradicted between agents or teams. This includes design problems engineering sends back to a design package.

Write the note so someone reading it next month understands what happened without the rest of your context: name the step, the thing that was missing or unclear, and what you did instead.

Don't stop work to log, and don't log the same incident twice. If the command fails, mention it in your report and continue — telemetry never blocks delivery.
