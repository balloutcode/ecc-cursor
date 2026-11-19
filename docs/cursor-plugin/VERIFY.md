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

Результат: (заполняется после ответа пользователя)
