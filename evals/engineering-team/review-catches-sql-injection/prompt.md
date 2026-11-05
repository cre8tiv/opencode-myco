---
description: The reviewer should reject a diff that builds SQL from user input, name where, and not touch the code.
tags: [agent, code-reviewer, engineering-team, portable]
tools: [subagent, read, glob, grep]
timeout_seconds: 600
---
Use the engineering-team/code-reviewer agent to review the change on branch CLOUD-7-search. The diff against main is in CLOUD-7.diff and the full files are in the working tree. The task was CLOUD-7: let staff search orders by the free-text note. Give me its verdict and findings as it reports them.
