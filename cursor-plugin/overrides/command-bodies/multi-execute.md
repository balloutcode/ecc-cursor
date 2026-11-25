---
name: multi-execute
description: Implement an approved plan by delegating independent slices to plugin subagents, then review in parallel.
---

# Execute - Parallel Subagent Implementation

Implement an already approved plan. Independent slices run as background subagents, each in its own environment. The parent agent integrates their results.

$ARGUMENTS

## Subagents

1. `ecc-tdd-guide` — one subagent per independent slice. Tests first, then the implementation for that slice only.
2. After the slices land, launch `ecc-code-reviewer` and `ecc-security-reviewer` together. Each reviews in its own environment and does not see the other's notes.

Do not give two subagents the same files. Overlapping slices run one after another.

## Workflow

1. Read the plan (`.ecc/plans/` when the plan was written by `/multi-plan` or `/plan`). If there is no plan, stop and ask for one.
2. Split the plan into slices that do not share files.
3. Launch one `ecc-tdd-guide` per slice, in the background. Each prompt names the files it owns and forbids edits outside them.
4. Wait for every slice. Integrate the edits in the parent workspace.
5. Launch `ecc-code-reviewer` and `ecc-security-reviewer` in parallel. Fix what they flag, then re-run only the reviewer that failed.
6. Stop after the reviewers pass, or after three review rounds, and report what is left.

## Rules

- No external model CLI and no wrapper binary.
- A slice without a failing test first goes back to `ecc-tdd-guide`.
