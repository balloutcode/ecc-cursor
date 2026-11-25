---
name: multi-backend
description: Plan and implement backend work with plugin subagents in parallel, each in its own environment.
---

# Backend - Parallel Subagent Workflow

Backend research, design, implementation, and review. Delegates run in the background, each in its own environment.

$ARGUMENTS

## Subagents

1. `ecc-code-explorer` — existing handlers, data access, and boundaries.
2. In parallel after that: `ecc-architect` (structure), `ecc-database-reviewer` (schema and queries), `ecc-security-reviewer` (auth, input, secrets).
3. `ecc-tdd-guide` — implementation slices that do not share files.
4. `ecc-code-reviewer` — final pass, in parallel with a fresh `ecc-security-reviewer` if the slice touches input, auth, or data.

## Workflow

1. Restate the backend change.
2. Run the explorer, then the three design reviewers in parallel.
3. Write `.ecc/plans/<name>.plan.md` and wait for approval before editing production code.
4. Implement with `ecc-tdd-guide`. Overlapping files are sequential.
5. Review, fix, and stop after the reviewers pass or after three rounds.

## Rules

- No external model CLI and no wrapper binary.
- Schema changes go through `ecc-database-reviewer` before implementation.
