import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createTaskInputSchema, getTaskOutputSchema, type ClaimTaskInput, type SubmitReportInput } from "../src/exchange/schemas.js";
import { ExchangeService } from "../src/exchange/service.js";
import { ExchangeError } from "../src/exchange/store.js";
import { CodexExecutor, DispatchError, type Executor, type Thread } from "../src/dispatcher/codex.js";
import { loadDispatcherConfig, type DispatcherConfig, type DispatchProject } from "../src/dispatcher/config.js";
import { Dispatcher } from "../src/dispatcher/dispatcher.js";
import { RunStore, readRuns, type Run } from "../src/dispatcher/store.js";
import { readExecutionStatus } from "../src/exchange/execution-status.js";

const report = () => ({ outcome: "completed", summary: "Work completed", changes: [], checks: [{ description: "Fixture check", status: "passed", evidence: "Fixture only" }],
  criterionResults: [{ criterionId: "AC1", status: "met", evidence: "Fixture evidence" }], limitations: [], questions: [] });

class FakeExecutor implements Executor {
  calls = 0;
  opened: Run[] = [];
  prompts: string[] = [];
  threads = new Map<string, Thread>();
  failAfterTurn = false;
  missingTurn = false;
  async models() { return [{ model: "test-model", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }]; }
  async readThread(id: string) { const thread = this.threads.get(id); if (!thread) throw new DispatchError("THREAD_NOT_FOUND"); return thread; }
  async open(run: Run, _project: DispatchProject) {
    this.opened.push(structuredClone(run));
    const threadId = run.sessionMode === "resume" ? run.sourceThreadId! : randomUUID();
    if (!this.threads.has(threadId)) this.threads.set(threadId, { id: threadId, cwd: run.cwd, status: { type: "idle" }, turns: [] });
    return { threadId, model: run.model, reasoningEffort: run.reasoningEffort! };
  }
  async execute(run: Run, prompt: string, onTurn: (id: string) => void): Promise<unknown> {
    this.calls++; this.prompts.push(prompt);
    const turnId = randomUUID(); onTurn(turnId);
    if (!this.missingTurn) this.threads.get(run.threadId!)!.turns!.push({ id: turnId, status: "completed", items: [{ type: "agentMessage", text: JSON.stringify(report()) }] });
    if (this.failAfterTurn) throw new DispatchError("CONNECTION_LOST");
    return report();
  }
  async close() {}
}

async function fixture(Service: typeof ExchangeService = ExchangeService) {
  const directory = await mkdtemp(join(tmpdir(), "dispatcher-test-"));
  const root = join(directory, "project"); await mkdir(root); await writeFile(join(root, "source.txt"), "source\n");
  const base = { deviceId: "dispatcher-test-device", probeFile: "probe.txt", projects: [{ projectId: "project", name: "Fixture", root, readOnly: true }],
    exchange: { enabled: true, storePath: join(directory, "exchange.sqlite"), dispatcherStatePath: join(directory, "dispatcher.sqlite"), role: "worker", principalId: "worker", allowedProjectIds: ["project"] } };
  const workerFile = join(directory, "worker.json"), plannerFile = join(directory, "planner.json"), dispatchFile = join(directory, "dispatcher.json");
  await writeFile(workerFile, JSON.stringify(base));
  await writeFile(plannerFile, JSON.stringify({ ...base, exchange: { ...base.exchange, role: "planner", principalId: "planner" } }));
  await writeFile(dispatchFile, JSON.stringify({ enabled: true, workerConfig: workerFile, statePath: join(directory, "dispatcher.sqlite"),
    codexCommand: process.execPath, codexArgs: [resolve(import.meta.dirname, "../../test/fixtures/codex-server.mjs")],
    executor: { model: "test-model", reasoningEffort: "medium" },
    projects: [{ projectId: "project", enabled: true, allowedPlannerIds: ["planner"], allowedPaths: ["docs"], maxSessionTasks: 2 }] }));
  const { config, app } = await loadDispatcherConfig(dispatchFile);
  const planner = new ExchangeService(await loadConfig(plannerFile)), worker = new Service(app);
  const identity = JSON.stringify({ store: app.exchange!.storePath, principal: app.exchange!.principalId });
  let journal = new RunStore(config.statePath, identity); journal.acquire();
  const fake = new FakeExecutor();
  const events: Record<string, unknown>[] = [];
  const makeDispatcher = (executor: Executor = fake) => new Dispatcher(config, app, journal, worker, () => executor, event => events.push(event));
  let dispatcher = makeDispatcher();
  return { directory, root, config, app, planner, worker, fake, events, dispatchFile,
    get journal() { return journal; }, get dispatcher() { return dispatcher; }, makeDispatcher,
    restart() { journal.close(); journal = new RunStore(config.statePath, identity); journal.acquire(); dispatcher = makeDispatcher(); },
    async task(extra: Record<string, unknown> = {}) {
      const created = await planner.createTask(createTaskInputSchema.parse({ projectId: "project", idempotencyKey: randomUUID(), title: "Fixture task", objective: "Write documentation",
        scope: { allowedPaths: ["docs"] }, constraints: [], acceptanceCriteria: [{ id: "AC1", description: "Documentation exists" }], sourceRefs: [], execution: { autoStart: true }, ...extra }));
      return String(created.taskId);
    },
    async review(taskId: string) {
      const task = planner.getTask("project", taskId);
      planner.reviewReport({ projectId: "project", taskId, reportId: task.reportId!, expectedRevision: task.task.revision, idempotencyKey: randomUUID(), decision: "changes_requested", comment: "Add more details" });
    },
    async close() { await dispatcher.stop(); journal.close(); planner.close(); worker.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

test("dispatcher delivers one report with frozen model provenance; a second poll does not execute again", async () => {
  const f = await fixture();
  try {
    f.config.executor.model = "unavailable-default";
    f.config.projects[0]!.executor = { model: "unavailable-project", reasoningEffort: "high" };
    const id = await f.task({ execution: { autoStart: true, model: "unavailable-task" } });
    await f.dispatcher.tick(id, { model: "test-model" });
    const run = f.journal.get(id)!;
    assert.equal(run.phase, "done"); assert.equal(run.modelSource, "run"); assert.equal(run.effortSource, "project");
    const task = f.planner.getTask("project", id);
    assert.equal(task.task.state, "reported"); assert.equal(task.review, undefined);
    assert.equal(task.executionStatus?.phase, "done");
    getTaskOutputSchema.parse(task);
    const result = f.planner.getReport("project", task.reportId!).report;
    assert.equal(result.execution?.threadId, run.threadId); assert.equal(result.execution?.reasoningEffort, "high");
    const status = readExecutionStatus(f.config.statePath, f.app.exchange!.storePath, "project", id);
    assert.equal(status?.phase, "done"); assert.equal(JSON.stringify(status).includes(f.root), false);
    await f.dispatcher.tick(); assert.equal(f.fake.calls, 1);
    assert.equal(JSON.stringify(f.events).includes(f.root), false);
  } finally { await f.close(); }
});

test("dispatcher enforces opt-in, planner and scope allowlists without claiming manual tasks", async () => {
  const f = await fixture();
  try {
    const manual = await f.task({ execution: undefined });
    const outside = await f.task({ scope: { allowedPaths: ["docs-other"] } });
    const whole = await f.task({ scope: { wholeProject: true } });
    await f.dispatcher.tick(); assert.equal(f.fake.opened.length, 0);
    for (const id of [manual, outside, whole]) assert.equal(f.planner.getTask("project", id).task.state, "queued");
    assert.equal(f.planner.getTask("project", manual).executionStatus, undefined);
    assert.equal(f.planner.getTask("project", outside).executionStatus?.attention, "DISPATCH_PATH_NOT_ALLOWED");
    assert.equal(f.planner.getTask("project", whole).executionStatus?.attention, "DISPATCH_WHOLE_PROJECT_NOT_ALLOWED");
    const waiting = await f.planner.waitForReport("project", whole, 5);
    assert.equal(waiting.status, "attention");
    assert.equal(waiting.executionStatus?.attention, "DISPATCH_WHOLE_PROJECT_NOT_ALLOWED");
    assert.ok(waiting.elapsedMs < 1000);

    f.config.projects[0]!.allowWholeProject = true;
    await f.dispatcher.tick();
    assert.equal(f.planner.getTask("project", whole).task.state, "reported");
    assert.equal(f.journal.get(whole)?.attention, undefined);
    const denied = await f.task(); f.config.projects[0]!.allowedPlannerIds = ["other"];
    await assert.rejects(f.dispatcher.tick(denied), /TASK_NOT_AUTHORIZED/);
    f.config.enabled = false; await assert.rejects(f.dispatcher.tick(), /DISPATCHER_DISABLED/);
  } finally { await f.close(); }
});

test("unavailable model and effort fail before claim without fallback", async () => {
  const f = await fixture();
  try {
    const a = await f.task({ execution: { autoStart: true, model: "not-a-model" } });
    const b = await f.task({ execution: { autoStart: true, reasoningEffort: "not-an-effort" } });
    await f.dispatcher.tick();
    assert.equal(f.journal.get(a)?.attention, "MODEL_UNAVAILABLE");
    assert.equal(f.journal.get(b)?.attention, "REASONING_EFFORT_UNAVAILABLE");
    assert.equal(f.planner.getTask("project", a).task.state, "queued"); assert.equal(f.fake.calls, 0);
    await f.dispatcher.tick(a, { model: "test-model" });
    assert.equal(f.journal.get(a)?.phase, "done"); assert.equal(f.journal.get(a)?.modelSource, "run");
  } finally { await f.close(); }
});

test("stale source references produce a blocked report without starting an executor turn", async () => {
  const f = await fixture();
  try {
    const id = await f.task({ sourceRefs: [{ path: "source.txt", sha256: createHash("sha256").update("old source").digest("hex") }] });
    await f.dispatcher.tick();
    const task = f.planner.getTask("project", id);
    assert.equal(f.planner.getReport("project", task.reportId!).report.outcome, "blocked"); assert.equal(f.fake.calls, 0);
  } finally { await f.close(); }
});

test("claim commit ambiguity reuses its original idempotency key after journal restart", async () => {
  class LostClaim extends ExchangeService {
    calls: ClaimTaskInput[] = [];
    override claimTask(input: ClaimTaskInput) {
      this.calls.push(structuredClone(input)); const result = super.claimTask(input);
      if (this.calls.length === 1) throw new ExchangeError("STORAGE_UNAVAILABLE", "Simulated response loss", true);
      return result;
    }
  }
  const f = await fixture(LostClaim);
  try {
    const id = await f.task(); await f.dispatcher.tick();
    assert.equal(f.journal.get(id)?.phase, "prepared"); assert.equal(f.planner.getTask("project", id).task.state, "in_progress");
    f.restart(); await f.dispatcher.tick(id, {}, true);
    const calls = (f.worker as LostClaim).calls;
    assert.deepEqual(calls[0], calls[1]); assert.equal(f.fake.calls, 1); assert.equal(f.journal.get(id)?.phase, "done");
  } finally { await f.close(); }
});

test("durable outbox retries delivery with identical UUID and revision without repeating execution", async () => {
  class BusyDelivery extends ExchangeService {
    calls: SubmitReportInput[] = [];
    override submitReport(input: SubmitReportInput) {
      this.calls.push(structuredClone(input));
      if (this.calls.length === 1) throw new ExchangeError("STORAGE_BUSY", "Simulated busy store", true);
      return super.submitReport(input);
    }
  }
  const f = await fixture(BusyDelivery);
  try {
    const id = await f.task(); await f.dispatcher.tick();
    assert.equal(f.journal.get(id)?.phase, "delivering"); assert.equal(f.journal.get(id)?.attention, undefined);
    f.restart(); await f.dispatcher.tick();
    assert.equal(f.journal.get(id)?.phase, "done"); assert.equal(f.fake.calls, 1);
    assert.deepEqual((f.worker as BusyDelivery).calls[0], (f.worker as BusyDelivery).calls[1]);
  } finally { await f.close(); }
});

test("lost submit response is reconciled from exchange on restart", async () => {
  class LostDelivery extends ExchangeService {
    override submitReport(input: SubmitReportInput): never { super.submitReport(input); throw new ExchangeError("STORAGE_UNAVAILABLE", "Lost response", true); }
  }
  const f = await fixture(LostDelivery);
  try {
    const id = await f.task(); await f.dispatcher.tick(); f.restart(); await f.dispatcher.tick();
    assert.equal(f.journal.get(id)?.phase, "done"); assert.equal(f.fake.calls, 1);
  } finally { await f.close(); }
});

test("recovery fetches completed old turn; unknown execution blocks new project work", async () => {
  const f = await fixture();
  try {
    f.fake.failAfterTurn = true;
    const id = await f.task(); await f.dispatcher.tick();
    assert.equal(f.journal.get(id)?.attention, "CONNECTION_LOST");
    f.restart(); await f.dispatcher.tick(id, {}, true);
    assert.equal(f.journal.get(id)?.phase, "done"); assert.equal(f.fake.calls, 1);
    f.fake.missingTurn = true;
    const missing = await f.task(); await f.dispatcher.tick();
    const waiting = await f.task(); await f.dispatcher.tick();
    assert.equal(f.journal.get(waiting), undefined);
    await f.dispatcher.tick(missing, {}, true);
    assert.equal(f.journal.get(missing)?.attention, "EXECUTION_STATE_AMBIGUOUS"); assert.equal(f.fake.calls, 2);
  } finally { await f.close(); }
});

test("review follow-up resumes its parent's session; session limit creates a new thread with handoff", async () => {
  const f = await fixture();
  try {
    const first = await f.task(); await f.dispatcher.tick(); await f.review(first);
    const second = await f.task({ parentTaskId: first }); await f.dispatcher.tick(); await f.review(second);
    assert.equal(f.journal.get(second)?.threadId, f.journal.get(first)?.threadId);
    assert.equal(f.journal.get(second)?.sessionMode, "resume");
    const third = await f.task({ parentTaskId: second }); await f.dispatcher.tick();
    assert.notEqual(f.journal.get(third)?.threadId, f.journal.get(second)?.threadId);
    assert.equal(f.journal.get(third)?.sessionReason, "session_task_limit_handoff");
    assert.ok(f.fake.prompts[2]!.includes("Add more details"));
    const fourth = await f.task({ execution: { autoStart: true, session: { mode: "fork", threadId: f.journal.get(third)!.threadId! } } });
    await f.dispatcher.tick(); assert.equal(f.journal.get(fourth)?.sessionMode, "fork");
    const unknown = await f.task({ execution: { autoStart: true, session: { mode: "resume", threadId: "some-unrelated-thread" } } });
    await f.dispatcher.tick(); assert.equal(f.journal.get(unknown)?.attention, "SESSION_NOT_MANAGED_FOR_PROJECT");
  } finally { await f.close(); }
});

test("interrupted old turn produces an honest failed report without running modifications again", async () => {
  const f = await fixture();
  try {
    f.fake.failAfterTurn = true;
    const id = await f.task(); await f.dispatcher.tick();
    const run = f.journal.get(id)!;
    f.fake.threads.get(run.threadId!)!.turns![0]!.status = "interrupted";
    f.restart(); await f.dispatcher.tick(id, {}, true);
    const result = f.planner.getReport("project", f.journal.get(id)!.reportId!).report;
    assert.equal(result.outcome, "failed"); assert.equal(result.criterionResults[0]!.status, "not_verified");
    assert.match(result.limitations[0]!, /not inventoried/); assert.equal(f.fake.calls, 1);
  } finally { await f.close(); }
});

test("model-generated report paths still undergo strict validation; completed run cannot change model", async () => {
  const f = await fixture();
  try {
    const valid = await f.task(); await f.dispatcher.tick();
    await assert.rejects(f.dispatcher.tick(valid, { model: "test-model" }), /FROZEN/);
    f.fake.execute = async (_run, _prompt, onTurn) => {
      onTurn("bad-path-turn");
      return { ...report(), changes: [{ path: "../escape.txt", description: "Invalid path" }] };
    };
    const invalid = await f.task(); await f.dispatcher.tick();
    assert.equal(f.journal.get(invalid)?.attention, "EXECUTOR_REPORT_INVALID");
    assert.equal(f.planner.getTask("project", invalid).reportId, undefined);
  } finally { await f.close(); }
});

test("journal lock rejects concurrent dispatchers and refuses a different exchange identity", async () => {
  const f = await fixture();
  try {
    const second = new RunStore(f.config.statePath, JSON.stringify({ store: f.app.exchange!.storePath, principal: "worker" }));
    try { assert.throws(() => second.acquire(), /already running/); } finally { second.close(); }
    assert.throws(() => new RunStore(f.config.statePath, "other"), /different exchange/);
    assert.deepEqual(readRuns(join(f.directory, "missing.sqlite"), "unused"), []);
    await assert.rejects(readFile(join(f.directory, "missing.sqlite")), /ENOENT/);
    const raw = JSON.parse(await readFile(f.dispatchFile, "utf8"));
    await writeFile(f.dispatchFile, JSON.stringify({ ...raw, statePath: join(f.root, "state.sqlite") }));
    await assert.rejects(loadDispatcherConfig(f.dispatchFile), /outside project roots|must match/);
  } finally { await f.close(); }
});

test("real stdio adapter handles completion before turn/start response and validates report", async () => {
  const f = await fixture(); const executor = new CodexExecutor(f.config);
  try {
    const id = await f.task(); await f.makeDispatcher(executor).tick();
    assert.equal(f.journal.get(id)?.phase, "done");
    assert.equal(f.journal.get(id)?.actualModel, "test-model");
  } finally { await executor.close(); await f.close(); }
});

test("project permission mode is optional, validated, and does not send dispatcher sandbox overrides", async () => {
  const f = await fixture();
  try {
    f.config.projects[0]!.permissionMode = "project";
    f.config.projects[0]!.codexProject = { root: f.root };
    f.config.codexArgs.push("project");
    const executor = new CodexExecutor(f.config);
    try {
      const id = await f.task(); await f.makeDispatcher(executor).tick();
      assert.equal(f.journal.get(id)?.phase, "done");
    } finally { await executor.close(); }

    const raw = JSON.parse(await readFile(f.dispatchFile, "utf8"));
    raw.projects[0].permissionMode = "project";
    await writeFile(f.dispatchFile, JSON.stringify(raw));
    await assert.rejects(loadDispatcherConfig(f.dispatchFile), /requires codexProject/);
    raw.projects[0].codexProject = { root: f.directory };
    await writeFile(f.dispatchFile, JSON.stringify(raw));
    await assert.rejects(loadDispatcherConfig(f.dispatchFile), /must match the worker project root/);
    raw.projects[0].codexProject = { root: f.root };
    raw.projects[0].additionalWritableRoots = [f.directory];
    await writeFile(f.dispatchFile, JSON.stringify(raw));
    await assert.rejects(loadDispatcherConfig(f.dispatchFile), /cannot use dispatcher additionalWritableRoots/);
  } finally { await f.close(); }
});

test("live Codex creates a scoped file and delivers its report", { skip: !process.env.CHATGPT_TUNNEL_LIVE_CODEX, timeout: 240000 }, async () => {
  const f = await fixture();
  f.config.codexCommand = process.env.CHATGPT_TUNNEL_LIVE_CODEX!;
  f.config.codexArgs = [];
  f.config.executor = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  f.config.turnTimeoutMs = 180000;
  const executor = new CodexExecutor(f.config);
  try {
    const id = await f.task({ objective: "Create docs/acceptance.txt containing exactly stage-4a-ok followed by a newline. Read it back and verify the content. Do not change any other files. This is a temporary local acceptance fixture. Return the structured report.",
      acceptanceCriteria: [{ id: "AC1", description: "docs/acceptance.txt contains exactly stage-4a-ok followed by a newline, and was read back to verify it." }] });
    await f.makeDispatcher(executor).tick();
    const run = f.journal.get(id)!;
    if (run.attention && run.threadId) {
      const thread = await executor.readThread(run.threadId);
      const last = thread.turns?.at(-1) as { status: string; error?: unknown } | undefined;
      process.stdout.write(`${JSON.stringify({ liveTurnStatus: last?.status, error: last?.error })}\n`);
    }
    assert.equal(run.attention, undefined, `Live execution attention: ${run.attention}`);
    assert.equal(run.phase, "done");
    const task = f.planner.getTask("project", id);
    const result = f.planner.getReport("project", task.reportId!).report;
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    assert.equal((await readFile(join(f.root, "docs/acceptance.txt"), "utf8")).replaceAll("\r\n", "\n"), "stage-4a-ok\n");
    assert.equal(result.execution?.actualModel, "gpt-5.6-sol");
    process.stdout.write(`${JSON.stringify({ liveAcceptance: "passed", taskId: id, reportId: task.reportId, threadId: run.threadId, model: run.actualModel })}\n`);
  } finally { await executor.close(); await f.close(); }
});
