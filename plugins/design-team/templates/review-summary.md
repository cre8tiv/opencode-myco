# Review summary template

The **Overview** a human reads first on the review page, written by the product lead for a reader who hasn't opened the package. The full documents render below it unchanged, so this is a guide to them, not a replacement: link to requirements, decisions and sections instead of restating them. Aim for one screen or two.

Save it as `review.md` in the package; the review page picks it up from there. Commit it with the package: a human may edit it, and the next round updates it rather than rewriting it.

No `#` title: the page header already names the initiative. Start at `##`. Link package documents as `[PRD](prd.md)` or `[actors](prd.md#4-actors)`; the page turns them into in-page links. Requirement, decision, actor and scenario IDs (`APR-3`, `D-7`, `A-2`, `SC-1`) are highlighted automatically, and each shows what it stands for when hovered and links to where it's defined. Readers still skim past them, so **write for someone who ignores every ID**: say the thing in plain words and put the ID after it as a reference, "rotating a credential (SC-1)" and "the IT operations admin (A-1)", never as the subject of a sentence. Name a range by what it covers ("the enforcement requirements, ENF-1 to ENF-14"), not by its IDs alone. Give anything that isn't a numbered item in the package, such as a release point or a delivery slice, a name that can't be mistaken for one ("release point 3", not `R3` next to risk `R-03`).

---

```markdown
## What this is

Two or three sentences: the problem, who has it, and what we're building. From the PRD's problem and positioning, in plain language.

## Who it's for

One line per actor: who they are and the context that matters, with the ID after. The warehouse picker (A-1), at shift start on a shared handheld. The customer's AI agent (A-3), calling the API with a service identity.

## How it works

If the package has a prototype, open with one line linking it — "**Try it:** [the prototype](<its link>), artboards per surface and state" — using the links in `ux.md`'s Prototypes table. Seeing the design is usually the fastest way in.

The key scenarios, one short paragraph each, from the actor's point of view. Start each with what happens in words and the ID after it ("**Rotating a credential (SC-1).** The IT operations admin disables…"), and name the actor in words the first time. Link each to its UX flow and architecture flow, and to the prototype artboard that shows it, when there is one. A reader who reads only this section should be able to say what the thing does.

## What's in phase 1

What phase 1 contains, by what each group of requirements covers, with its ID range after it ("disabling and enabling, DIS-1 to DIS-12; enforcement on every query surface, ENF-1 to ENF-14"), and the one-sentence reason they come first. What's deliberately left for later.

## Decisions worth knowing

The five to ten decisions a reviewer would most want to challenge, by D-number, one line each with the reason. Include consequential architecture decisions by ADR number.

## Risks we've accepted

Each accepted risk, one line, with the decision that accepted it.

## What we want feedback on

Specific questions, numbered, each naming who is best placed to answer it. "Does SC-2 match how support actually escalates?" gets answers; "thoughts?" doesn't.

## How to comment

Comment directly on this page, on the text you're responding to. The product lead collects comments into the next design round. To get a reply from Claude in the thread, use **Send to Claude** on it. This page is rendered from the design package in the repository, at the commit shown at the top.
```
