---
description: The security reviewer should threat-model the real architecture, find the seeded gaps, write only security-review.md, and give controls IDs.
tags: [agent, security-reviewer, design-team, portable]
tools: [subagent, read, glob, grep, edit]
timeout_seconds: 900
---
Use the design-team/security-reviewer agent on the package at docs/design/order-export/. The PRD and architecture are decided. Have it write the security review, then tell me the required controls and any blocking findings exactly as it reports them.
