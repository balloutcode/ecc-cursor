---
name: multi-workflow
description: Route a task across research, plan, implementation, and review using plugin subagents in parallel where the work does not overlap.
---

# Workflow - Routed Subagent Pipeline

Research, plan, implement, and review by routing each step to plugin subagents. Parallel steps each run in their own environment.

$ARGUMENTS

## Routing

- UI, layout, components: `ecc-code-explorer`, then `ecc-react-reviewer` and `ecc-a11y-architect` in parallel.
- API, data, and backend structure: `ecc-architect`, `ecc-database-reviewer`, and `ecc-security-reviewer` in parallel.
- An approved implementation slice: `ecc-tdd-guide`, one subagent per set of files that do not overlap.
- Final pass: `ecc-code-reviewer` and `ecc-security-reviewer` in parallel.

## Workflow

1. Classify the request as UI, backend, or both.
2. Launch the matching research and design subagents in the background. Wait for all of them.
3. Write the synthesis to `.ecc/plans/<name>.plan.md` and stop if the user has not approved a plan yet. `/plan` is the single-plan alternative.
4. After approval, hand independent slices to `ecc-tdd-guide`.
5. Run the final reviewers in parallel. Fix findings. Stop after they pass or after three rounds.

## Rules

- No external model CLI and no wrapper binary.
- The parent agent integrates file edits. Subagents that share files do not run at the same time.
