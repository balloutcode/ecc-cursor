# VERIFY — ручные проверки плагина ecc-cursor на Windows

Каждая TODO(verify) из PLAN.md получает запись здесь после ручной проверки.
Формат: дата, версия Cursor, что сделано, наблюдение, вывод.

## Фаза 1 (ожидает ручной проверки)

Чек-лист для пользователя после `node scripts/cursor-plugin/install-local.js` и
Developer: Reload Window:

1. Customize -> Plugins: плагин `ecc-cursor` виден, без ошибок загрузки.
2. Customize: видны ли 322 скилла, 110 команд, 72 агента, 121 правило (латентность
   открытия Customize замерить примерно, сек).
3. Output -> Hooks: записи без ошибок.
4. `%USERPROFILE%\.cursor\ecc\probe.log`: для каждого из 4 событий (sessionStart,
   preToolUse, stop, subagentStop) — какие формы команды (A/B) реально сработали,
   фактические argv/cwd, значения CURSOR_PLUGIN_ROOT и CURSOR_PROJECT_DIR,
   workspace_roots из payload.

Вопросы, на которые должна ответить проверка (TODO(verify) из PLAN.md раздел 12):

- [ ] Раскрытие `${CURSOR_PLUGIN_ROOT}` в команде хука под PowerShell (форма A не
      зависит от него; форма B зависит от cwd).
- [ ] cwd stop/subagentStop = корень workspace (стабильно ли).
- [ ] CURSOR_PROJECT_DIR: всегда ли установлен, чему равен.
- [ ] Поля `displayName`/`category` в plugin.json: не ломают ли загрузку.
- [ ] preToolUse с `matcher: "*"` в hooks.json плагина: срабатывает ли.
- [ ] Лимиты/латентность на 322 скилла в Customize.

Результат (19.11.2026, ~22:32-22:37 МСК, локальная установка, probe.log, 8 записей):

- [x] **Рабочая форма команды — A** (`node -e "require(...CURSOR_PLUGIN_ROOT...)" <event>`):
  срабатывает для stop и preToolUse; `argv = [node, <event>]` (событие в argv[1]).
- [x] **Форма B** (`node ./hooks/probe.js <event>`): работает только для preToolUse
  (cwd = папка плагина). Для stop записей формы B НЕТ: cwd stop = корень workspace,
  `./hooks/probe.js` там не резолвится, молчаливый отказ (как предсказывал PLAN).
  Вывод: форма B непригодна для stop/subagentStop -> выбрана форма A.
- [x] **cwd stop/subagentStop = корень workspace** — подтверждено (stop:
  `$env:USERPROFILE\Documents\CursorRepos\ecc-cursor`).
- [x] **CURSOR_PLUGIN_ROOT** установлен: `$env:USERPROFILE\.cursor\plugins\local\ecc-cursor`.
- [x] **CURSOR_PROJECT_DIR** установлен, равен корню workspace (но строчная буква
  диска `c:\...` против заглавной в cwd — сравнивать пути case-insensitive).
- [x] **CLAUDE_PROJECT_DIR** Cursor выставляет сам (alias, то же значение).
- [x] **preToolUse `matcher: "*"`** срабатывает (tool_name "Read"); хук стреляет
  на каждый вызов инструмента (2 параллельных Read -> 2A+2B записи).
- [x] **workspace_roots** присутствует, НО формат `/c:/Users/...` (ведущий слэш,
  прямые слэши) — невалидный win32-путь для fs; добавлена нормализация
  `normalizeWorkspaceRoot` в run.js (+ тест).
- [x] **sessionStart** (19.11.2026, 19:43:50 и 19:44:02): срабатывает в ОБЕИХ
  формах (A и B), cwd = папка плагина. Edge: первый вызов пришёл с ПУСТЫМИ
  `CURSOR_PROJECT_DIR` ("") и `workspace_roots` ([]) — сессия без workspace-
  контекста; через ~12 сек повторился с заполненными значениями. Цепочка
  run.js это выдерживает (пустое -> фолбэк на cwd), но тогда project dir =
  папка плагина: фаза 6 должна решить, не выставлять ли CLAUDE_PROJECT_DIR
  вовсе при пустом workspace-контексте.
- [x] **subagentStop** (19.11.2026, 19:44:34): срабатывает ТОЛЬКО в форме A,
  cwd = корень workspace (форме B не хватает cwd, как у stop). Payload:
  subagent_type, task, agent_transcript_path, tool_call_count, duration_ms,
  parent_agent_id, child_conversation_id, status. Бонус-факты: preToolUse
  стреляет и на tool_name "Task"; вызовы внутри сабагента несут
  parent_agent_id/parent_tool_call_id; Shell-вызовы несут ключ cwd.
- [ ] **displayName/category** в Customize и латентность списка из 322 скиллов —
  ожидает наблюдения пользователя.
- [ ] **Output -> Hooks**: наличие ошибок (в т.ч. молчаливых отказов формы B для
  stop) — ожидает наблюдения пользователя.

Payload-факты (stop): keys = cache_read_tokens, cache_write_tokens,
conversation_id, cursor_version, generation_id, hook_event_name, input_tokens,
loop_count, model, model_id, model_params, output_tokens, session_id, status,
transcript_path, user_email, workspace_roots. preToolUse: + tool_input, tool_name,
tool_use_id. platform win32, node v22.23.2 (из PATH, не sandbox).

## Фаза 2

Проверка: `node scripts/cursor-plugin/install-local.js`, Developer: Reload Window,
локальная установка `~/.cursor/plugins/local/ecc-cursor` (20.11.2026).

Customize -> Plugins -> `ecc-cursor`:

- [x] **Rules: 121** — OK.
- [x] **Skills: 325**, в т.ч. `ecc-context-dev`, `ecc-context-research`,
      `ecc-context-review` — OK.
- [x] **Hooks: 4** события (форма A, фаза 1) — OK.
- [x] **MCP chrome-devtools** — работает — OK.

Правила в контексте агента:

- [x] **alwaysApply: true** — все **10** common-правил (`common-agents`,
      `common-code-review`, `common-coding-style`, `common-development-workflow`,
      `common-git-workflow`, `common-hooks`, `common-patterns`,
      `common-performance`, `common-security`, `common-testing`) видны в
      контексте агента — OK.
- [ ] **globs** — при открытом файле `*.ts` (проверка: `tmp-rule-check.ts` в
      корне репозитория) правило `typescript-coding-style` **не** попало в
      контекст агента по запросу «какие правила активны». Шапка правила в
      Customize показывает globs; подключение по glob в чате не подтверждено.
- [x] Контекст-скиллы вызываются только явно (`disable-model-invocation`) —
      OK по Customize; автовызов не проверялся отдельно.

TODO(verify):

- [ ] **globs в контексте агента** — повторить при **чтении/правке** `.ts`-файла
      агентом (не только «файл открыт у пользователя»); зафиксировать в фазе 4
      вместе с замером `paths:` у языковых скиллов. Шаг перенесён в чек-лист
      фазы 4 (пункт 6).

## Фаза 3

Проверка: `node scripts/cursor-plugin/install-local.js`, Developer: Reload Window,
локальная установка `~/.cursor/plugins/local/ecc-cursor` (22.11.2026).

Customize -> Subagents / чат:

- [x] **72 субагента `ecc-*`** — OK (bare-имён и дубликатов нет).
- [x] **`/ecc-planner`** — вызывает сабагента `ecc-planner`, план возвращается
      в родительский чат — OK (Done-when фазы 3 по PLAN.md).

Чек-лист (расширенный; пункты без отметки не проверялись в этой сессии):

1. [x] Customize -> Subagents: 72, имена `ecc-*`.
2. [ ] У read-only агента признак `readonly` в Customize (TODO(verify): как
      отображаются `readonly` и `model: inherit`).
3. [ ] Раздел `## Recommended tools` и MCP-блоки у `ecc-docs-lookup` /
      `ecc-gan-evaluator` в UI (достаточно сборки/тестов; UI не смотрели).
4. [x] Явный вызов `/ecc-planner` — делегирование и ответ.
5. [ ] Автоделегирование по description без явного имени.
6. [ ] Read-only: `ecc-planner` не правит файлы при явной просьбе.

TODO(verify):

- [ ] **readonly / model inherit в Customize** — отложено.
- [x] **Вызов `/ecc-planner`** — подтверждено.
- [ ] **Автоделегирование** с 72 сабагентами — отложено.
- [ ] **readonly на запись файлов** — отложено.

## Фаза 4

Проверка: `node scripts/cursor-plugin/build.js`,
`node scripts/cursor-plugin/install-local.js`, полный рестарт Cursor,
локальная установка `~/.cursor/plugins/local/ecc-cursor` (24.11.2026).

Customize -> Plugins -> `ecc-cursor` (после переустановки и полного рестарта):

- [x] **Логотип, v0.1.0** — OK.
- [x] **MCP chrome-devtools** — OK.
- [x] **Skills: 325** — OK.
- [x] **Subagents: 72** — OK.
- [x] **Rules: 121** — OK.
- [x] **Commands: 110** — OK.
- [x] **Hooks: 4** — OK.

Примечание: ранее Customize показывал Skills 254 из-за битой установленной
копии (в ней был только `skills/`, без `plugin.json`, `rules/`, `agents/`,
`commands/`, `hooks/`, `assets/`); переустановка исправила.

Чек-лист:

1. [x] Customize: логотип, v0.1.0, MCP chrome-devtools, Skills 325,
   Subagents 72, Rules 121, Commands 110, Hooks 4 — OK (см. примечание про
   битую копию).
2. [x] `/tdd-workflow` — OK: в установленной копии `.ecc/tdd/` и `.claude/tdd/`
   нет. Косметика: строка ~249 («If the repository already uses Claude-specific
   local artifacts, the .ecc/tdd/ location is also acceptable») после замены
   звучит нелогично — TODO(cosmetic).
3. [ ] Ссылки на агентов — PARTIAL: ссылки в обратных кавычках переписаны на
   `ecc-*`, файлы есть в `agents/`. Голые имена в таблицах и прозе
   (`prompt-optimizer`, `brownfield-retrospective`, `plan-orchestrate`,
   `orch-add-feature`) остались без `ecc-`. В `opensource-pipeline`
   `subagent_type="opensource-forker"` указывает на несуществующего агента.
   TODO(verify, phase 5): расширить трансформ агентских ссылок.
4. [x] `/plan-canvas` — OK: `.ecc/plans/` и `<ECC_AGENT_DATA_HOME>/plan-canvas/`;
   `.claude/` и `~/.claude/` нет.
5. [x] `typescript-patterns` с `paths:` — OK: вызывается через
   `/typescript-patterns`.
6. [ ] Globs-правило — FAIL: правило не подключилось даже с `@`-файлом.
   TODO(verify, phase 8). Перенесено из фазы 2.
7. [ ] Скиллы из allowlist `path-map.json` (например `/security-scan`,
   `/config-gc`, `/gateguard`) — в этой сессии не проверялись.

Результат (24.11.2026): Customize и вызовы `/tdd-workflow`, `/plan-canvas`,
`/typescript-patterns` — OK. Ссылки на агентов — PARTIAL (TODO phase 5).
Globs — FAIL (TODO phase 8).

## Фаза 5

Проверка: `node scripts/cursor-plugin/build.js`,
`node scripts/cursor-plugin/install-local.js`, полный выход и повторный запуск
Cursor (Reload Window бывает недостаточно), локальная копия
`%USERPROFILE%\.cursor\plugins\local\ecc-cursor`.

Ожидание сборки: Skills 325, Commands 110. Среди команд есть
`ecc-plan-canvas` и `ecc-ecc-guide` (коллизия со скиллом того же имени;
скиллы `plan-canvas` и `ecc-guide` остаются). Команды `plan-canvas` и
`ecc-guide` в списке Commands быть не должно.

Чек-лист (каждую проверку — отдельным промптом «прочитай установленную копию,
ничего не меняй»):

1. [ ] Customize: Skills 325, Commands 110. В Commands есть `ecc-plan-canvas`
   и `ecc-ecc-guide`, нет дубля `plan-canvas` / `ecc-guide`.
2. [ ] Новый чат, `/plan`: текст ссылается на `ecc-planner` (и другие `ecc-*`,
   если они названы). Файлы есть в `agents/`.
3. [ ] Новый чат, `/code-review`: текст ссылается на `ecc-code-reviewer` и
   `ecc-security-reviewer`.
4. [ ] `/code-review` и аргумент: в установленной `commands/code-review.md` нет
   `$ARGUMENTS`, есть блок Arguments. После команды можно написать номер или
   URL PR, либо ничего — тогда локальное ревью.
5. [ ] `skills/prompt-optimizer/SKILL.md`: в таблице агентов `ecc-planner`,
   `ecc-tdd-guide`, `ecc-code-reviewer`, не голые имена.
6. [ ] `skills/opensource-pipeline/SKILL.md`: `subagent_type="ecc-opensource-forker"`
   (и sanitizer, packager), не голый `opensource-forker`.
7. [ ] `skills/brownfield-retrospective/SKILL.md`: диаграмма начинается с
   `ecc-planner (scope the row)`.
8. [ ] `commands/evolve.md`: fallback на `%USERPROFILE%/.cursor/plugins/local/ecc-cursor`,
   инстинкты в `~/.local/share/ecc-homunculus`, нет `CLAUDE_PLUGIN_ROOT`.
9. [ ] `commands/instinct-status.md`: предупреждение по-прежнему про legacy
   `~/.claude/skills/continuous-learning-v2/`, чтение инстинктов — из
   `~/.local/share/ecc-homunculus`.
10. [ ] `commands/learn-eval.md` и `commands/skill-create.md`: проектные скиллы
    в `.cursor/skills/`, не в `.ecc/skills/`.
11. [ ] `commands/cost-report.md`: сниппет читает `ECC_AGENT_DATA_HOME`, запасной
    путь `.cursor/ecc`, без `".claude"`.

TODO(verify):

- [ ] Общий слэш у скилла и команды (`/plan-canvas` против `/ecc-plan-canvas`).
- [ ] `disable-model-invocation` снят у `setup-pm` и `auto-update` (поля нет в
      схеме команд Cursor). Не вызываются ли они сами из описания.
- [ ] Bash-сниппеты критичных команд под PowerShell (PLAN.md раздел 8; агент
      переводит сам, точечно не переписывались).
- [ ] Globs-правило — по-прежнему FAIL с фазы 4, владелец фаза 8.
