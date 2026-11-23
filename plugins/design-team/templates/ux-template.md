# UX template

Use these sections in this order. Guidance under each heading is for you; replace it with content. Mark a section N/A with a one-line reason rather than deleting it. Flows are Mermaid; wireframes are plain text.

---

```markdown
| | |
| --- | --- |
| **Status** | Draft — N open questions |
| **PRD** | [prd.md](prd.md) |
| **Last updated** | <date> |
```

## 1. Users and jobs

For each PRD actor that touches this surface, by actor ID: the job they're trying to do, how often, the context that shapes it (device, environment, interruptions, how many at once), and what "done" feels like to them. An AI agent or system actor with no visual surface still belongs here if it reaches the product through an interface this design shapes — a CLI, an API's error messages, a notification.

## 2. Existing patterns reused

The screens, components, commands or conventions this design builds on, with where they live. Anything new, and why the existing pattern didn't fit.

## 3. Surface inventory

Table with columns `ID | Surface | Type | Purpose | Prototype`. IDs are `S-1`, `S-2`. Type is screen, dialog, command, email, notification, and so on. *Prototype* links straight to what shows this surface: the artboard in the Claude Design canvas, or the published HTML prototype. Write "wireframe only" when the wireframe settles it.

## 4. Prototypes

Every prototype for this package, so anyone reading `ux.md` (engineering, QA, or a reviewer on the review page) can open what the UX designer built. Table with columns `Prototype | Kind | Link | Shows | Synced to`.

- **Kind:** Claude Design canvas, or HTML prototype.
- **Link:** the published claude.ai link. An HTML prototype also lists its `ux/` path. A prototype that isn't published yet says "not published — `ux/<file>.html`", and the product lead publishes it before review. Where prototypes can't be published (the package is checked with `check-package.mjs --local-prototypes`), the `ux/` path alone is the link.
- **Shows:** the surfaces (`S-n`) and states it covers.
- **Synced to:** the round and the last D-decision the prototype reflects. When a decision changes a surface, update the prototype at the same link and bump this; never start a new canvas for the same surfaces. A prototype that lags `ux.md` says so here: "stale — synced to round n". "stale" is a marker only in this column; a state named "stale" in *Shows* is just a state.

The first row is the package's primary prototype. The package index's **Prototype** row carries the same link, and the review page and design hub link to it from there; `check-package.mjs` fails the package when the two differ. Write N/A with a one-line reason when there are no prototypes (for example, `ux_prototypes: wireframes`).

Prototypes are private until their owner shares them. Share them with the same people as the review page.

## 5. Flows

One Mermaid flowchart per job, each titled with the actor ID, the PRD scenario (`SC-n`) it walks through, and the requirement IDs it satisfies. Use the scenario's concrete values in the flow. Show where it can fail and where the user can abandon. Every flow ends in success, a recoverable error with a next step, or a flagged dead end.

## 6. States

For every surface: table with columns `State | What the user sees | What they can do next`. At minimum: empty, loading, partial, error, success, no-permission. Where actors see a surface differently, say which actor each row is for; the no-permission state always names the actor who hits it. This table is what QA tests against.

## 7. Wireframes

Low-fidelity layout per surface in plain text or Markdown: structure, hierarchy and content, not visual design.

## 8. Content

The actual words: labels, buttons, empty states, errors, confirmations. Error messages say what happened and what to do next.

## 9. Accessibility

What matters for these surfaces specifically: keyboard paths, focus order, labels, and anything conveyed only by color or position.

## 10. Open questions

A numbered list, each phrased as a decision with your recommendation. Once empty, rename this section **Resolved**, listing each question with the D-decision that settled it.
