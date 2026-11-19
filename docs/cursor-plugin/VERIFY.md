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
  `C:\Users\alext\Documents\CursorRepos\ecc-cursor`).
- [x] **CURSOR_PLUGIN_ROOT** установлен: `C:\Users\alext\.cursor\plugins\local\ecc-cursor`.
- [x] **CURSOR_PROJECT_DIR** установлен, равен корню workspace (но строчная буква
  диска `c:\...` против заглавной в cwd — сравнивать пути case-insensitive).
- [x] **CLAUDE_PROJECT_DIR** Cursor выставляет сам (alias, то же значение).
- [x] **preToolUse `matcher: "*"`** срабатывает (tool_name "Read"); хук стреляет
  на каждый вызов инструмента (2 параллельных Read -> 2A+2B записи).
- [x] **workspace_roots** присутствует, НО формат `/c:/Users/...` (ведущий слэш,
  прямые слэши) — невалидный win32-путь для fs; добавлена нормализация
  `normalizeWorkspaceRoot` в run.js (+ тест).
- [ ] **sessionStart** — записей нет: требуется свежий чат после Reload Window
  (сессия, стартовавшая до установки, событие не шлёт).
- [ ] **subagentStop** — записей нет: нужен запуск сабагента (Task).
- [ ] **displayName/category** в Customize и латентность списка из 322 скиллов —
  ожидает наблюдения пользователя.
- [ ] **Output -> Hooks**: наличие ошибок (в т.ч. молчаливых отказов формы B для
  stop) — ожидает наблюдения пользователя.

Payload-факты (stop): keys = cache_read_tokens, cache_write_tokens,
conversation_id, cursor_version, generation_id, hook_event_name, input_tokens,
loop_count, model, model_id, model_params, output_tokens, session_id, status,
transcript_path, user_email, workspace_roots. preToolUse: + tool_input, tool_name,
tool_use_id. platform win32, node v22.23.2 (из PATH, не sandbox).
