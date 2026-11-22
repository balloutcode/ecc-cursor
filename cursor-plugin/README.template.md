# ecc-cursor

ECC (Everything Claude Code) as a native Cursor plugin: agents, skills,
commands, rules, hooks and memory workflows, built from the upstream ECC
sources by the fork's builder. This package is generated — do not edit it
directly; change the sources in `balloutcode/ecc-cursor` and rebuild.

## Contents

- 121 rules (language and common coding standards)
- 72 agents (ecc-planner, ecc-code-reviewer, ecc-tdd-guide, ecc-security-reviewer, ...)
- 322 skills (workflow and domain knowledge)
- 110 commands (98 upstream + 12 legacy shims pointing at canonical skills)
- Plugin hooks (session lifecycle and probes; behavioral hooks land in phase 6)
- Runtime scripts required by the components above (require-closure)

## Install

- Local development: `node scripts/cursor-plugin/install-local.js` in the
  fork, then `Developer: Reload Window` in Cursor.
- From GitHub (release branch): Customize -> Plugins -> From GitHub Repository
  -> `https://github.com/balloutcode/ecc-cursor` (phase 8).

## Requirements

- Node.js >= 18 in PATH (hooks are executed through node; no bash on Windows).

## License

MIT. Upstream ECC (c) Affaan Mustafa; see LICENSE.
