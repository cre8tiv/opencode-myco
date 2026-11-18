# QA Library

Owned by the `qa-specialist` agent. The point is compounding: each validation run
should leave behind something that makes the next one cheaper.

## Layout

- `INDEX.md` — the catalog. Entry point for every run; kept current, not append-only.
- `plans/` — test plans, named by **feature area** (`connection-editor.md`), not by
  ticket, so coverage accumulates in one place instead of fragmenting.
- `scripts/` — reusable automation: browser specs, HTTP probes, CLI checks, consumer
  harnesses, migration runners, helpers. Parameterize rather than fork; a second
  harness for the same entry point is a smell.
- `fixtures/` — seed data, saved auth state, sample payloads.
- `runs/<YYYY-MM-DD>-<TICKET>/` — per-run evidence: `report.md` plus logs and captures.

## What is and isn't committed

`plans/`, `scripts/`, `fixtures/` and each run's `report.md` are committed — they are
project assets and should merge alongside the change they cover. Screenshots, videos and
traces stay on disk under `runs/` and are referenced by path from the report;
`runs/.gitignore` handles that.

## How this project gets exercised

See `.myco/team/project.md` — it records what kind of software this is, the build and
run commands, which environments exist, and which automation harness already exists.
QA extends what's there rather than inventing a parallel one.

If the project has a web surface and a browser automation MCP server is configured,
live driving is for exploration and one-off visual confirmation only. Flows that pass
get codified as committed scripts here. Prefer stable test ids over brittle structural
selectors.

## Plan template

```markdown
# <Feature area>

Covers: <what this plan is responsible for>
Environments: <which of the environments in project.md this runs against>
Setup: <fixtures, seeding, auth prerequisites>

## Scenario: <name>          [automated: scripts/<file> | manual]
  Given <precondition>
  When <action>
  Then <observable outcome>

## Regression watch list
- <what this area has broken before, and the scenario that catches it>

## Notes
- <anything that cost time: unstable selectors, reseed requirements, timing>
```
