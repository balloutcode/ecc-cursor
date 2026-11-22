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
      вместе с замером `paths:` у языковых скиллов.

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
