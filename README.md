# chatgpt-tunnel-mcp

Минимальный read-only MCP-сервер для первого эксперимента с подключением обычного ChatGPT к локальному процессу через OpenAI Secure MCP Tunnel.

Сервер предоставляет только два инструмента:

- `ping` — UTC-время, версия сервера и непрозрачный идентификатор устройства;
- `read_probe` — актуальное содержимое одного локально настроенного UTF-8 файла, SHA-256 его байтов и UTC-время чтения.

Модель не может передать путь. Сервер не читает каталоги, не пишет файлы, не запускает shell или модели. Успешный локальный либо Codex-тест не доказывает работу из обычного ChatGPT и ничего не доказывает о расходовании лимитов.

## Требования

- Windows и PowerShell;
- Node.js 20 или новее (`node --version`);
- для удалённой проверки — доступ аккаунта к Secure MCP Tunnel и Developer mode.

## Установка и локальная настройка

```powershell
Set-Location 'C:\path\to\chatgpt-tunnel-mcp'
npm install
npm run setup:local
npm run build
```

`setup:local` создаёт исключённые из Git файлы `config/local.json` и `local/probe.txt`. Идентификатор устройства — случайный UUID с префиксом `device-`; hostname и имя пользователя не используются. Существующие локальные файлы скрипт не перезаписывает.

Формат конфигурации показан в `config/example.json`:

```json
{
  "deviceId": "device-example-change-me",
  "probeFile": "../local/probe.txt",
  "maxProbeBytes": 65536
}
```

Относительный `probeFile` разрешается от каталога файла конфигурации. Допустимый лимит — от 1 байта до 1 MiB. Конфигурация читается и проверяется при старте; probe-файл читается заново при каждом вызове.

Запуск вручную (процесс ожидает MCP JSON-RPC в stdin):

```powershell
npm start -- --config '.\config\local.json'
```

Диагностика и JSON-журнал вызовов идут только в stderr. В журнале есть UTC-время, инструмент, локальный correlation ID, длительность, результат и безопасный код ошибки; содержимое probe, пути, токены и секреты не логируются. Остановка — `Ctrl+C`.

## Локальная проверка

Автоматическая проверка использует настоящий клиент из официального MCP TypeScript SDK и запускает сервер по stdio:

```powershell
npm test
```

Она проверяет discovery, схемы и read-only-аннотации, `ping`, повторное чтение после изменения файла, SHA-256, отсутствие файла, превышение лимита и отклонение произвольного аргумента `path` до вызова обработчика.

Интерактивная проверка через MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector@latest node '.\dist\src\index.js' --config '.\config\local.json'
```

В открывшемся Inspector нажмите **Connect**, затем на вкладке **Tools** вызовите `ping` и `read_probe`. Измените контрольную строку и вызовите `read_probe` ещё раз:

```powershell
Set-Content -LiteralPath '.\local\probe.txt' -Value "probe-$([guid]::NewGuid())" -Encoding utf8
```

## Secure MCP Tunnel

Используется официальный `tunnel-client`; собственный туннель в проекте отсутствует. Актуальная документация подтверждает поддержку локальной stdio-команды. Бинарник для Windows следует брать со страницы [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) либо из [официальных релизов](https://github.com/openai/tunnel-client/releases/latest), а не по зафиксированной в README версии.

Действия в аккаунте:

1. В Platform создайте/выберите tunnel и получите `tunnel_id`.
2. Создайте отдельный runtime API key с правами **Tunnels Read + Use**. Это ключ управления туннелем, а не вызов моделей. Не записывайте и не присылайте его в чат.
3. Поместите `tunnel-client.exe` в PATH и проверьте доступные команды:

```powershell
tunnel-client --version
tunnel-client help quickstart
```

В новом PowerShell задайте секрет только в окружении процесса. Подставьте реальный tunnel ID и абсолютный путь репозитория:

```powershell
$env:CONTROL_PLANE_API_KEY = Read-Host 'Runtime API key' -AsSecureString | ConvertFrom-SecureString -AsPlainText
tunnel-client init --sample sample_mcp_stdio_local --profile chatgpt-tunnel-probe --tunnel-id 'tunnel_REPLACE_ME' --mcp-command 'node "C:\path\to\chatgpt-tunnel-mcp\dist\src\index.js" --config "C:\path\to\chatgpt-tunnel-mcp\config\local.json"'
tunnel-client doctor --profile chatgpt-tunnel-probe --explain
tunnel-client run --profile chatgpt-tunnel-probe
```

Оставьте `tunnel-client run` работающим: discovery и каждый вызов зависят от него. Состояние также видно в локальном `/ui`, адрес которого сообщает клиент. Остановка — `Ctrl+C`; затем удалите секрет из текущего PowerShell:

```powershell
Remove-Item Env:CONTROL_PLANE_API_KEY
```

Команды выше соответствуют текущему [официальному руководству Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) и встроенному профилю `sample_mcp_stdio_local`. Если установленный бинарник сообщает другое, следуйте `tunnel-client help quickstart` именно этой версии.

## Подключение в ChatGPT Developer mode

Доступность зависит от аккаунта и политики workspace.

1. Пока tunnel-client здоров и работает, откройте ChatGPT → **Settings** → **Security and login** и включите **Developer mode**.
2. Откройте [ChatGPT Plugins](https://chatgpt.com/#settings/Connectors), нажмите **+**.
3. Задайте имя и описание, в **Connection** выберите **Tunnel**, затем существующий tunnel или введите его `tunnel_id`.
4. Создайте подключение и убедитесь, что обнаружены ровно `ping` и `read_probe`.
5. В новом обычном чате добавьте это подключение из меню инструментов и выполните промпты из раздела ниже.

Это требует интерактивного входа пользователя в ChatGPT/Platform. Только фактические вызовы в обычном ChatGPT считаются проверкой главной гипотезы. Даже они сами по себе не устанавливают, из какого лимита списалось использование. См. [официальное подключение MCP в Developer mode](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Подключение напрямую в Codex

Codex и ChatGPT desktop используют общую MCP-конфигурацию. Команда `codex mcp add` добавляет отдельную запись, сохраняя существующие MCP-серверы:

```powershell
codex mcp list
codex mcp add chatgpt-tunnel-probe --env CHATGPT_TUNNEL_MCP_CONFIG='C:\path\to\chatgpt-tunnel-mcp\config\local.json' -- node 'C:\path\to\chatgpt-tunnel-mcp\dist\src\index.js'
codex mcp list
```

Перезапустите клиент Codex и проверьте сервер через `/mcp`. При ручном редактировании не заменяйте `~/.codex/config.toml`: добавьте только новую таблицу `[mcp_servers.chatgpt-tunnel-probe]`. Подробности — в [официальной документации Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Прямой вызов из Codex проверяет локальный MCP, но не туннель и не доступность без Work.

## Точные тестовые промпты для ChatGPT

1. `Вызови инструмент ping подключения chatgpt-tunnel-probe и дословно покажи deviceId, serverVersion и utcTime из результата.`
2. `Вызови read_probe подключения chatgpt-tunnel-probe. Покажи контрольную строку, sha256 и readAtUtc из результата.`
3. После локального изменения файла: `Снова вызови read_probe, не используй прошлый ответ. Покажи новое содержимое и новый sha256 и сравни их с предыдущим вызовом.`

## Диагностика

- **Startup failed / config not found** — выполните `npm run setup:local` либо передайте абсолютный `--config`.
- **Invalid config** — сравните локальный JSON с `config/example.json`; неизвестные поля отклоняются.
- **Probe does not exist** — снова создайте `local/probe.txt`; перезапуск сервера не нужен.
- **Probe exceeds limit** — уменьшите файл либо осознанно увеличьте `maxProbeBytes` максимум до 1 MiB и перезапустите сервер.
- **Invalid UTF-8** — сохраните probe как UTF-8. Бинарные данные намеренно не поддерживаются.
- **Inspector/Codex не видит сервер** — сначала выполните `npm run build`, используйте абсолютные пути и проверьте, что stdout не перенаправлен на диагностический вывод.
- **`tunnel-client doctor` не проходит** — проверьте tunnel ID, права runtime key, доступ к `api.openai.com:443` и команду запуска MCP. Не включайте ключ в логи или issue.
- **ChatGPT не обнаруживает инструменты** — tunnel-client должен оставаться healthy/ready; проверьте association туннеля с нужным workspace и обновите metadata подключения.
- **Developer mode или Tunnel отсутствует** — функция не доступна этому аккаунту/workspace либо запрещена администратором; локальным кодом это не исправляется.

## Статус эксперимента

2026-09-09 пользователь подтвердил чтение обновлённого локального probe-файла из ChatGPT через Secure MCP Tunnel: содержимое, SHA-256 и время чтения изменились после локального обновления файла. Сценарий выполнялся для обычного чата без Work; результат ручной проверки зафиксирован со слов пользователя. Источник расходования лимитов и отдельное подключение Codex пока не проверены.

Подробности и замечания по настройке: [результаты эксперимента](docs/experiments/2026-09-09-chatgpt-mcp.md).
