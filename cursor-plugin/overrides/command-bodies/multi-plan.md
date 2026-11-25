---
name: multi-plan
description: Create a parallel-subagent implementation plan without modifying production code. For a single inline plan use /plan.
---

# Plan - Parallel Subagent Planning

Build one implementation plan by delegating to plugin subagents. Each subagent runs in its own environment and does not see the other drafts. The parent agent synthesizes a single plan and does not modify production code.

$ARGUMENTS

## Subagents

Launch these in the background, in one turn, each in its own environment:

1. `ecc-code-explorer` — entry points, existing patterns, and constraints.
2. `ecc-architect` — structural draft (modules, data flow, risks, rollout).
3. `ecc-planner` — sequenced draft (phases, dependencies, test gates).

`ecc-architect` and `ecc-planner` run in parallel. Start `ecc-code-explorer` first only when the area to read is not already named.

## Workflow

1. Restate the request.
2. Tell every subagent: read-only, no production edits, return a draft plus open questions.
3. Wait until every background subagent has finished.
4. Synthesize one plan. Where drafts disagree, keep the option that fits the existing architecture and name the alternative you rejected.
5. Write the plan to `.ecc/plans/<name>.plan.md`.
6. Stop for user confirmation before any code is written.

Use `/plan` for a single inline plan. Use `/ecc-plan-canvas` to annotate and approve the written plan.

## Rules

- No production code edits.
- Do not call an external model CLI or a wrapper binary. The only delegates are the subagents named above.
