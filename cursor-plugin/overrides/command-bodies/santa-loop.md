---
name: santa-loop
description: Adversarial dual-review loop. Two plugin subagents must both pass before the change is treated as done. Wraps the santa-method skill.
---

# Santa Loop

Two independent reviewers must both pass. They run in parallel, each in its own environment, and neither sees the other's notes. Follow the `santa-method` skill for the NICE / NAUGHTY gate.

$ARGUMENTS

## Reviewers

Launch both in one turn, in the background:

1. `ecc-code-reviewer` — correctness, regressions, and missing tests.
2. `ecc-security-reviewer` — input, auth, secrets, and injection.

Each prompt includes the rubric, the files under review, and the instruction that the reviewer has not seen another review and should look for problems.

## Workflow

1. Scope the change from the arguments, or from uncommitted files when the arguments are empty.
2. Build a rubric whose criteria are pass or fail. Include correctness, security, error handling, completeness, and regressions.
3. Launch the two reviewers. Wait for both.
4. Both pass: stop and report NICE. Either fails: fix every finding, then launch a fresh pair. Do not reuse a reviewer that already saw the previous round.
5. Stop after three rounds even if a finding remains, and list what is still open.

## Rules

- No external model CLI and no wrapper binary. Model diversity is the two subagents, not a second vendor CLI.
- Reviewers do not edit files. The parent agent applies fixes between rounds.
