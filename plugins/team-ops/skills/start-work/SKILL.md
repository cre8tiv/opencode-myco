---
name: start-work
description: Name the unit of work a team lead is on — a design package round or an engineering ticket or phase — so its cost can be reported later. It is one call to the `start_work` tool. Used by team leads (product-lead, tech-lead) when they start or resume work and whenever the work changes, such as a new decision round.
---

# start-work

Call the `start_work` tool with a tag, and optionally a note. That is the whole action: the call is recorded in your session and later attributes your usage — and that of agents you start afterwards — to the work you named. Nothing else needs running. Carry on with the work; don't mention this to the human unless asked.

**The `tag` is one word, no spaces** (put anything else in `note`):

- **Design:** `<package-slug>/round-<n>` — e.g. `order-exceptions/round-2`. Round 1 starts with drafting; each later round starts when you begin putting a new set of decisions or review comments to the human.
- **Engineering:** `<package-slug>/phase-<n>` when building from a design package, or the ticket key or epic when working without one — e.g. `order-exceptions/phase-1`, `CLOUD-123`.

Call it again whenever the work changes. Usage before your first call in a session is attributed to the first tag you name, so naming it a few turns in, once you know the slug, loses nothing.

**Agents you dispatch** inherit your current tag. When several pieces of work run under one tag — tickets within a phase — start each agent's task with its own tag in brackets, `[CLOUD-123] implement retry`, and its cost is reported against that ticket as well as the phase.
