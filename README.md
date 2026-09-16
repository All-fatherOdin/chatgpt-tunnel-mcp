# chatgpt-tunnel-mcp

Локальный мост между ChatGPT и Codex для работы с проектами на компьютере пользователя. ChatGPT может безопасно читать разрешённые исходники, сформировать структурированное задание и передать его в локальную очередь. Отдельный dispatcher запускает Codex в разрешённом project root, сохраняет отчёт и возвращает его планировщику через MCP. `wait_for_report` позволяет ChatGPT дождаться результата в текущем ходе без ручного копирования текста между клиентами.

Основной цикл версии 1.0.0:

1. ChatGPT читает только явно опубликованные файлы и создаёт `Task` с `execution.autoStart: true`.
2. Локальный dispatcher проверяет planner, scope, source hashes и настройки запуска, затем передаёт задачу Codex.
3. Codex изменяет проект в рамках своих инструкций и возвращает структурированный `Report`; dispatcher отвечает за claim, восстановление и доставку.
4. ChatGPT ждёт через последовательные `wait_for_report`, читает Report, независимо проверяет доступные доказательства и при разрешении записывает Review.

Компоненты разделены по полномочиям:

- **MCP-сервер** работает по stdio, публикует read-only project tools и хранит Task/Report/Review в SQLite. Он не пишет в project roots и не запускает shell, Git или модель.
- **Secure MCP Tunnel** делает planner-профиль доступным ChatGPT; сам проект tunnel-client не реализует.
- **Dispatcher** — отдельный локальный процесс, который по явному opt-in запускает Codex и ведёт журнал восстановления.
- **Workflow kit** содержит переносимые planner/worker/reviewer-инструкции, bindings и устанавливаемые Codex skills.

Проект рассчитан на локальную работу: выключенный компьютер или остановленный tunnel/dispatcher не обязаны обеспечивать непрерывную доступность. Task и Report при этом сохраняются в локальной базе. Scheduled heartbeat не требуется для основного сценария; ожидание выполняется через `wait_for_report` в активном ходе ChatGPT.

Подробности: [dispatcher 4A](docs/stage-4a-dispatcher.md), [обмен Task/Report](docs/stage-3-task-report-exchange.md), [workflow kit](docs/reusable-workflow.md), [Windows launcher](docs/windows-launcher.md), [результаты ручной приёмки](docs/experiments/2026-09-15-stage-4a-acceptance.md).

## Возможности и ограничения

- До 50 разрешённых локальных проектов с отдельными roots, entry documents, исключениями и лимитами.
- Листинг, чтение UTF-8 файлов, SHA-256 и буквальный поиск без shell.
- Персистентная очередь Task → Report → Review с revision и идемпотентными мутациями.
- Автозапуск только для `execution.autoStart: true` и только после локальных allowlist-проверок.
- Выбор модели/reasoning effort, новая/resume/fork-сессия, ротация и восстановление после неоднозначных ответов.
- Ограниченное ожидание Report: один вызов 1–60 секунд; planner-инструкции используют до 60 последовательных вызовов как best-effort бюджет примерно на час.
- Сервер не является secret vault, CI-системой, удалённым агентом или службой непрерывной доступности.

## Требования и запуск

- Windows, PowerShell и Node.js 20+;
- для ChatGPT — существующий Secure MCP Tunnel и Developer mode.

```powershell
Set-Location 'C:\path\to\chatgpt-tunnel-mcp'
npm.cmd install
npm.cmd run setup:local
npm.cmd run build
npm.cmd start -- --config '.\config\local.json'
```

`--config` можно заменить переменной `CHATGPT_TUNNEL_MCP_CONFIG`; без обоих используется `config/local.json`. Сервер пишет протокольные ответы в stdout, а диагностику — только в stderr.

`setup:local` создаёт отсутствующие локальные файлы и не перезаписывает существующие `deviceId`, `probeFile`, probe-содержимое или пользовательские настройки. Чтобы одноразово добавить `agent-memory-kit`, задайте локальную переменную `CHATGPT_TUNNEL_AGENT_MEMORY_KIT_ROOT` с абсолютным путём перед запуском; значение не записывается в Git. Если root отсутствует, сервер не создаёт замену: обращения к проекту вернут безопасную ошибку `NOT_FOUND`.

## Конфигурация проектов

Абсолютные roots и настройки устройства находятся только в исключённом из Git `config/local.json`. Переносимый образец — `config/example.json`. Старый конфиг без `projects` допустим: `ping` и `read_probe` продолжают работать, а `list_projects` возвращает пустой список.

Все объекты конфигурации строгие: неизвестное поле считается ошибкой запуска.

| Поле верхнего уровня | Обязательность / значение |
| --- | --- |
| `deviceId` | Обязательно; непрозрачный несекретный ID, 8–128 символов `[A-Za-z0-9._-]`. |
| `probeFile` | Обязательно; абсолютный путь либо путь относительно файла конфигурации. |
| `maxProbeBytes` | Опционально, по умолчанию 65 536, максимум 1 MiB. |
| `waitProbeEnabled` | Опционально, по умолчанию `false`; включает только диагностический `wait_probe`, не нужен для `wait_for_report`. |
| `projects` | Опционально, максимум 50 проектов; без него доступны только compatibility tools. |
| `exchange` | Опционально: отсутствует, `{ "enabled": false }` либо включённый planner/worker-профиль. |

Каждый проект содержит стабильный `projectId`, отображаемые `name` и `description`, абсолютный `root`, обязательный `readOnly: true`, дополнительные `excludePaths`, навигационные `entryDocuments` и лимиты. Ссылки на README, AGENTS.md, operating contract и другие документы не делают их автоматически действующими правилами.

| Поле проекта | Обязательность / значение |
| --- | --- |
| `projectId` | Обязательно; 1–100 символов `[a-z0-9._-]`, уникально в профиле. |
| `name` | Обязательно, 1–200 символов. |
| `description` | Опционально, до 1 000 символов. |
| `root` | Обязательный абсолютный локальный путь. |
| `readOnly` | Обязательно и только `true`: MCP никогда не пишет в root. |
| `excludePaths` | Опционально, до 200 безопасных относительных путей. |
| `entryDocuments` | Опционально, до 50 объектов `{ label, path }`; пути относительные. |
| `limits` | Опциональный строгий объект лимитов ниже. |

Поля `project.limits` имеют указанные defaults и не могут превышать серверные потолки:

- `maxFileBytes`: 1 MiB, максимум 4 MiB;
- `maxResponseBytes`: 128 KiB, максимум 1 MiB;
- `maxResults`: 200, максимум 2 000;
- `maxDepth`: 8, диапазон 0–20;
- `searchTimeoutMs`: 5 000, максимум 30 000;
- `maxSnippetChars`: 300, максимум 2 000.

Аргументы инструмента могут только уменьшить настроенный предел.

## Инструменты

- `ping` и `read_probe` сохранены для совместимости первого этапа.
- `list_projects` возвращает ID, названия, описания и относительные входные документы без абсолютных путей.
- `list_files` принимает проект, относительный каталог, глубину, лимит и cursor. Порядок детерминирован; `nextCursor` продолжает страницу. При конкурентном изменении дерева cursor является смещением в новом снимке, поэтому строгая snapshot-консистентность не гарантируется.
- `read_file` каждый раз читает актуальный UTF-8 файл. Возвращает относительный путь, `content`, массив строк с номерами, фактический диапазон, время, SHA-256 и продолжение. SHA-256 относится ко всей последовательности байтов файла на момент чтения — до декодирования и выбора строк. При усечении используйте `nextStartLine`.
- `search_text` выполняет встроенный буквальный поиск Node.js, включая кириллицу и специальные символы. Shell и внешние программы не запускаются. Возвращаются путь, номер строки и ограниченный фрагмент; причины неполноты выдаются отдельно.
- `wait_probe` появляется только при `waitProbeEnabled: true`: ждёт 1–600 секунд и возвращает тайминги с несекретным marker. Это диагностика outstanding MCP request, а не ожидание Report и не пробуждение завершённого разговора.

У базовых инструментов строгие входные схемы, структурированные результаты и `readOnlyHint: true`. Диагностика идёт в stderr. Содержимое файлов, запросы поиска, секреты и абсолютные project roots не логируются. Неожиданные ошибки заменяются общей формулировкой.

## Обмен заданиями и отчётами

Блок `exchange` опционален. Если его нет или задано `{ "enabled": false }`, база не создаётся и не открывается, а discovery остаётся прежним: только шесть инструментов 0.2. Переносимые образцы — [planner](config/example-planner.json) и [worker](config/example-worker.json); скопируйте их в исключённые из Git локальные файлы и замените пути/ID вручную. Оба профиля должны указывать один `storePath`, расположенный на локальном диске вне всех опубликованных roots.

Planner регистрирует `create_task`, `list_tasks`, `get_task`, `wait_for_report`, `get_report`, `review_report`, `cancel_task`. Worker регистрирует `list_tasks`, `get_task`, `claim_task`, `submit_report`, `get_report`. Роль, `principalId`, путь базы и allowlist берутся только из локального конфига; клиент не может передать или подменить автора. Один `principalId` нельзя зарегистрировать в общей базе с двумя ролями.

`wait_for_report` принимает `projectId`, `taskId` и `timeoutSeconds` от 1 до 60 (по умолчанию 60). Он возвращает `pending`, `reported`, `cancelled` или `attention`, не запускает модель и не меняет lifecycle. Рекомендуемый planner-бюджет — до 60 последовательных вызовов; ошибка не повторяется автоматически, а завершение ожидания не отменяет Task.

Поля включённого `exchange`:

| Поле | Обязательность / значение |
| --- | --- |
| `enabled` | Обязательно `true`. |
| `storePath` | Обязательный абсолютный локальный путь к SQLite вне project roots. |
| `dispatcherStatePath` | Опциональный абсолютный путь к read-only проекции dispatcher; должен совпадать со `statePath` dispatcher и не пересекаться с базой/roots. |
| `principalId` | Обязательно; стабильный ID planner или worker, 1–128 символов `[A-Za-z0-9._-]`. |
| `role` | Обязательно: `planner` или `worker`. |
| `allowedProjectIds` | Обязательно, 1–50 уникальных ID из `projects`. |
| `limits` | Опциональный строгий объект лимитов. |

Поля `exchange.limits` и значения по умолчанию: `maxTaskBytes` 32 768 (минимум 9 216), `maxReportBytes` 65 536, `maxReviewBytes` 8 192, `maxResponseBytes` 131 072 (минимум 65 600), `defaultListLimit` 20, `maxListLimit` 100, `maxTasks` 10 000, `maxHistoryBytes` 268 435 456 и `busyTimeoutMs` 5 000 (0–30 000). `defaultListLimit` не может превышать `maxListLimit`.

SQLite-драйвер — `better-sqlite3` 12.2.0. Используются WAL, foreign keys, ограниченный `busy_timeout`, `BEGIN IMMEDIATE`, условное обновление revision, уникальные связи и одна транзакция для состояния, события и результата идемпотентности. Успешный повтор ключа `(principalId, tool, idempotencyKey)` возвращает исходный результат, в том числе после перезапуска; другой payload возвращает `IDEMPOTENCY_CONFLICT`.

Перед первым запуском создайте каталог базы под своим профилем Windows и ограничьте DACL локальным пользователем. Сервер намеренно не запускает `icacls` или другие внешние команды. Пример выполняется оператором с подстановкой своего пути и имени пользователя:

```powershell
$exchangeDirectory = Join-Path $env:LOCALAPPDATA 'chatgpt-tunnel-mcp'
New-Item -ItemType Directory -Force -Path $exchangeDirectory | Out-Null
icacls.exe $exchangeDirectory /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
```

Код при старте дополнительно отклоняет относительный/UNC `storePath`, пересечение с любым project root, каталог через symlink/junction/reparse point, не-файл на месте базы и неизвестную версию схемы. Синхронизируемые и сетевые каталоги не поддерживаются. На Windows точная DACL не проверяется переносимым Node API, поэтому её корректность остаётся явной обязанностью оператора.

Жёсткие потолки не изменились: Task 32 KiB, Report 64 KiB, Review 8 KiB, ответ 128 KiB, 100 элементов в массиве, 100 карточек на страницу, 10 000 заданий и 256 MiB логической истории. Минимально допустимые настройки включённого профиля: `maxTaskBytes: 9216` и `maxResponseBytes: 65600`.

`maxTaskBytes` — локальный admission-лимит planner для нового Task, но он проверяет не только queued JSON: `create_task` заранее резервирует место до своего лимита под весь допустимый lifecycle, включая `claimedBy` длиной до 128 ASCII-символов, `claimedAt`, revision, самое длинное состояние и причину отмены. После commit переходы не переоценивают Task по меньшему `maxTaskBytes` другого подключения, а проверяют неизменяемый общий потолок 32 768 байт. Поэтому planner и worker могут иметь разные локальные write-лимиты; worker с меньшим `maxTaskBytes` может принять корректно зарезервированное задание. `maxReportBytes` и `maxReviewBytes` аналогично являются admission-лимитами создателя соответствующей сущности.

Каждый профиль обязан иметь `maxResponseBytes >= 65600`. Этот минимум рассчитан по общим потолкам и включает JSON-обёртки: `{ "report": ... }` для `get_report` и Task вместе с `reportId`/Review для `get_task`. Благодаря этому объект, записанный любым совместимым профилем, читается другим профилем независимо от различий их write-лимитов. Лимит ответа относится к UTF-8-размеру сериализованного `structuredContent`, а не только вложенной сущности.

Причина отмены сначала проходит строковую схему максимум 8 000 JavaScript UTF-16 code units, затем отдельный предел: максимум 8 002 UTF-8-байта у `JSON.stringify(reason)`, включая две кавычки и экранирование. Поэтому 8 000 ASCII-символов, 4 000 кириллических символов или 4 000 переводов строки проходят; 4 001 кириллический символ или 4 001 `\n` дают 8 004 байта и отклоняются. Управляющий символ вроде NUL сериализуется как шестибайтовая последовательность `\u0000`. Это не подсчёт пользовательских графем: emoji может занимать две UTF-16 code units и четыре UTF-8-байта.

Мутации возвращают безопасный JSON с `code`, `message`, `correlationId`, `retryable`; содержимое сущностей, ключи идемпотентности, SQL и абсолютные пути не логируются.

При ошибках строгой входной схемы "INVALID_INPUT" сообщение содержит до пяти путей полей и требований, например "idempotencyKey: must be a UUID" или "sourceRefs[0].sha256: must contain exactly 64 hexadecimal characters". Неверные значения и имена неизвестных полей не отражаются в ответе; неизвестные поля обозначаются на уровне содержащего объекта. Все idempotencyKey должны быть UUID; при повторе сохраняются ключ и весь исходный запрос. Ошибки бизнес-правил по-прежнему возвращают отдельные пояснения.

База содержит пользовательский текст и не является secret vault. Остановите оба подключения перед административным backup/restore. Версия 0.3.0 создаёт только схему v1; автоматического удаления и разрушительных миграций нет.

### Старые Task без lifecycle-резерва

Task, созданный предыдущей сборкой ровно на границе 32 768 байт, остаётся читаемым, но может не вместить `claimedBy`/`claimedAt` или `cancelReason`. Сервер не обрезает и не переписывает его: небезопасный `claim_task`/`cancel_task` возвращает `INVALID_STATE`, а state, revision, entity JSON, события и idempotency-ключ не меняются. Это не исправленная совместимость старой записи — исходный Task нельзя перевести в терминальное состояние в рамках неизменяемого контракта и прежнего потолка.

Безопасная локальная процедура восстановления работы:

1. Остановить оба stdio-подключения planner и worker и убедиться, что процессы завершены.
2. Из корня этого проекта создать согласованную резервную копию через API SQLite, не копируя открытую WAL-базу обычным `Copy-Item`:

   ```powershell
   $sourceStore = 'C:\path\outside\project-roots\exchange.sqlite'
   $backupStore = "$sourceStore.pre-lifecycle-reserve-$(Get-Date -Format yyyyMMddHHmmss).bak"
   node --input-type=module -e "import Database from 'better-sqlite3'; const [src,dst]=process.argv.slice(1); const db=new Database(src,{readonly:true}); await db.backup(dst); db.close();" $sourceStore $backupStore
   ```

3. Запустить только planner, прочитать исходный Task через `get_task` и сохранить его taskId. Не редактировать строку SQLite вручную.
4. Создать новый уменьшенный Task через `create_task`, указав старый taskId как `parentTaskId`; новый Task должен пройти lifecycle-reservation. Затем запустить worker и продолжить новый цикл.
5. Исходный Task останется `queued` как неизменяемая историческая запись. Если это неприемлемо для активной очереди, после резервной копии можно вручную переключить оба локальных профиля на новый пустой `storePath`, понимая, что старая история останется доступна только в сохранённой базе.

## Dispatcher Codex

Dispatcher использует worker-профиль MCP, но запускается отдельным процессом. Скопируйте `config/example-dispatcher.json` в игнорируемый `config/dispatcher.local.json`, заполните абсолютные пути, сначала выполните doctor, затем включите глобальный и проектный `enabled`.

```powershell
npm.cmd run build
npm.cmd run dispatcher -- --config config/dispatcher.local.json --doctor
npm.cmd run dispatcher -- --config config/dispatcher.local.json
```

Поля dispatcher-конфига:

| Поле | Обязательность / значение |
| --- | --- |
| `enabled` | Глобальный opt-in, по умолчанию `false`. |
| `workerConfig` | Обязательный путь к worker MCP config, относительно dispatcher-файла либо абсолютный. |
| `statePath` | Обязательный абсолютный локальный путь к отдельной SQLite-базе журнала. |
| `codexCommand` | Обязательный путь/команда Codex app-server. |
| `codexArgs` | Опциональный массив дополнительных аргументов, по умолчанию `[]`. |
| `pollIntervalMs` | Интервал polling 1 000–60 000 мс, по умолчанию 5 000. |
| `turnTimeoutMs` | Timeout одного Codex turn 1 000–86 400 000 мс; schema default 1 800 000 (30 минут), переносимый пример и текущая локальная настройка используют `3600000` (1 час). Это отдельно от planner wait budget. |
| `executor` | Обязательные глобальные `model` и опциональный `reasoningEffort`; fallback для проектов и Task. |
| `projects` | Обязательно, 1–50 строгих project policies. |

Поля элемента `projects` dispatcher:

| Поле | Обязательность / значение |
| --- | --- |
| `projectId` | Обязательно; должен существовать в worker profile и его exchange allowlist. |
| `enabled` | Проектный opt-in, по умолчанию `false`. |
| `allowedPlannerIds` | Обязательный непустой allowlist `Task.createdBy`. |
| `allowWholeProject` | Разрешает `scope.wholeProject`, по умолчанию `false`. |
| `allowedPaths` | Разрешённые относительные scope-префиксы, максимум 100. |
| `executor` | Опциональные project overrides: `model`, `reasoningEffort`; `session` здесь не задаётся. |
| `maxSessionTasks` | 1–100, по умолчанию 5; после лимита создаётся новая сессия с handoff. |
| `permissionMode` | `dispatcher` (по умолчанию) или `project`. |
| `sandbox` | Для режима `dispatcher`: `read-only` или `workspace-write`, по умолчанию `workspace-write`. |
| `additionalWritableRoots` | До 20 существующих абсолютных локальных каталогов; только `dispatcher` + `workspace-write`. |
| `codexProject.root` | Для режима `project`: обязательный существующий root, точно совпадающий с root worker-проекта. Codex загружает project permissions по `cwd`. |

Task может переопределить `execution.model`, `execution.reasoningEffort` и `execution.session`: `auto`, `new`, `resume`/`fork` с `threadId`. Прямые CLI overrides ниже допустимы только с `--once --task`; уже замороженные настройки Run не меняются.

| Команда | Назначение |
| --- | --- |
| `--help` | Краткая справка. |
| `--config FILE` | Dispatcher-конфиг; по умолчанию `config/dispatcher.local.json`. |
| `--status` | Без запуска модели вывести безопасную проекцию Runs. |
| `--doctor` | Запустить Codex app-server и получить доступные модели. |
| `--once` | Выполнить один polling tick и завершиться; код 2 означает незавершённый/attention Run. |
| `--task UUID` | Ограничить `--once` одной задачей. |
| `--model`, `--effort` | Одноразовые overrides для выбранной ещё не замороженной задачи. |
| `--session auto\|new\|resume\|fork` | Одноразовый выбор сессии; `resume`/`fork` требуют `--thread`. |
| `--recover` | С `--once --task` согласовать сохранённый Run; неоднозначный turn повторно не запускается. |

Полный контракт допуска, attention-коды, восстановление, выбор сессии и журнал: [docs/stage-4a-dispatcher.md](docs/stage-4a-dispatcher.md).

## Workflow-инструкции и skills

CLI `npm.cmd run workflow -- ...` обслуживает переносимые роли и не меняет MCP-права:

```powershell
npm.cmd run workflow -- validate --binding local/my-product.binding.json
npm.cmd run workflow -- render --binding local/my-product.binding.json --role planner --output local/my-product.chatgpt.md
npm.cmd run workflow -- install --skill mcp-task-execution
npm.cmd run workflow -- install --skill mcp-task-planning --update
```

- `validate` требует `--binding` и проверяет JSON binding.
- `render` требует `--binding`, `--role planner|worker` и новый `--output`; существующий файл не перезаписывается.
- `install` требует `--skill`; `--target` меняет каталог skills, `--update` обновляет только неизменённую управляемую установку с backup.

После render planner-текст нужно скопировать в инструкции проекта ChatGPT вручную; CLI не изменяет облачные настройки. После install перезапустите/откройте новую сессию Codex для discovery. Полная процедура и схема binding: [docs/reusable-workflow.md](docs/reusable-workflow.md).

## Граница доступа и исключения

Проверяются `projectId` и каждый компонент пути. Запрещены абсолютные, UNC и device paths, `..`, двоеточие (включая Windows alternate data streams), NUL, выход после canonical resolution и переход по symlink/junction/reparse point. Ссылки пропускаются в обходе и отклоняются при прямом чтении. Проверка выполняется перед открытием; конкурентная замена компонента между проверкой и чтением остаётся известным TOCTOU-ограничением версии 0.2.

Одна политика действует для листинга, чтения и поиска. По умолчанию исключены:

- `.git`, `node_modules`, `dist`, `build`, `out`, `target`, `.next`, `.cache`, `coverage`, `vendor`;
- `.env*`, типовые `secrets`/`credentials`/service-account файлы, `id_rsa`, `id_ed25519`;
- приватные ключи и keystore;
- локальные базы, архивы, исполняемые и типовые бинарные/медиа/office-файлы;
- настроенные относительные префиксы `excludePaths`.

Это denylist известных рисков, а не автоматическое обнаружение всех секретов. Не добавляйте в разрешённый root материалы, которые сервер вообще не должен видеть.

## Проверка

```powershell
npm.cmd run typecheck
npm.cmd test
```

Тесты используют настоящий MCP-клиент официального TypeScript SDK, реальные stdio-процессы и временные fixtures/SQLite-базы. Текущий набор проверяет project reading, lifecycle exchange, `wait_for_report`, dispatcher, восстановление и workflow kit. Live-вызов настоящей модели является отдельным opt-in тестом и по умолчанию пропускается.

## Перезапуск существующего Secure MCP Tunnel

Сначала пересоберите сервер. В пользовательском терминале с работающим `tunnel-client run` нажмите `Ctrl+C`; не завершайте процессы вслепую. Используйте уже созданный профиль `chatgpt-tunnel-probe` и фактический путь к `tunnel-client.exe`. Если профиль нужно обновить, повторите `init` с существующим tunnel ID и путями с прямыми слешами:

```powershell
npm.cmd run build
$env:CONTROL_PLANE_API_KEY = Read-Host 'Runtime API key' -AsSecureString | ConvertFrom-SecureString -AsPlainText
& 'C:\actual\path\tunnel-client.exe' init --sample sample_mcp_stdio_local --profile chatgpt-tunnel-probe --tunnel-id 'tunnel_REPLACE_ME' --mcp-command 'node "C:/path/to/chatgpt-tunnel-mcp/dist/src/index.js" --config "C:/path/to/chatgpt-tunnel-mcp/config/planner.local.json"'
& 'C:\actual\path\tunnel-client.exe' doctor --profile chatgpt-tunnel-probe --explain
& 'C:\actual\path\tunnel-client.exe' run --profile chatgpt-tunnel-probe
```

Ключ вводится только скрыто локально; не помещайте его в чат, Git, командную строку или логи. После остановки: `Remove-Item Env:CONTROL_PLANE_API_KEY`.

Укажите в tunnel-команде отдельный локальный planner-конфиг. В ChatGPT откройте настройки существующего подключения, обновите discovery/инструменты; при необходимости обновите страницу и начните новый разговор. При включённом exchange должны появиться шесть базовых инструментов чтения и семь planner-инструментов обмена, включая `wait_for_report`. Диагностический `wait_probe` появляется дополнительно только при `waitProbeEnabled: true`.

Для прямого Codex-подключения сначала сохраните список, затем добавьте только одну запись:

```powershell
codex mcp list
codex mcp add chatgpt-tunnel-worker --env CHATGPT_TUNNEL_MCP_CONFIG='C:\path\to\chatgpt-tunnel-mcp\config\worker.local.json' -- node 'C:\path\to\chatgpt-tunnel-mcp\dist\src\index.js'
codex mcp list
```

Команда не должна заменять существующий `config.toml`. Перезапустите Codex и проверьте сервер через `/mcp`.

## Ручная приёмка этапа 2

В обычном ChatGPT с подключённым инструментом выполните последовательно:

1. `Вызови list_projects и найди project_id agent-memory-kit. Покажи только публичные поля и входные документы.`
2. `Используя entryDocuments проекта agent-memory-kit, вызови read_file для README.md. Покажи путь, диапазон строк и SHA-256.`
3. `Вызови search_text и найди документы о ролях ChatGPT и Codex. Затем прочитай только релевантные диапазоны строк через read_file.`
4. `Изучи правила распределения ролей и подготовки заданий. Предложи контракт взаимодействия ChatGPT и Codex. Ссылайся на конкретные файлы и строки. Отдели существующие правила от предлагаемых изменений. Не изменяй файлы и не утверждай, что шаблоны Kit уже приняты продуктом.`

Повторите вызовы инструментов чтения напрямую в Codex. Автотест не заменяет эти две ручные проверки. Расход лимитов остаётся отдельной гипотезой.

## Протокол ручной приёмки этапа 3

Используйте временный безвредный проект, явно добавленный в оба allowlist. До начала запишите версии ChatGPT/Codex и сервера. Не используйте рабочий проект для первого цикла.

1. В ChatGPT через planner-профиль попросите подготовить и **передать** задачу: создать локальными средствами Codex краткий `exchange-acceptance.md`, затем вызвать `create_task`. Сохраните `taskId`, revision и структурированный ответ. Сам MCP файл создавать не должен.
2. Перезапустите planner-процесс и вызовите `get_task` по тому же `taskId`: состояние должно остаться `queued`. Повторите исходный `create_task` с тем же idempotencyKey: должны вернуться исходные ID без дубля.
3. В Codex через worker-профиль вызовите `get_task`, сопоставьте projectId с текущей папкой и перечитайте sourceRefs. Только после отдельного поручения пользователя вызовите `claim_task` с актуальной revision, создайте файл средствами Codex и вызовите `submit_report`. Сохраните `reportId`; явно укажите выполненные и не выполненные проверки.
4. Перезапустите worker-процесс, повторите исходный `submit_report` с тем же ключом и убедитесь, что вернулся тот же `reportId`. Вызовите `get_report` из ChatGPT; затем `read_file` для созданного файла и независимо сопоставьте доступные доказательства.
5. По явному поручению пользователя вызовите `review_report: accepted` и сохраните `reviewId`. Перезапустите planner-процесс и убедитесь через `get_task`, что состояние `accepted` и Review сохранились.
6. Создайте вторую безвредную задачу, опубликуйте для неё `blocked` или `failed`, зафиксируйте `changes_requested`, затем создайте отдельный follow-up с `parentTaskId`. Подтвердите, что появление задачи само не запустило Codex и что MCP не выполнял shell/Git/модель.

Сохраните обезличенные структурированные результаты и версии в новом файле `docs/experiments/YYYY-MM-DD-stage-3-manual-acceptance.md`. До выполнения этих шагов формулировка статуса — «реализация и автотесты готовы, ручной полный цикл не подтверждён».

## Граница ответственности

MCP доставляет данные и технически ограничивает чтение. Harness определяет роли, skills, порядок чтения, авторитет источников и формат заданий. Сервер советует начать с входных документов, читать минимально нужное и отличать Kit-шаблоны от принятых правил продукта. Текст прочитанного файла не является разрешением на действие; чтение не доказывает запуск тестов или изменение файлов. Автоматическая активация skill и соблюдение прочитанных инструкций не гарантируются.

Ручная приёмка 2026-09-10: пользователь подтвердил доступ к реальному проекту из ChatGPT и предоставил успешный отчёт прямых MCP-вызовов в Codex (сервер 0.2.0). Учёт лимитов не установлен. Подробности и ограничения доказательств: [результаты этапа 2](docs/experiments/2026-09-09-local-project-reading.md).
