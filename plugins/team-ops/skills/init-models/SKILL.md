---
name: init-models
description: Choose which of your models each agent team role runs on. Lists the models OpenCode has, asks one question per tier (lead, reasoning, worker), saves the mapping, applies it to the installed agents, and warns about a mapping likely to go wrong. Use after installing the teams, when your providers change, or when an agent runs on a model that doesn't suit it.
---

# init-models

The agent teams don't name any model. Which models exist differs for every user, so each role runs on whatever you map to it, and a role with nothing mapped runs on your default model. This skill sets that mapping.

Run it in the user's main session. It changes the installed agent files, so tell the user before you do.

## The tiers

Roles are grouped by what they need from a model, so the user answers three questions, not eleven:

| Tier | Roles | What it needs |
| --- | --- | --- |
| `lead` | product-lead, tech-lead | Long decision loops, the largest prompts, reliable tool use |
| `reasoning` | architect, security-reviewer, tech-designer, code-reviewer, qa-specialist, agent-coach | Careful analysis. Reviewers and QA are worth most on a **different model from the one that writes the code**, because a review is only independent of the author if the model is |
| `worker` | ic-generalist, ic-specialist-backend, ux-designer | Coding and document drafting, in volume |

## 1. See what's there

Run both:

```sh
opencode models
node "$MYCO_ROOT/team-ops/scripts/models.mjs" show
```

The first lists every model OpenCode can use as `provider/model`. The second shows the current mapping and the model each role gets (`(your default model)` when nothing is mapped).

## 2. Ask

Use `question`, one question per tier, offering models from the list. Always offer "keep my default model" as an answer, and recommend it when the user has only one model: then every tier runs on it and the reviewer-independence warning below is expected.

- Suggest the strongest model for `lead` and `reasoning`, and a faster or cheaper one for `worker` if the user has one.
- A model reference can end in `#variant` (for example `#medium`) when the model has variants. Ask only if the user cares.
- If the user wants one role on a different model, that is a per-role override (below).

## 3. Save and apply

```sh
node "$MYCO_ROOT/team-ops/scripts/models.mjs" set --lead <provider/model> --reasoning <provider/model> --worker <provider/model>
```

Leave a tier's flag out to leave it on the default model. `set` replaces the whole mapping, so repeat any tier the user wants to keep. For a single role add `--agent <team>/<role>=<provider/model>`, for example `--agent engineering-team/code-reviewer=provider/other-model`.

`set` writes the mapping, updates the installed agent files, and prints warnings.

## 4. Report the warnings

Relay each warning in plain words and offer to change the mapping. They are advice, not errors:

- a model OpenCode doesn't list, or a variant it doesn't have;
- a model whose declared context window is too small for the largest prompt it will carry;
- reviewers and QA on the same model as the ICs.

`node "$MYCO_ROOT/team-ops/scripts/models.mjs" check` runs the checks again without changing anything.

## 5. Finish

Say which tiers are mapped and to what, and that new sessions pick up the change; if a session that is already open still shows an old model, restart OpenCode. Reinstalling the teams keeps the mapping. In two or three lines, don't repeat the tier table.
