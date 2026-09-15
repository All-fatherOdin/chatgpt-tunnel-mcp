import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { MAX_CANCEL_REASON_JSON_BYTES, MAX_TASK_BYTES, jsonBytes, taskLifecycleBytes } from "../src/exchange/limits.js";
import type { Task } from "../src/exchange/schemas.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../..");
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("invalid exchange input identifies fields without echoing values or consuming the retry key", async () => {
  const fixture = await makeExchangeFixture();
  const planner = await connect(fixture.plannerConfig), worker = await connect(fixture.workerConfig);
  const secret = "SECRET-INPUT-DO-NOT-ECHO";
  try {
    const uuidError = await expectExchangeError(planner.client, "create_task", taskInput({ idempotencyKey: secret }), "INVALID_INPUT");
    assert.match(String(uuidError.message), /idempotencyKey: must be a UUID/);
    assert.equal(JSON.stringify(uuidError).includes(secret), false);
    const retryKey = randomUUID();
    const nestedError = await expectExchangeError(planner.client, "create_task", taskInput({
      idempotencyKey: retryKey,
      acceptanceCriteria: [{ id: "AC1", description: 42 }],
      sourceRefs: [{ path: "README.md", sha256: secret }],
      scope: { allowedPaths: [], [secret]: secret }
    }), "INVALID_INPUT");
    assert.match(String(nestedError.message), /acceptanceCriteria\[0\]\.description: expected string/);
    assert.match(String(nestedError.message), /sourceRefs\[0\]\.sha256: must contain exactly 64 hexadecimal characters/);
    assert.match(String(nestedError.message), /scope: unknown fields are not allowed/);
    assert.equal(JSON.stringify(nestedError).includes(secret), false);
    const missingError = await expectExchangeError(planner.client, "create_task", { projectId: "project" }, "INVALID_INPUT");
    assert.match(String(missingError.message), /idempotencyKey: required field is missing/);
    assert.match(String(missingError.message), /Additional errors omitted/);
    const enumError = await expectExchangeError(worker.client, "submit_report", {
      ...reportInput(randomUUID(), "completed", 2), outcome: secret
    }, "INVALID_INPUT");
    assert.match(String(enumError.message), /outcome: must be one of completed, blocked, failed/);
    assert.equal(JSON.stringify(enumError).includes(secret), false);
    assert.deepEqual((await call(planner.client, "list_tasks", { projectId: "project" })).tasks, []);
    const valid = taskInput({ idempotencyKey: retryKey });
    const created = await call(planner.client, "create_task", valid);
    assert.equal(created.revision, 1);
    assert.deepEqual(await call(planner.client, "create_task", valid), created);
    assert.equal(planner.stderrText().includes(secret), false);
    assert.equal(worker.stderrText().includes(secret), false);
  } finally { await closeAll(planner, worker); }
});

test("planner and worker expose role-specific tools and complete a persistent idempotent lifecycle", async () => {
  const fixture = await makeExchangeFixture();
  let planner = await connect(fixture.plannerConfig), worker = await connect(fixture.workerConfig);
  try {
    const plannerTools = await planner.client.listTools(), workerTools = await worker.client.listTools();
    assert.deepEqual(exchangeTools(plannerTools), ["cancel_task", "create_task", "get_report", "get_task", "list_tasks", "review_report"]);
    assert.deepEqual(exchangeTools(workerTools), ["claim_task", "get_report", "get_task", "list_tasks", "submit_report"]);
    for (const tool of [...plannerTools.tools, ...workerTools.tools].filter(tool => tool.name.includes("task") || tool.name.includes("report"))) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: ${JSON.stringify(tool.inputSchema)}`); assert.ok(tool.outputSchema);
      assert.equal(tool.outputSchema?.additionalProperties, false);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name}: ${JSON.stringify(tool.annotations)}`);
      const mutation = ["create_task", "claim_task", "submit_report", "review_report", "cancel_task"].includes(tool.name);
      assert.equal(tool.annotations?.readOnlyHint, !mutation);
      assert.equal(tool.annotations?.idempotentHint, true);
      assert.equal(tool.annotations?.destructiveHint, tool.name === "cancel_task");
    }

    const secretToken = "SECRET-LIKE-CONTROL-TEXT-9f8e7d";
    const createInput = taskInput({ title: secretToken, execution: { autoStart: true, model: "test-model", reasoningEffort: "medium", session: { mode: "new" } } });
    const created = await call(planner.client, "create_task", createInput);
    const taskId = stringField(created, "taskId");
    const queued = await call(planner.client, "get_task", { projectId: "project", taskId });
    assert.deepEqual((queued.task as Record<string, unknown>).execution, createInput.execution);
    assert.equal((queued.task as Record<string, unknown>).state, "queued", "MCP publication must not itself execute even an opted-in task");
    assert.equal(planner.stderrText().includes(secretToken), false);
    assert.equal(planner.stderrText().includes(fixture.projectRoot), false);
    assert.equal(planner.stderrText().includes(fixture.storePath), false);
    await planner.transport.close();
    planner = await connect(fixture.plannerConfig);
    assert.deepEqual(await call(planner.client, "create_task", createInput), created, "retry after committed response loss must return the original result");
    await expectExchangeError(planner.client, "create_task", { ...createInput, title: "different" }, "IDEMPOTENCY_CONFLICT");

    const claimed = await call(worker.client, "claim_task", { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: randomUUID() });
    assert.equal(claimed.state, "in_progress");
    const reportKey = randomUUID();
    const reportInput = completedReport(taskId, reportKey, 2);
    const reported = await call(worker.client, "submit_report", reportInput);
    await worker.transport.close();
    worker = await connect(fixture.workerConfig);
    assert.deepEqual(await call(worker.client, "submit_report", reportInput), reported);
    const reportId = stringField(reported, "reportId");
    const report = await call(planner.client, "get_report", { projectId: "project", reportId });
    assert.equal((report.report as Record<string, unknown>).outcome, "completed");
    const reviewed = await call(planner.client, "review_report", { projectId: "project", taskId, reportId, expectedRevision: 3, idempotencyKey: randomUUID(), decision: "accepted", comment: "Evidence reviewed." });
    assert.equal(reviewed.state, "accepted");
    await planner.transport.close();
    planner = await connect(fixture.plannerConfig);
    const persisted = await call(planner.client, "get_task", { projectId: "project", taskId });
    assert.equal((persisted.task as Record<string, unknown>).state, "accepted");
    assert.equal((persisted.review as Record<string, unknown>).decision, "accepted");
    assert.equal(await projectDigest(fixture.projectRoot), fixture.initialDigest, "exchange mutations must not modify project roots");
    await assert.rejects(() => readFile(join(fixture.projectRoot, "forbidden-marker")), /ENOENT/);
  } finally { await closeAll(planner, worker); }
});

test("two stdio workers race atomically; ownership, revision and allowlist are enforced", async () => {
  const fixture = await makeExchangeFixture();
  const planner = await connect(fixture.plannerConfig), plannerB = await connect(fixture.plannerBConfig), workerA = await connect(fixture.workerConfig), workerA2 = await connect(fixture.workerConfig), workerB = await connect(fixture.workerBConfig);
  try {
    const taskId = stringField(await call(planner.client, "create_task", taskInput()), "taskId");
    await expectExchangeError(plannerB.client, "cancel_task", { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: randomUUID(), reason: "forged ownership" }, "FORBIDDEN");
    const attempts = await Promise.all([
      workerA.client.callTool({ name: "claim_task", arguments: { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: randomUUID() } }),
      workerA2.client.callTool({ name: "claim_task", arguments: { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: randomUUID() } })
    ]);
    assert.equal(attempts.filter(result => result.isError !== true).length, 1);
    assert.equal(attempts.filter(result => result.isError === true).length, 1);
    await expectExchangeError(workerA.client, "submit_report", completedReport(taskId, randomUUID(), 1), "CONFLICT");
    await expectExchangeError(workerB.client, "submit_report", completedReport(taskId, randomUUID(), 2), "FORBIDDEN");
    await expectExchangeError(workerA.client, "get_task", { projectId: "other", taskId }, "NOT_FOUND");
    const task = await call(workerA.client, "get_task", { projectId: "project", taskId });
    assert.equal((task.task as Record<string, unknown>).revision, 2);
  } finally { await closeAll(planner, plannerB, workerA, workerA2, workerB); }
});

test("cancel, blocked, failed, changes-requested and follow-up branches preserve invariants", async () => {
  const fixture = await makeExchangeFixture();
  const planner = await connect(fixture.plannerConfig), worker = await connect(fixture.workerConfig);
  try {
    const cancelledId = stringField(await call(planner.client, "create_task", taskInput()), "taskId");
    await call(planner.client, "cancel_task", { projectId: "project", taskId: cancelledId, expectedRevision: 1, idempotencyKey: randomUUID(), reason: "No longer needed." });
    await expectExchangeError(worker.client, "claim_task", { projectId: "project", taskId: cancelledId, expectedRevision: 2, idempotencyKey: randomUUID() }, "INVALID_STATE");

    const blockedId = stringField(await call(planner.client, "create_task", taskInput()), "taskId");
    await call(worker.client, "claim_task", { projectId: "project", taskId: blockedId, expectedRevision: 1, idempotencyKey: randomUUID() });
    const blocked = await call(worker.client, "submit_report", reportInput(blockedId, "blocked", 2));
    const blockedReportId = stringField(blocked, "reportId");
    await expectExchangeError(planner.client, "review_report", { projectId: "project", taskId: blockedId, reportId: blockedReportId, expectedRevision: 3, idempotencyKey: randomUUID(), decision: "accepted", comment: "No." }, "INVALID_STATE");
    await call(planner.client, "review_report", { projectId: "project", taskId: blockedId, reportId: blockedReportId, expectedRevision: 3, idempotencyKey: randomUUID(), decision: "changes_requested", comment: "Provide the missing condition." });
    const followUp = taskInput(); followUp.parentTaskId = blockedId;
    assert.equal((await call(planner.client, "create_task", followUp)).state, "queued");

    const failedId = stringField(await call(planner.client, "create_task", taskInput()), "taskId");
    await call(worker.client, "claim_task", { projectId: "project", taskId: failedId, expectedRevision: 1, idempotencyKey: randomUUID() });
    const failed = await call(worker.client, "submit_report", reportInput(failedId, "failed", 2));
    await call(planner.client, "review_report", { projectId: "project", taskId: failedId, reportId: failed.reportId, expectedRevision: 3, idempotencyKey: randomUUID(), decision: "changes_requested", comment: "Retry separately." });
    const listed = await call(planner.client, "list_tasks", { projectId: "project", states: ["changes_requested"], limit: 1 });
    assert.equal((listed.tasks as unknown[]).length, 1); assert.equal(typeof listed.nextCursor, "string");
    await expectExchangeError(planner.client, "list_tasks", { projectId: "project", states: ["queued"], cursor: listed.nextCursor }, "INVALID_INPUT");
  } finally { await closeAll(planner, worker); }
});

test("semantic validation covers scope, sources, criteria and blocked reports", async () => {
  const fixture = await makeExchangeFixture();
  const planner = await connect(fixture.plannerConfig), worker = await connect(fixture.workerConfig);
  try {
    await expectExchangeError(planner.client, "create_task", taskInput({ scope: { allowedPaths: [], outOfScope: [] } }), "INVALID_INPUT");
    await expectExchangeError(planner.client, "create_task", taskInput({ acceptanceCriteria: [{ id: "same", description: "one" }, { id: "same", description: "two" }] }), "INVALID_INPUT");
    await expectExchangeError(planner.client, "create_task", taskInput({ sourceRefs: [{ path: "README.md", sha256: "0".repeat(64), startLine: 2 }] }), "INVALID_INPUT");
    await expectExchangeError(planner.client, "create_task", taskInput({ sourceRefs: [{ path: ".env", sha256: "0".repeat(64) }] }), "INVALID_INPUT");
    const taskId = stringField(await call(planner.client, "create_task", taskInput()), "taskId");
    await call(worker.client, "claim_task", { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: randomUUID() });
    await expectExchangeError(worker.client, "submit_report", { ...reportInput(taskId, "completed", 2), criterionResults: [] }, "INVALID_INPUT");
    await expectExchangeError(worker.client, "submit_report", { ...reportInput(taskId, "blocked", 2), questions: [] }, "INVALID_INPUT");
    await expectExchangeError(worker.client, "submit_report", { ...reportInput(taskId, "completed", 2), createdBy: "forged" }, "INVALID_INPUT");
  } finally { await closeAll(planner, worker); }
});

test("a UTF-8 task at the lifecycle byte boundary remains claimable and cancellable across different local limits", async () => {
  const fixture = await makeExchangeFixture({ workerLimits: { maxTaskBytes: 9_216 } });
  const lowerPlannerConfig = await writeConfig(join(fixture.directory, "planner-lower-task-limit.json"), fixture, "planner", "planner-main", fixture.storePath, { maxTaskBytes: 9_216 });
  const planner = await connect(fixture.plannerConfig), worker = await connect(fixture.workerConfig);
  let lowerPlanner: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const boundary = boundaryTaskInput();
    assert.equal(taskLifecycleBytes(representativeTask(boundary)), MAX_TASK_BYTES);
    const claimTaskId = stringField(await call(planner.client, "create_task", { ...boundary, idempotencyKey: randomUUID() }), "taskId");
    const cancelTaskId = stringField(await call(planner.client, "create_task", { ...boundary, idempotencyKey: randomUUID() }), "taskId");
    const claimed = await call(worker.client, "claim_task", { projectId: "project", taskId: claimTaskId, expectedRevision: 1, idempotencyKey: randomUUID() });
    assert.equal(claimed.state, "in_progress");
    await planner.transport.close();
    lowerPlanner = await connect(lowerPlannerConfig);
    const cancellationReason = "Ж".repeat((MAX_CANCEL_REASON_JSON_BYTES - 2) / 2);
    const cancelled = await call(lowerPlanner.client, "cancel_task", { projectId: "project", taskId: cancelTaskId, expectedRevision: 1, idempotencyKey: randomUUID(), reason: cancellationReason });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(((await call(lowerPlanner.client, "get_task", { projectId: "project", taskId: cancelTaskId })).task as Record<string, unknown>).cancelReason, cancellationReason);
  } finally { await closeAll(worker, ...(lowerPlanner ? [lowerPlanner] : [planner])); }
});

test("a legacy queued Task of exactly 32,768 bytes stays readable and unchanged when unsafe transitions are rejected", async () => {
  const fixture = await makeExchangeFixture();
  const initializer = await connect(fixture.plannerConfig);
  await initializer.transport.close();
  const legacyTask = legacyTaskAtSerializedBoundary();
  assert.equal(jsonBytes(legacyTask), MAX_TASK_BYTES);
  insertLegacyTask(fixture.storePath, legacyTask);
  const planner = await connect(fixture.plannerConfig), worker = await connect(fixture.workerConfig);
  try {
    const before = storageRecord(fixture.storePath, legacyTask.taskId);
    const read = await call(planner.client, "get_task", { projectId: "project", taskId: legacyTask.taskId });
    assert.equal(jsonBytes(read.task), MAX_TASK_BYTES);
    const claimKey = randomUUID();
    const claimError = await expectExchangeError(worker.client, "claim_task", { projectId: "project", taskId: legacyTask.taskId, expectedRevision: 1, idempotencyKey: claimKey }, "INVALID_STATE");
    assert.match(String(claimError.message), /predates lifecycle-size reservation/);
    const cancelKey = randomUUID();
    const cancelError = await expectExchangeError(planner.client, "cancel_task", { projectId: "project", taskId: legacyTask.taskId, expectedRevision: 1, idempotencyKey: cancelKey, reason: "cancel safely" }, "INVALID_STATE");
    assert.match(String(cancelError.message), /offline recovery procedure/);
    assert.deepEqual(storageRecord(fixture.storePath, legacyTask.taskId), before, "failed compatibility transitions must preserve entity bytes, state, events and idempotency rows");
    assert.equal(idempotencyKeyExists(fixture.storePath, "worker-main", "claim_task", claimKey), false);
    assert.equal(idempotencyKeyExists(fixture.storePath, "planner-main", "cancel_task", cancelKey), false);
  } finally { await closeAll(planner, worker); }
});

test("cancellation reason JSON-byte boundaries cover ASCII, Cyrillic and escaping without partial effects", async () => {
  const fixture = await makeExchangeFixture();
  const planner = await connect(fixture.plannerConfig);
  try {
    for (const reason of ["x".repeat(8_000), "Ж".repeat(4_000), "\n".repeat(4_000)]) {
      assert.equal(jsonBytes(reason), MAX_CANCEL_REASON_JSON_BYTES);
      const taskId = stringField(await call(planner.client, "create_task", taskInput()), "taskId");
      assert.equal((await call(planner.client, "cancel_task", { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: randomUUID(), reason })).state, "cancelled");
    }
    for (const reason of ["Ж".repeat(4_001), "\n".repeat(4_001)]) {
      assert.equal(jsonBytes(reason), MAX_CANCEL_REASON_JSON_BYTES + 2);
      const taskId = stringField(await call(planner.client, "create_task", taskInput()), "taskId");
      const key = randomUUID();
      const before = storageRecord(fixture.storePath, taskId);
      await expectExchangeError(planner.client, "cancel_task", { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: key, reason }, "LIMIT_EXCEEDED");
      assert.deepEqual(storageRecord(fixture.storePath, taskId), before, "rejected reason must not change state, append an event, or reserve its key");
      assert.equal(idempotencyKeyExists(fixture.storePath, "planner-main", "cancel_task", key), false);
      assert.equal((await call(planner.client, "cancel_task", { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: key, reason: "ok" })).state, "cancelled");
      assert.equal(idempotencyKeyExists(fixture.storePath, "planner-main", "cancel_task", key), true);
    }
  } finally { await planner.transport.close(); }
});

test("incompatible response limits are rejected and oversized Report or Review leaves no partial records", async () => {
  const fixture = await makeExchangeFixture({ plannerLimits: { maxReviewBytes: 400 }, workerLimits: { maxReportBytes: 800 } });
  const incompatible = await writeConfig(join(fixture.directory, "incompatible-response.json"), fixture, "planner", "planner-response-small", fixture.storePath, { maxResponseBytes: 700 });
  await assert.rejects(() => loadConfig(incompatible), /65600|65,600|greater than or equal/i);
  const planner = await connect(fixture.plannerConfig), worker = await connect(fixture.workerConfig);
  try {
    const taskId = stringField(await call(planner.client, "create_task", taskInput()), "taskId");
    await call(worker.client, "claim_task", { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: randomUUID() });
    const reportKey = randomUUID();
    await expectExchangeError(worker.client, "submit_report", { ...reportInput(taskId, "completed", 2, reportKey), summary: "Ж".repeat(1_000) }, "LIMIT_EXCEEDED");
    const afterReportFailure = await call(planner.client, "get_task", { projectId: "project", taskId });
    assert.equal((afterReportFailure.task as Record<string, unknown>).state, "in_progress");
    assert.equal(afterReportFailure.reportId, undefined);
    const reported = await call(worker.client, "submit_report", reportInput(taskId, "completed", 2, reportKey));
    const reportId = stringField(reported, "reportId");
    const reviewKey = randomUUID();
    await expectExchangeError(planner.client, "review_report", { projectId: "project", taskId, reportId, expectedRevision: 3, idempotencyKey: reviewKey, decision: "accepted", comment: "Ж".repeat(1_000) }, "LIMIT_EXCEEDED");
    const afterReviewFailure = await call(planner.client, "get_task", { projectId: "project", taskId });
    assert.equal((afterReviewFailure.task as Record<string, unknown>).state, "reported");
    assert.equal(afterReviewFailure.review, undefined);
    const reviewed = await call(planner.client, "review_report", { projectId: "project", taskId, reportId, expectedRevision: 3, idempotencyKey: reviewKey, decision: "accepted", comment: "ok" });
    assert.equal(reviewed.state, "accepted", "a pre-commit size rejection must not reserve the idempotency key");
  } finally { await closeAll(planner, worker); }
});

test("get_task returns only coherent snapshots while reports and reviews commit concurrently", async () => {
  const fixture = await makeExchangeFixture();
  const planner = await connect(fixture.plannerConfig), reader = await connect(fixture.plannerConfig), worker = await connect(fixture.workerConfig);
  try {
    const taskIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      const taskId = stringField(await call(planner.client, "create_task", taskInput({ title: `snapshot-${index}` })), "taskId");
      await call(worker.client, "claim_task", { projectId: "project", taskId, expectedRevision: 1, idempotencyKey: randomUUID() });
      taskIds.push(taskId);
    }
    const reports = new Map<string, string>();
    for (const taskId of taskIds) {
      const mutation = call(worker.client, "submit_report", reportInput(taskId, "completed", 2));
      const reads = Promise.all(Array.from({ length: 6 }, () => call(reader.client, "get_task", { projectId: "project", taskId })));
      const [reported, snapshots] = await Promise.all([mutation, reads]);
      reports.set(taskId, stringField(reported, "reportId"));
      for (const snapshot of snapshots) assertCoherentTaskSnapshot(snapshot);
    }
    for (const taskId of taskIds) {
      const reportId = reports.get(taskId)!;
      const mutation = call(planner.client, "review_report", { projectId: "project", taskId, reportId, expectedRevision: 3, idempotencyKey: randomUUID(), decision: "accepted", comment: "snapshot accepted" });
      const reads = Promise.all(Array.from({ length: 6 }, () => call(reader.client, "get_task", { projectId: "project", taskId })));
      const [, snapshots] = await Promise.all([mutation, reads]);
      for (const snapshot of snapshots) assertCoherentTaskSnapshot(snapshot);
      assertCoherentTaskSnapshot(await call(reader.client, "get_task", { projectId: "project", taskId }));
    }
  } finally { await closeAll(planner, reader, worker); }
});

test("byte and history limits, busy storage, schema version and path placement fail safely", async () => {
  const fixture = await makeExchangeFixture({ plannerLimits: { maxTaskBytes: 10_000, maxTasks: 1, busyTimeoutMs: 0 } });
  const planner = await connect(fixture.plannerConfig);
  try {
    await expectExchangeError(planner.client, "create_task", taskInput({ objective: "x".repeat(3_000) }), "LIMIT_EXCEEDED");
    await call(planner.client, "create_task", taskInput());
    await expectExchangeError(planner.client, "create_task", taskInput(), "LIMIT_EXCEEDED");
    const locker = new Database(fixture.storePath); locker.exec("BEGIN IMMEDIATE");
    try { await expectExchangeError(planner.client, "create_task", taskInput(), "STORAGE_BUSY"); }
    finally { locker.exec("ROLLBACK"); locker.close(); }
  } finally { await planner.transport.close(); }

  const roleConflictConfig = await writeConfig(join(fixture.directory, "role-conflict.json"), fixture, "worker", "planner-main", fixture.storePath);
  const roleConflict = await loadConfig(roleConflictConfig);
  assert.throws(() => createServer(roleConflict), /conflicting role/);

  const historyFixture = await makeExchangeFixture({ plannerLimits: { maxHistoryBytes: 1 } });
  const historyPlanner = await connect(historyFixture.plannerConfig);
  try {
    await expectExchangeError(historyPlanner.client, "create_task", taskInput(), "LIMIT_EXCEEDED");
    assert.deepEqual((await call(historyPlanner.client, "list_tasks", { projectId: "project" })).tasks, [], "quota failure must roll back all writes");
  } finally { await historyPlanner.transport.close(); }

  const unavailableFixture = await makeExchangeFixture();
  const unavailablePlanner = await connect(unavailableFixture.plannerConfig);
  try {
    const breaker = new Database(unavailableFixture.storePath); breaker.exec("DROP TABLE tasks"); breaker.close();
    await expectExchangeError(unavailablePlanner.client, "list_tasks", { projectId: "project" }, "STORAGE_UNAVAILABLE");
  } finally { await unavailablePlanner.transport.close(); }

  const invalidConfig = await writeConfig(join(fixture.directory, "inside.json"), fixture, "planner", "planner-main", join(fixture.projectRoot, "exchange.sqlite"));
  await assert.rejects(() => loadConfig(invalidConfig), /outside every project root/);
  const traversalConfig = await writeConfig(join(fixture.directory, "traversal.json"), fixture, "planner", "planner-main", `${fixture.directory}\\exchange-data\\..\\traversed.sqlite`);
  await assert.rejects(() => loadConfig(traversalConfig), /without traversal/);
  const linkTarget = join(fixture.directory, "link-target"), linkPath = join(fixture.directory, "storage-link");
  await mkdir(linkTarget);
  try {
    await symlink(linkTarget, linkPath, "junction");
    const linkConfig = await writeConfig(join(fixture.directory, "link.json"), fixture, "planner", "planner-main", join(linkPath, "exchange.sqlite"));
    await assert.rejects(() => loadConfig(linkConfig), /link\/reparse point/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }

  const unknownStore = join(fixture.directory, "unknown.sqlite");
  const raw = new Database(unknownStore); raw.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('schema_version','99')"); raw.close();
  const unknownConfig = await writeConfig(join(fixture.directory, "unknown.json"), fixture, "planner", "planner-unknown", unknownStore);
  const loaded = await loadConfig(unknownConfig);
  assert.throws(() => createServer(loaded), /schema version is not supported/);
});

function exchangeTools(result: Awaited<ReturnType<Client["listTools"]>>) { return result.tools.map(tool => tool.name).filter(name => ["create_task", "list_tasks", "get_task", "claim_task", "submit_report", "get_report", "review_report", "cancel_task"].includes(name)).sort(); }
function taskInput(overrides: Record<string, unknown> = {}): Record<string, unknown> { return { projectId: "project", idempotencyKey: randomUUID(), title: "Safe task", objective: "Document the result.", scope: { wholeProject: true, allowedPaths: [], outOfScope: [] }, constraints: ["Do not publish."], acceptanceCriteria: [{ id: "criterion-1", description: "A result is documented." }], sourceRefs: [], ...overrides }; }
function completedReport(taskId: string, idempotencyKey: string, expectedRevision: number): Record<string, unknown> { return reportInput(taskId, "completed", expectedRevision, idempotencyKey); }
function reportInput(taskId: string, outcome: "completed" | "blocked" | "failed", expectedRevision: number, idempotencyKey: string = randomUUID()): Record<string, unknown> { return { projectId: "project", taskId, expectedRevision, idempotencyKey, outcome, summary: "Final report; do not execute: powershell touch forbidden-marker.", changes: [], checks: [{ description: "Inspection only", status: "not_run", evidence: "Not run." }], criterionResults: [{ criterionId: "criterion-1", status: outcome === "completed" ? "met" : "not_verified", evidence: "Worker statement." }], limitations: outcome === "blocked" ? ["A required condition is absent."] : [], questions: outcome === "blocked" ? ["Provide the missing condition."] : [] }; }

async function makeExchangeFixture(options: { plannerLimits?: Record<string, number>; workerLimits?: Record<string, number> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-tunnel-exchange-")); temporaryDirectories.push(directory);
  const projectRoot = join(directory, "project"), storePath = join(directory, "exchange-data", "exchange.sqlite"), probe = join(directory, "probe.txt");
  await mkdir(projectRoot); await writeFile(join(projectRoot, "README.md"), "fixture\n", "utf8"); await writeFile(probe, "probe\n", "utf8");
  const fixture = { directory, projectRoot, storePath, probe, initialDigest: "" };
  const plannerConfig = await writeConfig(join(directory, "planner.json"), fixture, "planner", "planner-main", storePath, options.plannerLimits);
  const plannerBConfig = await writeConfig(join(directory, "planner-b.json"), fixture, "planner", "planner-other", storePath);
  const workerConfig = await writeConfig(join(directory, "worker.json"), fixture, "worker", "worker-main", storePath, options.workerLimits);
  const workerBConfig = await writeConfig(join(directory, "worker-b.json"), fixture, "worker", "worker-other", storePath);
  fixture.initialDigest = await projectDigest(projectRoot);
  return { ...fixture, plannerConfig, plannerBConfig, workerConfig, workerBConfig };
}
async function writeConfig(path: string, fixture: { projectRoot: string; probe: string }, role: "planner" | "worker", principalId: string, storePath: string, limits?: Record<string, number>) {
  const config = { deviceId: `device-${principalId}`, probeFile: fixture.probe, projects: [{ projectId: "project", name: "Project", description: "fixture", root: fixture.projectRoot, readOnly: true, excludePaths: [], entryDocuments: [{ label: "README", path: "README.md" }] }], exchange: { enabled: true, storePath, principalId, role, allowedProjectIds: ["project"], ...(limits ? { limits } : {}) } };
  await writeFile(path, JSON.stringify(config), "utf8"); return path;
}
async function projectDigest(root: string) { const content = await readFile(join(root, "README.md")); return createHash("sha256").update(content).digest("hex"); }
async function connect(config: string) { const transport = new StdioClientTransport({ command: process.execPath, args: [join(repositoryRoot, "dist/src/index.js"), "--config", config], stderr: "pipe" }); let stderr = ""; transport.stderr?.on("data", chunk => { stderr += String(chunk); }); const client = new Client({ name: "exchange-integration-test", version: "1.0.0" }); await client.connect(transport); return { client, transport, stderrText: () => stderr }; }
async function closeAll(...sessions: Array<{ transport: StdioClientTransport }>) { await Promise.all(sessions.map(session => session.transport.close().catch(() => undefined))); }
async function call(client: Client, name: string, args: Record<string, unknown>) { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent as Record<string, unknown>; }
async function expectExchangeError(client: Client, name: string, args: Record<string, unknown>, code: string) { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, true); const content = result.content as Array<{ text?: string }>; const text = content[0]?.text ?? ""; const parsed = JSON.parse(text) as Record<string, unknown>; assert.equal(parsed.code, code); assert.equal(typeof parsed.correlationId, "string"); assert.equal(typeof parsed.retryable, "boolean"); assert.equal(text.includes("sqlite"), false); return parsed; }
function stringField(value: Record<string, unknown>, field: string) { assert.equal(typeof value[field], "string"); return value[field] as string; }

function boundaryTaskInput(): Record<string, unknown> {
  const input = taskInput({ objective: "x", constraints: ["x"] });
  const textTargets: Array<{ get: () => string; set: (value: string) => void }> = [
    { get: () => input.objective as string, set: value => { input.objective = value; } },
    { get: () => (input.constraints as string[])[0]!, set: value => { (input.constraints as string[])[0] = value; } }
  ];
  for (const target of textTargets) {
    let remaining = MAX_TASK_BYTES - taskLifecycleBytes(representativeTask(input));
    if (remaining <= 0) break;
    const current = target.get();
    const capacity = 8_000 - current.length;
    if (remaining % 2 === 1 && capacity > 0) { target.set(`${current}a`); remaining--; }
    const unicodeCount = Math.min(Math.floor(remaining / 2), 8_000 - target.get().length);
    target.set(`${target.get()}${"Ж".repeat(unicodeCount)}`);
  }
  assert.equal(taskLifecycleBytes(representativeTask(input)), MAX_TASK_BYTES);
  return input;
}

function representativeTask(input: Record<string, unknown>): Task {
  return {
    schemaVersion: 1,
    taskId: "00000000-0000-4000-8000-000000000000",
    projectId: input.projectId as string,
    createdAt: "2026-09-10T00:00:00.000Z",
    createdBy: "planner-main",
    revision: 1,
    state: "queued",
    title: input.title as string,
    objective: input.objective as string,
    scope: input.scope as Task["scope"],
    constraints: input.constraints as string[],
    acceptanceCriteria: input.acceptanceCriteria as Task["acceptanceCriteria"],
    sourceRefs: input.sourceRefs as Task["sourceRefs"]
  };
}

function legacyTaskAtSerializedBoundary(): Task {
  const task = representativeTask(taskInput({ objective: "x", constraints: ["x"] }));
  const targets: Array<{ get: () => string; set: (value: string) => void }> = [
    { get: () => task.objective, set: value => { task.objective = value; } },
    { get: () => task.constraints[0]!, set: value => { task.constraints[0] = value; } },
    { get: () => task.acceptanceCriteria[0]!.description, set: value => { task.acceptanceCriteria[0]!.description = value; } }
  ];
  padJsonToBytes(task, targets, MAX_TASK_BYTES);
  assert.equal(jsonBytes(task), MAX_TASK_BYTES);
  return task;
}

function padJsonToBytes(value: unknown, targets: Array<{ get: () => string; set: (value: string) => void }>, targetBytes: number): void {
  for (const target of targets) {
    let remaining = targetBytes - jsonBytes(value);
    if (remaining <= 0) break;
    if (remaining % 2 === 1 && target.get().length < 8_000) { target.set(`${target.get()}a`); remaining--; }
    const count = Math.min(Math.floor(remaining / 2), 8_000 - target.get().length);
    target.set(`${target.get()}${"Ж".repeat(count)}`);
  }
}

function insertLegacyTask(storePath: string, task: Task): void {
  const db = new Database(storePath);
  try {
    db.pragma("foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO tasks(task_id, project_id, created_at, created_by, revision, state, title, claimed_by, parent_task_id, entity_json)
      VALUES (?, ?, ?, ?, 1, 'queued', ?, NULL, NULL, ?)`).run(task.taskId, task.projectId, task.createdAt, task.createdBy, task.title, JSON.stringify(task));
    db.prepare(`INSERT INTO events(event_type, principal_id, project_id, task_id, created_at, revision)
      VALUES ('task_created', ?, ?, ?, ?, 1)`).run(task.createdBy, task.projectId, task.taskId, task.createdAt);
    db.prepare(`INSERT INTO idempotency(principal_id, tool, idempotency_key, project_id, payload_hash, result_json, created_at)
      VALUES (?, 'create_task', ?, ?, ?, ?, ?)`).run(task.createdBy, "11111111-1111-4111-8111-111111111111", task.projectId, "0".repeat(64), JSON.stringify({ taskId: task.taskId, state: "queued", revision: 1, createdAt: task.createdAt }), task.createdAt);
    db.exec("COMMIT");
  } catch (error) { if (db.inTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
}

function storageRecord(storePath: string, taskId: string): Record<string, unknown> {
  const db = new Database(storePath, { readonly: true });
  try {
    const task = db.prepare("SELECT state, revision, hex(CAST(entity_json AS BLOB)) AS entity_hex FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown>;
    const events = db.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id = ?").get(taskId) as { count: number };
    const keys = db.prepare("SELECT COUNT(*) AS count FROM idempotency WHERE result_json LIKE ?").get(`%${taskId}%`) as { count: number };
    return { ...task, events: events.count, keys: keys.count };
  } finally { db.close(); }
}

function idempotencyKeyExists(storePath: string, principalId: string, tool: string, key: string): boolean {
  const db = new Database(storePath, { readonly: true });
  try {
    return db.prepare("SELECT 1 FROM idempotency WHERE principal_id = ? AND tool = ? AND idempotency_key = ?")
      .get(principalId, tool, key) !== undefined;
  } finally { db.close(); }
}

function assertCoherentTaskSnapshot(result: Record<string, unknown>): void {
  const task = result.task as Record<string, unknown>;
  const state = task.state;
  const hasReport = typeof result.reportId === "string";
  const hasReview = result.review !== undefined;
  if (state === "queued" || state === "in_progress" || state === "cancelled") { assert.equal(hasReport, false); assert.equal(hasReview, false); }
  else if (state === "reported") { assert.equal(hasReport, true); assert.equal(hasReview, false); }
  else if (state === "accepted" || state === "changes_requested") { assert.equal(hasReport, true); assert.equal(hasReview, true); }
  else assert.fail(`unexpected task state: ${String(state)}`);
}
