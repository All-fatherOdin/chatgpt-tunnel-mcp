# Bounded report waiting

Planner connections expose `wait_for_report` when exchange is enabled. No diagnostic flag is required. Rebuild and restart the MCP connection to refresh tool discovery.

Input: `projectId`, `taskId`, optional integer `timeoutSeconds` (1–60, default 60).

Output includes `projectId`, `taskId`, `state`, `elapsedMs` and `status`:

- `reported`: `reportId` is available; fetch it with `get_report`. This also applies to already reviewed reports.
- `pending`: no report at the deadline. The caller decides whether to wait again.
- `attention`: the dispatcher reported a problem requiring operator action; `executionStatus` contains the safe diagnostic code.
- `cancelled`: the task was cancelled; stop waiting.

The server polls the exchange and, when configured, the read-only dispatcher projection at most once per second with asynchronous waits. No database transaction spans a wait. Client cancellation aborts waiting. Project authorization is checked on each read, and worker connections do not expose this tool. Without a dispatcher journal the original pending/reported/cancelled behavior is unchanged. Waiting does not run a model, start a worker, mutate a task, or wake a conversation whose turn has ended.

Suggested ChatGPT test instruction, after choosing a real task:

> Call wait_for_report for the specified projectId and taskId with timeoutSeconds=60. On pending, repeat without asking me, up to 10 calls total. On reported, fetch get_report and summarize it; do not accept it or create follow-up tasks automatically. On attention, cancelled, any error, or after 10 pending responses, stop and report the reason. Do not retry errors automatically.

The 10-call budget belongs to the caller, not the server. Tool-call continuation and tunnel timeouts must still be verified in ChatGPT; local tests alone do not establish autonomous wake-up or quota savings.
