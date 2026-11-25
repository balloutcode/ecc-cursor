---
name: multi-frontend
description: Plan and implement UI work with plugin subagents in parallel, each in its own environment.
---

# Frontend - Parallel Subagent Workflow

UI research, design review, implementation, and accessibility review. Delegates run in the background, each in its own environment.

$ARGUMENTS

## Subagents

1. `ecc-code-explorer` — existing components, routes, and styling patterns.
2. In parallel: `ecc-planner` (sequence) and `ecc-react-reviewer` (component boundaries).
3. `ecc-tdd-guide` — implementation slices that do not share files.
4. In parallel at the end: `ecc-react-reviewer` and `ecc-a11y-architect`.

## Workflow

1. Restate the UI change.
2. Run the explorer, then the planner and the React reviewer in parallel.
3. Write `.ecc/plans/<name>.plan.md` and wait for approval before editing production code.
4. Implement with `ecc-tdd-guide`.
5. Run the final React and accessibility reviewers in parallel. Fix findings. Stop after they pass or after three rounds.

## Rules

- No external model CLI and no wrapper binary.
- Accessibility findings from `ecc-a11y-architect` are fixed before the command reports done.
