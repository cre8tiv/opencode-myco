---
# Written by /init-knowledge, which /init-design and /init-team run as part of setup.
# Shared by every team: one list of the docs and knowledge bases this project relies on.
# Edit freely; re-run /init-knowledge to re-detect and re-verify.
generated: <YYYY-MM-DD>
---

# Knowledge sources

Where agents look for answers before inferring from the code or from memory. When a
source below covers a question an agent has, the agent consults it first.

## Sources

| Source | How to reach it | Answers | Used by | Authority | Access |
| ------ | --------------- | ------- | ------- | --------- | ------ |
| <e.g. Product docs> | <`mcp__product_docs__*`, or a URL via WebFetch, or a repo path> | <the questions it answers — e.g. "what the product publicly supports: features, APIs, limits"> | <roles — e.g. product-lead, architect, qa-specialist> | <authoritative / internal / community> | <authorized / needs per-person authorization / public> |

**Authority** tells agents how much weight a source carries:

- **authoritative** — the supported, published contract: product docs, API references, policy. When the design team grounds a dependency, this is what makes it *exists-public*.
- **internal** — accurate but not a promise to anyone: engineering wikis, design notes, knowledge graphs, runbooks. A capability found only here is *exists-internal*.
- **community** — useful but unverified: forums, third-party docs, Q&A sites. Confirm before relying on it.

## Codebases

The repositories this work touches, and how to read each. Agents ground in code before
designing or building against it; a repository missing from this list is one they never look at.

**This repository:** <what it is — e.g. "the system being changed", "the design docs repo for connectcloud", "new, empty project">

| Codebase | Remote | Local path | Ref | Role | Answers | Used by |
| -------- | ------ | ---------- | --- | ---- | ------- | ------- |
| <e.g. connectcloud> | <e.g. `github.com/org/connectcloud`> | <e.g. `../connectcloud`, relative to this repo's root — or "—"> | <branch or tag, e.g. `main`> | <system / contract / reference> | <e.g. "how the query service and its APIs work today"> | <roles — e.g. architect, tech-designer, ic-specialist-backend> |

**Role** tells agents what they may do with a codebase:

- **system** — code this work changes, in a repository other than this one. The design team grounds its
  current-state description here. Engineering in *this* repository doesn't change it: a slice that lands
  here is handed off to whoever works in that repository.
- **contract** — a dependency this work builds against but doesn't change: an SDK, a shared library, a service
  whose API is consumed. Its interfaces are constraints.
- **reference** — prior art to learn from or imitate, not to depend on.

All of them are **read-only** to the agents. Code is the truth of how something behaves today, but not a
promise: a capability found only in code is *exists-internal*, like one found only in an internal source.

**Reaching one:** use the local path if it exists — OpenCode treats a path outside this project as external and may ask
before an agent reads it, so allow it with an `external_directory` rule in `opencode.json` (committed, so
isolated agents see it too). Otherwise read it remotely at the
recorded ref (`gh api`, `gh repo clone --depth 1` into a scratch directory, or a GitHub MCP server).
When a design is grounded against a codebase, record the commit it was read at.

## Needs authorization

Connectors that are configured but not authorized for the person running the agents.
Authorization is per person: each teammate authorizes once, through claude.ai
**Settings → Connectors** or `/mcp`. Until then, agents can't reach these sources.

- <e.g. Product docs MCP — authorize to let the design team check public capabilities>

## Not available

Sources the team would use but that this project can't reach yet, so the gap is known
rather than rediscovered.

- <e.g. Support knowledge base — no MCP server; ask support for an export>
- <e.g. billing-service repo — no access granted yet; ask the platform team>
