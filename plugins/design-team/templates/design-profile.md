---
# Written by /init-design (or by the product-lead the first time it's needed), then
# edited by humans. The design-team agents read this for everything specific to THIS
# project. Keys below are read by tooling — keep them present and keep the names.
stream: <short-slug-for-this-project>
packages_dir: docs/design
# where packages are published beyond the repo: none | confluence | notion | linear | other
publish_to: <none>
# how UX prototypes are made: claude-design | html | wireframes
ux_prototypes: <html>
# readable review pages for each package, published as claude.ai artifacts: artifact | none
review_pages: <artifact>
# product name used in review page titles, e.g. "Northwind"
product_name: <Product>
# the design hub's claude.ai link: a shared hub found at init, or written the first time a review page is published
review_hub: <none>
generated: <YYYY-MM-DD>
---

# Design profile

## Where design packages live

- **Package directory:** `<packages_dir>/<slug>/` — the working source of truth.
- **How packages get reviewed:** <a branch and PR per package | direct commits | review in the published copy>
- **Who signs off:** <names or roles whose agreement makes a package "Ready for engineering">

## Publishing

Leave this section as "none" if the repo is the only copy.

- **Destination:** <e.g. Confluence — space `ENG`, parent page "Design packages" (id 12345)>
- **Tools:** <the MCP tool prefix, e.g. `mcp__atlassian__*`, and which calls create vs. update>
- **What gets published:** <all documents | PRD only | PRD + architecture>
- **When:** <on "Ready for engineering" | at each decision round | on request>
- **Diagrams:** <renders Mermaid natively | publish as code blocks | export images> — Confluence and some wikis don't render Mermaid without a macro.
- **Format notes:** <anything the destination needs: a page template, labels, a status macro>

## Review pages

Each package is published as a readable page — a summary for people, then every document rendered from the markdown — that reviewers can share and comment on. Comments feed the next decision round. The design hub lists every package with its review link.

- **Published:** <yes, as claude.ai artifacts | no — `review_pages: none`>
- **Titles:** `<product_name> <initiative> design` for a package; `<product_name> design packages` for the hub.
- **Who reviews:** <who the product lead should suggest sharing pages with, beyond the sign-off names>
- Pages are private until shared from claude.ai. Publishing needs an interactive session signed in to claude.ai.

## Where to ground

The systems the product lead and specialists search before recommending anything.

- **Tracker:** <e.g. Jira project KEY via `mcp__atlassian__*`, Linear team via `mcp__linear__*`>
- **Wiki / docs:** <e.g. Confluence spaces, Notion workspace, a docs/ directory>
- **Repos:** <this repo, plus any others the work commonly touches>
- **Prior design work:** <where earlier PRDs, RFCs and ADRs live, if not in packages_dir>
- **Other context:** <analytics, support tickets, research repositories — with the tool to reach each>

## Existing PRDs and specs

Where pre-existing product documents usually come from, so adopting one doesn't start with a search.

- **Usual sources:** <e.g. Confluence space PM, Notion "Specs" database, Google Drive folder>
- **How to fetch:** <the MCP tool, or "export and paste">

## Security and compliance context

- **Frameworks and obligations:** <e.g. SOC 2, GDPR, HIPAA — or "none beyond standard practice">
- **Data classification scheme:** <the scheme's levels, or "public / internal / confidential / restricted">
- **Existing security mechanisms to reuse:** <auth provider, secrets store, audit log>
- **Who must be consulted:** <e.g. security team for any auth change>

## UX and design system

- **Surfaces this product has:** <web app, CLI, API, email, mobile>
- **Canonical design system:** <which one wins when they disagree — usually the repo's, since engineering builds from it>
- **Fidelity expected:** <low-fi structure and states (default) | higher fidelity>

### Design systems and references

Every design system and design artifact the ux-designer should design within. List only what's relevant to this product.

| What | Kind | Where | Notes |
| ---- | ---- | ----- | ----- |
| <e.g. Acme DS> | claude.ai design system | <link> | <used for Claude Design canvases> |
| <e.g. tokens> | repo | <`packages/ui/tokens.json`, `tailwind.config.ts`> | <source of truth for colors, type, spacing> |
| <e.g. component library> | repo | <`packages/ui/`, Storybook URL> | <components engineering already has> |
| <e.g. Product library> | Figma | <file or team, via `mcp__figma__*`> | <what's in it> |
| <e.g. Onboarding canvas> | design artifact | <claude.ai artifact link> | <prior exploration to build on> |

### Prototypes

- **Prototype mode:** <claude-design | html | wireframes> — must match `ux_prototypes` above.
- **Claude Design access:** <granted by <name> on <date> | not granted | not offered on this plan>. Access is granted per person with `/design consent`, tied to their claude.ai login, not to this project — every teammate who runs the design team grants it once. Without it, prototypes fall back to self-contained HTML.

## Conventions and gotchas

<Anything that has bitten a design here before: a dependency that's always "planned" but never ships, a team that must be consulted on any auth change, a platform limit, a destination quirk.>
