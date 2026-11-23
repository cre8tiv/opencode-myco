<!--
Template for a PR description, and for the ticket text that goes with it.
The reader is a human reviewer who has never opened the design package and sees a
large diff. Write for that person. Drop a section that has nothing in it.

Rules
- Plain, short sentences. Explain a term the first time or don't use it. If
  project.md sets `writing_style`, follow it.
- Design IDs (slice, requirement, control, ADR, decision) appear only in the last
  line. In the body say what the rule is in words.
- Every number (lines, test counts, error codes, base branch) comes from the current
  head: `gh pr view <n> --json files,baseRefName`, the test run, the QA report. Never
  copy one from an older body.
- Rewrite the whole description after each push or review round, so it describes the
  head as it is now. Don't append a changelog. Review history lives in the review
  comments and the edit history.
-->

## Summary

<What a user or admin can do now, in 2-4 sentences, with one concrete example: a
request and its response, an audit row, a log line.>

Ticket: <key and link>. <Part n of N, if the ticket has several PRs.>

## Why

<What is wrong or missing without this change, and what a person sees when it fails.>

## What changes for a caller

| Case | Before | After |
| --- | --- | --- |
| <request or action> | <behaviour> | <behaviour> |
| <a case that does not change> | — | No change |

## How to read this PR

<Include when the PR adds more than about 500 lines, or when QA or generated files are
more than half of it.>

| Part | Lines added | What it is |
| --- | --- | --- |
| `.myco/qa/` | <n> | QA plans, scripts and reports. Not for line-by-line review. |
| Tests | <n> | <kind of tests> |
| <production path> | <n> | <what it does. Say if it is a copy of another part.> |
| Generated or config files | <n> | <what they are and why they changed> |

Suggested order:

1. `<file>`: <what to look for>
2. `<file>`: <what to look for>

## Access and security rules

<Who may do what, and what fails closed, in plain words. Leave out if the change has none.>

## Compatibility and rollout

- **Migration and rollback:** <or "none">
- **Wire or API changes:** <additive or breaking, and for whom>
- **Flags:** <name and default>
- **Deploy order:** <what must be live before or with this PR>

## Testing

- <Test counts, only the ones you ran or read from CI on this head.>
- QA runs, with verdicts: `<path under .myco/qa/runs/>`: <Pass, Fail, or Pass with caveats>, <what was found and fixed>.
- <What is not covered live, and what covers it instead.>
- Steps for a human to check the change are in the ticket's validation field.

## Not in this PR

- <Known limits and follow-up ticket keys.>

## Merge order

<Include when the ticket has more than one PR, or the PR is stacked. List every PR in
the phase in merge order, with its ticket key and one plain line each. Mark this one in
bold. For a stacked PR say what to retarget and when. Mark merged PRs as merged.>

1. #<n>, <KEY>: <what it does>.
2. **#<n> (this PR):** <what it does>.

Design: <slice or section> of the [<package>](<link>) design package.


---

## Ticket description (same rules)

Sections: Why / What a user sees / Who may do what / Pull requests, with the merge
order / Rollout / Known limits, with ticket keys / Design references, where the
requirement IDs and the package link go.

## Validation instructions (same rules, flat lists)

Two parts. Use only the markup `project.md` says the field renders; when it says
nothing, use flat bullets, numbered lists and bold only, with no tables and no nested
lists.

- **What QA already ran:** one bullet per saved report: a link to it on the PR branch,
  its verdict, and what was fixed.
- **Check it yourself (about N minutes):** the environment, the setup, then numbered
  steps. Each step is one action and ends with **Expect:** and the result.
