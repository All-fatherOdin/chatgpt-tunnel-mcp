import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { executorOptionsSchema } from "../exchange/schemas.js";
import { ExchangeService } from "../exchange/service.js";
import { CodexExecutor, DispatchError } from "./codex.js";
import { loadDispatcherConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { RunStore, readRuns } from "./store.js";

try {
  const { values } = parseArgs({ options: {
    config: { type: "string", default: "config/dispatcher.local.json" },
    once: { type: "boolean" }, status: { type: "boolean" }, doctor: { type: "boolean" },
    task: { type: "string" }, recover: { type: "boolean" },
    model: { type: "string" }, effort: { type: "string" },
    session: { type: "string" }, thread: { type: "string" }, help: { type: "boolean" }
  }, strict: true });
  if (values.help) {
    process.stdout.write("dispatcher --config FILE [--once] [--task UUID] [--model MODEL] [--effort EFFORT] [--session auto|new|resume|fork --thread ID]\nRead-only: --status | --doctor\nRecovery: --once --task UUID --recover (reconcile persisted run; never rerun an ambiguous turn)\n");
  } else {
    if ([values.status, values.doctor].filter(Boolean).length > 1) throw new DispatchError("CHOOSE_STATUS_OR_DOCTOR");
    if ((values.model || values.effort || values.session || values.thread || values.recover) && (!values.task || !values.once)) throw new DispatchError("OVERRIDE_OR_RECOVERY_REQUIRES_ONCE_AND_TASK");
    if (values.recover && (values.model || values.effort || values.session)) throw new DispatchError("RECOVERY_CANNOT_CHANGE_FROZEN_SETTINGS");
    if (values.thread && values.session !== "resume" && values.session !== "fork") throw new DispatchError("THREAD_REQUIRES_RESUME_OR_FORK");
    const overrides = executorOptionsSchema.parse({ model: values.model, reasoningEffort: values.effort,
      ...(values.session ? { session: { mode: values.session, ...(values.thread ? { threadId: values.thread } : {}) } } : {}) });
    // Undefined optional fields are not actual overrides.
    const cleanOverrides = JSON.parse(JSON.stringify(overrides));
    const { config, app } = await loadDispatcherConfig(values.config!);
    if (values.doctor) {
      const executor = new CodexExecutor(config);
      try { process.stdout.write(`${JSON.stringify({ models: await executor.models() })}\n`); }
      finally { await executor.close(); }
    } else if (values.status) {
      const runs = readRuns(config.statePath, JSON.stringify({ store: app.exchange!.storePath, principal: app.exchange!.principalId }));
      process.stdout.write(`${JSON.stringify({ runs: runs.map(({ claim, report, cwd, overrides, ...metadata }) => metadata) })}\n`);
    } else {
      const journal = new RunStore(config.statePath, JSON.stringify({ store: app.exchange!.storePath, principal: app.exchange!.principalId }));
      let exchange: ExchangeService | undefined;
      let dispatcher: Dispatcher | undefined;
      const abort = new AbortController();
      const stop = () => { abort.abort(); void dispatcher?.stop(); };
      try {
        journal.acquire();
        exchange = new ExchangeService(app);
        dispatcher = new Dispatcher(config, app, journal, exchange);
        process.on("SIGINT", stop); process.on("SIGTERM", stop);
        do {
          await dispatcher.tick(values.task, cleanOverrides, values.recover);
          if (values.once || abort.signal.aborted) break;
          await delay(config.pollIntervalMs, undefined, { signal: abort.signal }).catch(() => {});
        } while (!abort.signal.aborted);
        if (values.once && journal.list().some(run => (!values.task || run.taskId === values.task) && (run.attention || run.phase !== "done"))) process.exitCode = 2;
      } finally {
        process.off("SIGINT", stop); process.off("SIGTERM", stop);
        await dispatcher?.stop(); exchange?.close(); journal.close();
      }
    }
  }
} catch (error) {
  const message = error instanceof DispatchError ? error.code : "DISPATCHER_STARTUP_FAILED (check config, paths, worker role and journal ownership)";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
