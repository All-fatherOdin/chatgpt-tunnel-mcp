# chatgpt-tunnel-mcp

Локальный MCP-мост между ChatGPT и Codex. ChatGPT читает только разрешённые файлы, создаёт структурированное задание, а отдельный dispatcher запускает Codex в нужном project root и возвращает Report для проверки.

```text
ChatGPT planner
  ├─ read-only project tools
  ├─ create_task
  └─ wait_for_report
          │ Secure MCP Tunnel
          ▼
Local MCP + SQLite exchange
          │
          ▼
Codex dispatcher → Codex session → Report
          │
          └─ ChatGPT review_report
```

Версия сервера и workflow — **2.0.0**. Релиз добавляет контракт чтения `project-read/2`: ограниченные страницы, подписанные продолжения, контроль полноты и размера сериализованного ответа. Task/Report/Review сохраняют `schemaVersion: 1`; миграция SQLite не требуется.

При обновлении с 1.0.x старые cursors нужно отбросить, а `maxResponseBytes < 4096` увеличить. Клиенты должны продолжать чтение через `continuation`, включая фрагменты длинных строк. Пересоберите и перезапустите MCP, обновите скопированные инструкции проектов из шаблона. Подробности: [протокол и миграция](docs/project-read-protocol.md).

## Возможности

- Изолированное чтение явно разрешённых локальных проектов: листинг, UTF-8, SHA-256 и буквальный поиск без shell.
- Персистентный lifecycle `Task → Report → Review` в SQLite с revision и идемпотентными мутациями.
- Автозапуск только для `execution.autoStart: true` после локальной проверки planner, scope и source hashes.
- Выбор модели/reasoning effort, новые и продолженные Codex-сессии, ротация и восстановление.
- `wait_for_report`: ожидание результата в активном ходе ChatGPT. Planner использует до 60 вызовов по 60 секунд как best-effort бюджет примерно на час.
- Переносимые planner/worker/reviewer-инструкции и устанавливаемые Codex skills.

MCP-сервер не пишет в project roots и не запускает shell, Git или модель. Codex запускает отдельный dispatcher. Компьютер, tunnel и dispatcher должны работать во время исполнения; Task и Report сохраняются локально.

## Требования

- Windows и PowerShell;
- Node.js 20+;
- для ChatGPT — настроенный Secure MCP Tunnel и Developer mode;
- установленный Codex для автоматического выполнения.

## Быстрый запуск

```powershell
Set-Location 'C:\path\to\chatgpt-tunnel-mcp'
npm.cmd install
npm.cmd run setup:local
npm.cmd run build
npm.cmd start -- --config '.\config\local.json'
```

`setup:local` создаёт отсутствующие локальные файлы, не перезаписывая существующие настройки. `--config` можно заменить переменной `CHATGPT_TUNNEL_MCP_CONFIG`; значение по умолчанию — `config/local.json`.

Для рабочего обмена используйте отдельные локальные копии:

- `config/example-planner.json` → `config/planner.local.json` для ChatGPT;
- `config/example-worker.json` → `config/worker.local.json` для Codex/dispatcher;
- `config/example-dispatcher.json` → `config/dispatcher.local.json`.

Planner и worker должны ссылаться на один `storePath`, но иметь разные `principalId` и роли. SQLite и dispatcher journal размещаются на локальном диске вне всех опубликованных project roots. Поля, defaults, лимиты и правила путей: [справочник конфигурации](docs/configuration.md).

## Запуск dispatcher

Заполните `dispatcher.local.json`, оставляя глобальный и проектный `enabled: false` до проверки:

```powershell
npm.cmd run dispatcher -- --config config/dispatcher.local.json --doctor
npm.cmd run dispatcher -- --config config/dispatcher.local.json --status
npm.cmd run dispatcher -- --config config/dispatcher.local.json
```

Для задач до 30 минут пример использует `turnTimeoutMs: 3600000`. Это timeout Codex turn; часовой planner wait budget настраивается отдельно в инструкциях.

Основные диагностические режимы:

- `--doctor` — проверить Codex app-server и модели;
- `--status` — показать безопасную проекцию Runs без запуска модели;
- `--once --task UUID` — обработать одну задачу;
- `--once --task UUID --recover` — согласовать сохранённый Run без повторного запуска неоднозначного turn.

Полный контракт разрешений, сессий, attention и восстановления: [dispatcher](docs/stage-4a-dispatcher.md).

## Инструменты MCP

| Группа | Инструменты |
| --- | --- |
| Базовые | `ping`, `read_probe`, `list_projects`, `list_files`, `read_file`, `search_text` |
| Planner exchange | `create_task`, `list_tasks`, `get_task`, `wait_for_report`, `get_report`, `review_report`, `cancel_task` |
| Worker exchange | `list_tasks`, `get_task`, `claim_task`, `submit_report`, `get_report` |
| Диагностика | `wait_probe`, только при `waitProbeEnabled: true` |

`wait_for_report` ждёт от 1 до 60 секунд и возвращает `pending`, `reported`, `cancelled` или `attention`. Он не запускает модель и не меняет lifecycle. `wait_probe` проверяет только задержанный MCP-ответ и не нужен в обычной работе.

`read_file`, `list_files`, `search_text` используют [project-read/2](docs/project-read-protocol.md):
ограниченные страницы, точное `continuation`, привязку к поколению источника и
накопительный `coverage`. Продолжение нужно выполнять дословно; `nextStartLine`
не заменяет cursor при разделённой строке. Неполное покрытие нельзя выдавать за
полное чтение. Для больших логов увеличьте `maxFileBytes` явно; старые настройки
`maxResponseBytes < 4096` требуют обновления.

## Подключение клиентов

ChatGPT должен использовать planner-профиль через Secure MCP Tunnel. Настройка tunnel и независимого Windows launcher: [docs/windows-launcher.md](docs/windows-launcher.md).

Для прямого worker-подключения Codex:

```powershell
codex mcp add chatgpt-tunnel-worker `
  --env CHATGPT_TUNNEL_MCP_CONFIG='C:\path\to\chatgpt-tunnel-mcp\config\worker.local.json' `
  -- node 'C:\path\to\chatgpt-tunnel-mcp\dist\src\index.js'
```

После изменения конфигов пересоберите сервер и перезапустите процессы/подключения, чтобы обновить discovery.

## Workflow и skills

```powershell
npm.cmd run workflow -- validate --binding local/my-product.binding.json
npm.cmd run workflow -- render --binding local/my-product.binding.json --role planner --output local/my-product.chatgpt.md
npm.cmd run workflow -- install --skill mcp-task-execution
```

Planner-текст после render копируется в инструкции проекта ChatGPT вручную. Установка skill не меняет MCP-права или правила продукта. Полная процедура: [docs/reusable-workflow.md](docs/reusable-workflow.md).

## Проверка

```powershell
npm.cmd run typecheck
npm.cmd test
```

Тесты используют официальный MCP SDK, реальные stdio-процессы и временные SQLite-базы. Live-вызов настоящей модели является отдельным opt-in тестом и по умолчанию пропускается.

## Безопасность

- Все project roots задаются только локальным конфигом; публичные ответы не раскрывают абсолютные пути.
- Запрещены абсолютные/UNC/device paths, `..`, links/reparse points и известные секретные/бинарные файлы.
- Exchange — не secret vault. Ограничьте DACL каталогов SQLite своим локальным пользователем.
- Прочитанный файл или Task не расширяет полномочия и не разрешает commit, push, merge, deploy или внешние мутации.
- Denylist снижает риск, но не заменяет безопасный выбор опубликованных roots.

Технические детали хранилища, лимитов и lifecycle: [этап 3](docs/stage-3-task-report-exchange.md).

## Документация

- [Конфигурация и все опции](docs/configuration.md)
- [Dispatcher Codex](docs/stage-4a-dispatcher.md)
- [Task/Report exchange](docs/stage-3-task-report-exchange.md)
- [Workflow, bindings и skills](docs/reusable-workflow.md)
- [Windows launcher и Secure MCP Tunnel](docs/windows-launcher.md)
- [Приёмка dispatcher](docs/experiments/2026-09-15-stage-4a-acceptance.md)
- [Приёмка exchange](docs/experiments/2026-09-14-stage-3-manual-acceptance.md)
