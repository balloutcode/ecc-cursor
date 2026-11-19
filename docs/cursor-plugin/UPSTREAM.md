# UPSTREAM

Зафиксированная точка синхронизации форка `balloutcode/ecc-cursor` с upstream.

- upstream: `https://github.com/affaan-m/ECC.git` (fetch), push: `DISABLE`
- upstream/main: `3f14a103a8694e51c1df9a806217a6d0b5f7a6f7` (17.11.2026)
- main форка: `6a3901ef35cd9fb488b7b129186d0bd13b2a5210` (`docs(cursor-plugin): plan v1`)
- Проверка наследования: `git merge-base --is-ancestor upstream/main main` -> код 0 (19.11.2026)
- Зафиксировано: 19.11.2026, ветка `cursor-plugin/phase-1`

Правила синхронизации:

- `git fetch upstream --no-tags` -> `git merge upstream/main` в `main`; теги `v*` не скачиваем и не пушим (на них реагирует release.yml с NPM_TOKEN).
- Теги плагина: `ecc-cursor-v<semver>`.
- Правки upstream-файлов: цель 0; вынужденные правки 1-5 строк фиксируются в [UPSTREAM-TOUCHES.md](UPSTREAM-TOUCHES.md).
- Базовая линия `npm test` на Windows для `3f14a103`: 41 падение из 10015 в 10 файлах (command-plugin-root, ecc-statusline-late, orchestrate-codex-worker, observe-entrypoint-allowlist, check-spec-freshness, continuous-learning-observe-runner, plugin-hook-bootstrap, grok-canonical-install, npmscan-workflow, antigravity-lifecycle). Базовую линию не чиним.
