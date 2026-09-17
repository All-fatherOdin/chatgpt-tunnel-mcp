# Конфигурация chatgpt-tunnel-mcp 1.0

Конфиги являются строгими JSON-объектами: неизвестное поле вызывает ошибку запуска. Рабочие файлы `*.local.json` исключены из Git; переносимые примеры находятся в `config/`.

## MCP server

| Поле | Значение |
| --- | --- |
| `deviceId` | Обязательно; несекретный ID, 8–128 символов `[A-Za-z0-9._-]`. |
| `probeFile` | Обязательно; абсолютный путь либо путь относительно config-файла. |
| `maxProbeBytes` | По умолчанию 65 536, максимум 1 MiB. |
| `waitProbeEnabled` | По умолчанию `false`; включает диагностический `wait_probe`. |
| `projects` | Опционально, максимум 50 проектов. |
| `exchange` | Опционально: отсутствует, `{ "enabled": false }` или включённый профиль. |

CLI сервера принимает `--config FILE`. Без него используется `CHATGPT_TUNNEL_MCP_CONFIG`, затем `config/local.json`.

## Project

| Поле | Значение |
| --- | --- |
| `projectId` | Обязательно; уникальные 1–100 символов `[a-z0-9._-]`. |
| `name` | Обязательно, 1–200 символов. |
| `description` | По умолчанию пустая строка, максимум 1 000 символов. |
| `root` | Обязательный абсолютный локальный путь. |
| `readOnly` | Обязательно и только `true`. |
| `excludePaths` | До 200 безопасных относительных путей. |
| `entryDocuments` | До 50 объектов `{ label, path }`; пути относительные. |
| `limits` | Опциональный строгий объект. |

`project.limits`:

| Поле | Default | Допустимый предел |
| --- | ---: | ---: |
| `maxFileBytes` | 1 048 576 | 1 073 741 824 |
| `maxResponseBytes` | 131 072 | 4 096–1 048 576 |
| `maxResults` | 200 | 2 000 |
| `maxDepth` | 8 | 0–20 |
| `searchTimeoutMs` | 5 000 | 30 000 |
| `maxSnippetChars` | 300 | 2 000 |

Аргументы инструментов могут только уменьшить локальный предел проекта.

`maxResponseBytes` ограничивает полный сериализованный MCP-ответ, включая JSON
escaping, оба представления результата и JSON-RPC. Конфиги со старым значением
меньше 4096 нужно обновить. Страница чтения также ограничена 750 строками/
фрагментами. `maxFileBytes` остаётся лимитом исходного файла; для больших логов
его нужно увеличить явно. `searchTimeoutMs` — мягкий бюджет сканирования,
не жёсткий wall-clock timeout первоначального индексирования и обхода каталога.
Контракт продолжений, покрытия и восстановления: [project-read/2](project-read-protocol.md).

## Exchange

| Поле | Значение |
| --- | --- |
| `enabled` | Обязательно `true` для включённого профиля. |
| `storePath` | Абсолютный локальный SQLite path вне project roots. |
| `dispatcherStatePath` | Опциональная read-only проекция dispatcher; отдельный абсолютный path. |
| `principalId` | Обязательно; 1–128 символов `[A-Za-z0-9._-]`. |
| `role` | `planner` или `worker`. |
| `allowedProjectIds` | 1–50 уникальных ID, существующих в `projects`. |
| `limits` | Опциональный строгий объект. |

Planner и worker используют один `storePath`, разные principal/role и подходящие allowlists. Один principal нельзя зарегистрировать с двумя ролями.

| `exchange.limits` | Default | Диапазон / максимум |
| --- | ---: | ---: |
| `maxTaskBytes` | 32 768 | 9 216–32 768 |
| `maxReportBytes` | 65 536 | 1–65 536 |
| `maxReviewBytes` | 8 192 | 1–8 192 |
| `maxResponseBytes` | 131 072 | 65 600–131 072 |
| `defaultListLimit` | 20 | 1–100 |
| `maxListLimit` | 100 | 1–100 |
| `maxTasks` | 10 000 | 1–10 000 |
| `maxHistoryBytes` | 268 435 456 | 1–268 435 456 |
| `busyTimeoutMs` | 5 000 | 0–30 000 |

`defaultListLimit` не может превышать `maxListLimit`. Task/Report/Review считаются по UTF-8 JSON bytes. Для мутаций используются UUID idempotency keys и актуальная revision; точный повтор выполняется с исходным ключом и payload.

`storePath` и `dispatcherStatePath` не могут быть относительными, UNC, находиться внутри project roots, пересекаться друг с другом или проходить через link/reparse point. На Windows оператор самостоятельно ограничивает DACL каталогов баз.

## Dispatcher

| Поле | Значение |
| --- | --- |
| `enabled` | Глобальный opt-in, по умолчанию `false`. |
| `workerConfig` | Обязательный путь к worker config; относительный к dispatcher-файлу либо абсолютный. |
| `statePath` | Обязательный абсолютный локальный SQLite journal path. |
| `codexCommand` | Обязательный путь/команда Codex app-server. |
| `codexArgs` | Массив аргументов, по умолчанию `[]`. |
| `pollIntervalMs` | 1 000–60 000, default 5 000. |
| `turnTimeoutMs` | 1 000–86 400 000, schema default 1 800 000; пример использует 3 600 000. |
| `executor` | Глобальный `model` обязателен; `reasoningEffort` опционален. |
| `projects` | 1–50 project policies. |

Dispatcher требует worker exchange profile. Его `statePath` должен совпадать с worker `dispatcherStatePath`, если тот задан, и быть отделён от exchange/project roots.

### Dispatcher project policy

| Поле | Значение |
| --- | --- |
| `projectId` | Проект из worker profile и его allowlist. |
| `enabled` | Проектный opt-in, default `false`. |
| `allowedPlannerIds` | Непустой allowlist `Task.createdBy`. |
| `allowWholeProject` | Разрешает `scope.wholeProject`, default `false`. |
| `allowedPaths` | До 100 разрешённых относительных scope-префиксов. |
| `executor` | Опциональные `model`, `reasoningEffort`; session здесь не задаётся. |
| `maxSessionTasks` | 1–100, default 5. |
| `permissionMode` | `dispatcher` (default) или `project`. |
| `sandbox` | `read-only` или `workspace-write`, default `workspace-write`. |
| `additionalWritableRoots` | До 20 существующих абсолютных локальных каталогов; только `dispatcher` + `workspace-write`. |
| `codexProject.root` | Обязателен для `permissionMode: project` и должен точно совпадать с worker project root. |

В `project` permission mode dispatcher не передаёт legacy sandbox/writable roots: Codex загружает разрешения проекта по `cwd`. `additionalWritableRoots` в этом режиме запрещён.

### Dispatcher CLI

| Опция | Назначение |
| --- | --- |
| `--config FILE` | Default `config/dispatcher.local.json`. |
| `--help` | Справка. |
| `--status` | Read-only список Runs. |
| `--doctor` | Проверка app-server и моделей. |
| `--once` | Один tick; код 2 при незавершённом/attention Run. |
| `--task UUID` | Ограничить `--once` задачей. |
| `--model`, `--effort` | Overrides ещё не замороженного Run. |
| `--session auto|new|resume|fork` | Выбор сессии; resume/fork требуют `--thread`. |
| `--recover` | С `--once --task` согласовать сохранённый Run без небезопасного повторного исполнения. |

Task может запросить `execution.model`, `reasoningEffort` и `session`. Локальная dispatcher policy остаётся решающей; недопустимый autostart отражается через `attention`, а не создаёт новый Task.

## Workflow CLI

- `validate --binding FILE` — проверить binding.
- `render --binding FILE --role planner|worker --output FILE` — создать инструкции; output не перезаписывается.
- `install --skill NAME [--target DIR] [--update]` — установить или безопасно обновить управляемый skill.

Binding и skills не регистрируют MCP-проекты и не выдают права. Подробности: [reusable-workflow.md](reusable-workflow.md).

## Хранилище и совместимость

SQLite использует WAL, foreign keys, короткие `BEGIN IMMEDIATE`, revision и сохранённые результаты идемпотентности. SchemaVersion 1 не требует миграции при переходе с 0.4.0 на 1.0.0. Backup, старые Task без lifecycle reserve и полный state contract описаны в [stage-3-task-report-exchange.md](stage-3-task-report-exchange.md).
