# Evals

Behavior evals for the teams, run by `scripts/eval.mjs`. The Node test suite in `test/` checks the code; these check what the agents and skills actually do when a model reads them: whether a skill fires when it should and stays quiet when it shouldn't, and whether an agent reaches the right verdict on a case with a known answer.

They call a real model through your OpenCode, so they are slow, cost money and are noisy. They run locally and on request. CI does not run them. (`test/evals.test.mjs` and `test/eval-runner.test.mjs` check the cases and the runner without a model, and do run in CI.)

```sh
npm run eval -- --list                                   # the cases
npm run eval -- --case review-catches-sql-injection      # one case, one run
npm run eval -- --tag negative --runs 3                  # every near-miss case, three runs each
npm run eval -- --model openrouter/anthropic/claude-haiku-5.5 --judge-model <another model>
```

Options: `--case <text>` (name contains; comma-separated for several), `--tag <tag>`, `--runs <n>` (default 1), `--model <ref>` and `--judge-model <ref>` (`provider/model`, default `openrouter/anthropic/claude-haiku-5.5` for both; the judge defaults to the model under test), `--fail-under <0..1>` (exit 1 when a case's mean score is lower), `--keep` (leave each run's repository for inspection; delete it afterwards), `--list`.

## How a run works

A run is a throwaway git repository in the system temp directory: the case's scaffold, the teams installed into it (`install.mjs --project`, every tier on `--model`), an `opencode.json` denying what the case doesn't allow, and `opencode run --standalone --auto` with the case's prompt. It uses your OpenCode as configured, so it needs a working model credential, and it starts a private server per run. What the run did is read from OpenCode's session records, the top-level agent's and every dispatched agent's, then graded. The runner deletes the sessions it made and the repository.

Needs `opencode` on your `PATH`, git, and `bash` for scaffold scripts (macOS or Linux).

## Layout

```
evals/
  <plugin>/<case>/
    prompt.md          the prompt, and frontmatter: description, tags, tools, agent (optional), timeout_seconds
    graders/*.md       one pass/fail check each: tool_used, regex or llm
    case.yaml          only when a case needs a scaffold script
    scaffold.sh        builds the repository the case runs in
```

A case with no scaffold runs in an empty repository with the teams installed. Scaffold scripts run in the repository's directory, as you.

## Writing a case

**`tools` is what the run may use.** A case that doesn't list `edit` can't change files, one that doesn't list `shell` can't run commands, and the network (`webfetch`, `websearch`) is denied unless listed. Names are OpenCode's: `read`, `glob`, `grep`, `skill`, `subagent`, `delegate`, `edit` (also `write`), `shell`.

**Graders** are files in `graders/`:

- `tool_used`: `tool` (a name, or an alternation such as `subagent|delegate`, matched against the whole tool name), optional `input_match` (a regular expression tested against the call's input as JSON), `min` (default 1) and `max` (`0` means it must not fire). Calls by dispatched agents count.
- `regex`: `pattern` and optional `flags`, tested against everything the top-level agent said, or, with `scope: all`, everything every agent in the run said (use it to check a dispatched agent's own wording, which the top-level agent may paraphrase).
- `llm`: the file's body is a rubric; a judge model gets it with the agent's final message and answers PASS or FAIL.

A skill is a `skill` call with `"id": "<name>"`. The two tools that have a skill and a tool of their own (`start_work`, `log_friction`) are graded as either.

**Name the behavior, and test the near miss.** A skill that fires on everything costs context. For each skill there is a positive case and, where a neighbor exists, a negative case with a similar prompt that must not fire it (`api-pricing-question-skips-cost-report`). Positive prompts must not name the skill; a test checks it.

**Pair a result with a process check.** `review-catches-sql-injection` checks that the reviewer was dispatched, that the verdict is Request changes, and, with a model judge, that the finding names the injection in the right place. Prefer deterministic graders (`tool_used`, `regex`); keep `llm` graders for short answers with a concrete PASS/FAIL rubric.

**Agents are dispatched by name, or run as the session agent.** A case can ask the default agent to dispatch one ("Use the engineering-team/code-reviewer agent to…"), which exercises that agent's own instructions, including its tools. The leads (`tech-lead`, `product-lead`) and `agent-coach` are primary agents: OpenCode won't dispatch them, so a case sets `agent: engineering-team/tech-lead` in its frontmatter and the prompt speaks to it directly. Give such a case the tools its behavior needs (a lead that is refused `shell` declines for the wrong reason).

## What the cases can and can't tell you

- **Negative cases catch a description that is too broad.** A skill whose description says "use this for every coding question" fails its near-miss case.
- **Positive cases do not catch a degraded description.** The model picks a skill from its name as well as its description, so a passing positive case says the skill loads, is reachable and is chosen for that kind of request, not that its description is good. Positive prompts avoid the skill's own words for that reason, which narrows the gap without closing it.
- **A score of 0 on every case is a loading problem first.** Run one case with `--keep` and read the repository: is `.opencode/agents` there, and did `opencode run` produce a session?
- **One run is one sample.** A model's choice varies; use `--runs 3` before believing a 0 or a 1.

## What a run costs

It depends on the model you choose and how much each case makes the agents read. Use a cheap model while iterating, one case at a time and `--runs 1`; the runner prints each case's score as it finishes, so a suite can be stopped. The cost report (`cost.mjs`) is not used: each run is in its own repository and its sessions are deleted, so check your provider's dashboard.

## When a case fails

Run it alone with `--keep`, then look at the repository it names: the installed agents, the scaffold, the permission file. The line under the score says which grader failed and why (how many times a tool was used, or the judge's reason).
