import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { ExchangeConfig } from "../config.js";
import type { Report, Review, Task } from "./schemas.js";
import { MAX_TASK_BYTES, cancelledTask, claimedTaskLifecycleBytes, jsonBytes } from "./limits.js";

export type ExchangeErrorCode = "NOT_FOUND" | "FORBIDDEN" | "INVALID_INPUT" | "CONFLICT" | "INVALID_STATE" | "IDEMPOTENCY_CONFLICT" | "LIMIT_EXCEEDED" | "STORAGE_BUSY" | "STORAGE_UNAVAILABLE";
export class ExchangeError extends Error {
  constructor(public readonly code: ExchangeErrorCode, message: string, public readonly retryable = false) { super(message); this.name = "ExchangeError"; }
}

type MutationEvent = { type: string; projectId: string; taskId?: string; reportId?: string; reviewId?: string; revision?: number };
type MutationResult<T> = { result: T; event: MutationEvent };
type TaskRow = { entity_json: string };
type ReportRow = { entity_json: string };

export class ExchangeStore {
  private db!: Database.Database;
  constructor(private readonly config: ExchangeConfig) {
    try {
      this.db = new Database(config.storePath);
      this.db.pragma(`busy_timeout = ${config.limits.busyTimeoutMs}`);
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.initializeSchema();
      this.registerPrincipal();
    } catch (error) {
      try { this.db?.close(); } catch { /* startup is already failing safely */ }
      throw storageError(error);
    }
  }

  close(): void { this.db.close(); }

  getIdempotent<T extends Record<string, unknown>>(tool: string, key: string, payload: unknown): T | undefined {
    return this.read(() => {
      const prior = this.db.prepare("SELECT payload_hash, result_json FROM idempotency WHERE principal_id = ? AND tool = ? AND idempotency_key = ?")
        .get(this.config.principalId, tool, key) as { payload_hash: string; result_json: string } | undefined;
      if (!prior) return undefined;
      if (prior.payload_hash !== hashPayload(payload)) throw new ExchangeError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different input.");
      return parseJson<T>(prior.result_json);
    });
  }

  createTask(task: Task, idempotencyKey: string, payload: unknown): Record<string, unknown> {
    return this.mutate("create_task", idempotencyKey, payload, () => {
      if (task.parentTaskId) {
        const parent = this.db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND project_id = ?").get(task.parentTaskId, task.projectId);
        if (!parent) throw new ExchangeError("NOT_FOUND", "The referenced task was not found.");
      }
      const count = Number((this.db.prepare("SELECT COUNT(*) AS value FROM tasks").get() as { value: number }).value);
      if (count >= this.config.limits.maxTasks) throw new ExchangeError("LIMIT_EXCEEDED", "The exchange task quota has been reached.");
      this.db.prepare(`INSERT INTO tasks(task_id, project_id, created_at, created_by, revision, state, title, claimed_by, parent_task_id, entity_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(task.taskId, task.projectId, task.createdAt, task.createdBy, task.revision, task.state, task.title, task.parentTaskId ?? null, JSON.stringify(task));
      const result = { taskId: task.taskId, state: task.state, revision: task.revision, createdAt: task.createdAt };
      return { result, event: { type: "task_created", projectId: task.projectId, taskId: task.taskId, revision: task.revision } };
    });
  }

  getTask(projectId: string, taskId: string): { task: Task; reportId?: string; review?: Review } {
    return this.read(() => {
      const row = this.db.prepare(`SELECT t.entity_json AS task_json, r.report_id, v.entity_json AS review_json
        FROM tasks t
        LEFT JOIN reports r ON r.task_id = t.task_id AND r.project_id = t.project_id
        LEFT JOIN reviews v ON v.report_id = r.report_id AND v.project_id = r.project_id
        WHERE t.task_id = ? AND t.project_id = ?`).get(taskId, projectId) as { task_json: string; report_id: string | null; review_json: string | null } | undefined;
      if (!row) throw new ExchangeError("NOT_FOUND", "The task was not found.");
      return { task: parseJson<Task>(row.task_json), ...(row.report_id ? { reportId: row.report_id } : {}), ...(row.review_json ? { review: parseJson<Review>(row.review_json) } : {}) };
    });
  }

  getReport(projectId: string, reportId: string): Report {
    return this.read(() => {
      const row = this.db.prepare("SELECT entity_json FROM reports WHERE report_id = ? AND project_id = ?").get(reportId, projectId) as ReportRow | undefined;
      if (!row) throw new ExchangeError("NOT_FOUND", "The report was not found.");
      return parseJson<Report>(row.entity_json);
    });
  }

  listTasks(projectId: string, states: readonly string[] | undefined, cursor: string | undefined, requestedLimit: number | undefined) {
    return this.read(() => {
      const normalizedStates = states ? [...new Set(states)].sort() : [];
      const after = decodeCursor(cursor, projectId, normalizedStates);
      const limit = Math.min(requestedLimit ?? this.config.limits.defaultListLimit, this.config.limits.maxListLimit);
      const stateSql = normalizedStates.length ? ` AND t.state IN (${normalizedStates.map(() => "?").join(",")})` : "";
      const afterSql = after ? " AND (t.created_at > ? OR (t.created_at = ? AND t.task_id > ?))" : "";
      const parameters: unknown[] = [projectId, ...normalizedStates];
      if (after) parameters.push(after.createdAt, after.createdAt, after.taskId);
      parameters.push(limit + 1);
      const rows = this.db.prepare(`SELECT t.task_id, t.title, t.state, t.revision, t.created_at, t.claimed_by, r.report_id
        FROM tasks t LEFT JOIN reports r ON r.task_id = t.task_id
        WHERE t.project_id = ?${stateSql}${afterSql}
        ORDER BY t.created_at, t.task_id LIMIT ?`).all(...parameters) as Array<Record<string, unknown>>;
      const cards: Array<Record<string, unknown>> = [];
      let byteLimited = false;
      for (const row of rows.slice(0, limit)) {
        const card = { taskId: row.task_id, title: row.title, state: row.state, revision: row.revision, createdAt: row.created_at,
          ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}), ...(row.report_id ? { reportId: row.report_id } : {}) };
        const potentialCursor = encodeCursor(projectId, normalizedStates, String(card.createdAt), String(card.taskId));
        if (Buffer.byteLength(JSON.stringify({ tasks: [...cards, card], nextCursor: potentialCursor }), "utf8") > this.config.limits.maxResponseBytes) { byteLimited = true; break; }
        cards.push(card);
      }
      const more = rows.length > cards.length || byteLimited;
      const last = cards.at(-1);
      if (more && !last) throw new ExchangeError("LIMIT_EXCEEDED", "The response byte limit is too small for one task card.");
      return { tasks: cards, nextCursor: more && last ? encodeCursor(projectId, normalizedStates, String(last.createdAt), String(last.taskId)) : null };
    });
  }

  claimTask(task: Task, idempotencyKey: string, payload: unknown): Record<string, unknown> {
    return this.mutate("claim_task", idempotencyKey, payload, () => {
      const current = this.requireTask(task.projectId, task.taskId);
      assertRevisionAndState(current, task.revision, "queued");
      const claimedAt = new Date().toISOString();
      if (claimedTaskLifecycleBytes(current, this.config.principalId, claimedAt) > MAX_TASK_BYTES) throw legacyTaskError();
      const next: Task = { ...current, revision: current.revision + 1, state: "in_progress", claimedBy: this.config.principalId, claimedAt };
      this.updateTask(next, current.revision, "queued");
      const result = { taskId: next.taskId, state: next.state, revision: next.revision, claimedBy: this.config.principalId };
      return { result, event: { type: "task_claimed", projectId: next.projectId, taskId: next.taskId, revision: next.revision } };
    });
  }

  submitReport(report: Report, expectedRevision: number, idempotencyKey: string, payload: unknown): Record<string, unknown> {
    return this.mutate("submit_report", idempotencyKey, payload, () => {
      const current = this.requireTask(report.projectId, report.taskId);
      assertRevisionAndState(current, expectedRevision, "in_progress");
      if (current.claimedBy !== this.config.principalId) throw new ExchangeError("FORBIDDEN", "This worker does not own the task claim.");
      const next: Task = { ...current, revision: current.revision + 1, state: "reported" };
      this.db.prepare(`INSERT INTO reports(report_id, task_id, project_id, created_at, created_by, outcome, entity_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(report.reportId, report.taskId, report.projectId, report.createdAt, report.createdBy, report.outcome, JSON.stringify(report));
      this.updateTask(next, current.revision, "in_progress");
      const result = { reportId: report.reportId, taskId: report.taskId, state: next.state, revision: next.revision };
      return { result, event: { type: "report_submitted", projectId: next.projectId, taskId: next.taskId, reportId: report.reportId, revision: next.revision } };
    });
  }

  reviewReport(projectId: string, review: Review, expectedRevision: number, idempotencyKey: string, payload: unknown): Record<string, unknown> {
    return this.mutate("review_report", idempotencyKey, payload, () => {
      const current = this.requireTask(projectId, review.taskId);
      assertRevisionAndState(current, expectedRevision, "reported");
      if (current.createdBy !== this.config.principalId) throw new ExchangeError("FORBIDDEN", "Only the task creator may review its report.");
      const report = this.db.prepare("SELECT outcome FROM reports WHERE report_id = ? AND task_id = ? AND project_id = ?").get(review.reportId, review.taskId, current.projectId) as { outcome: string } | undefined;
      if (!report) throw new ExchangeError("NOT_FOUND", "The report was not found.");
      if (review.decision === "accepted" && report.outcome !== "completed") throw new ExchangeError("INVALID_STATE", "Only a completed report can be accepted.");
      const next: Task = { ...current, revision: current.revision + 1, state: review.decision };
      this.db.prepare(`INSERT INTO reviews(review_id, task_id, report_id, project_id, created_at, created_by, decision, entity_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(review.reviewId, review.taskId, review.reportId, current.projectId, review.createdAt, review.createdBy, review.decision, JSON.stringify(review));
      this.updateTask(next, current.revision, "reported");
      const result = { reviewId: review.reviewId, taskId: review.taskId, state: next.state, revision: next.revision };
      return { result, event: { type: "report_reviewed", projectId: next.projectId, taskId: next.taskId, reportId: review.reportId, reviewId: review.reviewId, revision: next.revision } };
    });
  }

  cancelTask(projectId: string, taskId: string, expectedRevision: number, reason: string, idempotencyKey: string, payload: unknown): Record<string, unknown> {
    return this.mutate("cancel_task", idempotencyKey, payload, () => {
      const current = this.requireTask(projectId, taskId);
      assertRevisionAndState(current, expectedRevision, "queued");
      if (current.createdBy !== this.config.principalId) throw new ExchangeError("FORBIDDEN", "Only the task creator may cancel it.");
      const next = cancelledTask(current, reason);
      if (jsonBytes(next) > MAX_TASK_BYTES) throw legacyTaskError();
      this.updateTask(next, current.revision, "queued");
      const result = { taskId, state: next.state, revision: next.revision };
      return { result, event: { type: "task_cancelled", projectId, taskId, revision: next.revision } };
    });
  }

  private initializeSchema(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const version = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (version && version.value !== "1") throw new ExchangeError("STORAGE_UNAVAILABLE", "The exchange storage schema version is not supported.");
    if (version) return;
    const transaction = this.db.transaction(() => {
      const concurrentVersion = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (concurrentVersion?.value === "1") return;
      if (concurrentVersion) throw new ExchangeError("STORAGE_UNAVAILABLE", "The exchange storage schema version is not supported.");
      this.db.exec(`
        CREATE TABLE principals (principal_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('planner','worker')));
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0), state TEXT NOT NULL, title TEXT NOT NULL, claimed_by TEXT,
          parent_task_id TEXT, entity_json TEXT NOT NULL, UNIQUE(task_id, project_id),
          FOREIGN KEY(parent_task_id) REFERENCES tasks(task_id)
        );
        CREATE INDEX tasks_project_order ON tasks(project_id, created_at, task_id);
        CREATE INDEX tasks_project_state_order ON tasks(project_id, state, created_at, task_id);
        CREATE TABLE reports (
          report_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, created_at TEXT NOT NULL,
          created_by TEXT NOT NULL, outcome TEXT NOT NULL, entity_json TEXT NOT NULL, UNIQUE(report_id, project_id),
          FOREIGN KEY(task_id, project_id) REFERENCES tasks(task_id, project_id)
        );
        CREATE TABLE reviews (
          review_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, report_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
          created_at TEXT NOT NULL, created_by TEXT NOT NULL, decision TEXT NOT NULL, entity_json TEXT NOT NULL,
          FOREIGN KEY(task_id, project_id) REFERENCES tasks(task_id, project_id),
          FOREIGN KEY(report_id, project_id) REFERENCES reports(report_id, project_id)
        );
        CREATE TABLE events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
          task_id TEXT, report_id TEXT, review_id TEXT, created_at TEXT NOT NULL, revision INTEGER
        );
        CREATE TABLE idempotency (
          principal_id TEXT NOT NULL, tool TEXT NOT NULL, idempotency_key TEXT NOT NULL, project_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(principal_id, tool, idempotency_key)
        );
        INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1');
      `);
    });
    transaction.immediate();
  }

  private registerPrincipal(): void {
    this.db.prepare("INSERT INTO principals(principal_id, role) VALUES (?, ?) ON CONFLICT(principal_id) DO NOTHING").run(this.config.principalId, this.config.role);
    const existing = this.db.prepare("SELECT role FROM principals WHERE principal_id = ?").get(this.config.principalId) as { role: string };
    if (existing.role !== this.config.role) throw new ExchangeError("STORAGE_UNAVAILABLE", "The configured principal has a conflicting role in this exchange store.");
  }

  private requireTask(projectId: string, taskId: string): Task {
    const row = this.db.prepare("SELECT entity_json FROM tasks WHERE task_id = ? AND project_id = ?").get(taskId, projectId) as TaskRow | undefined;
    if (!row) throw new ExchangeError("NOT_FOUND", "The task was not found.");
    return parseJson<Task>(row.entity_json);
  }

  private updateTask(task: Task, previousRevision: number, previousState: string): void {
    if (jsonBytes(task) > MAX_TASK_BYTES) throw legacyTaskError();
    const changed = this.db.prepare("UPDATE tasks SET revision = ?, state = ?, claimed_by = ?, entity_json = ? WHERE task_id = ? AND project_id = ? AND revision = ? AND state = ?")
      .run(task.revision, task.state, task.claimedBy ?? null, JSON.stringify(task), task.taskId, task.projectId, previousRevision, previousState);
    if (changed.changes !== 1) throw new ExchangeError("CONFLICT", "The task revision changed; read it again before retrying.");
  }

  private mutate<T extends Record<string, unknown>>(tool: string, key: string, payload: unknown, operation: () => MutationResult<T>): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const hash = hashPayload(payload);
      const prior = this.db.prepare("SELECT payload_hash, result_json FROM idempotency WHERE principal_id = ? AND tool = ? AND idempotency_key = ?")
        .get(this.config.principalId, tool, key) as { payload_hash: string; result_json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== hash) throw new ExchangeError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different input.");
        const result = parseJson<T>(prior.result_json);
        this.db.exec("COMMIT");
        return result;
      }
      const { result, event } = operation();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO events(event_type, principal_id, project_id, task_id, report_id, review_id, created_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.type, this.config.principalId, event.projectId, event.taskId ?? null, event.reportId ?? null, event.reviewId ?? null, now, event.revision ?? null);
      this.db.prepare(`INSERT INTO idempotency(principal_id, tool, idempotency_key, project_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(this.config.principalId, tool, key, event.projectId, hash, JSON.stringify(result), now);
      this.enforceHistoryQuota();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.inTransaction) try { this.db.exec("ROLLBACK"); } catch { /* preserve original safe error */ }
      if (error instanceof ExchangeError) throw error;
      throw storageError(error);
    }
  }

  private enforceHistoryQuota(): void {
    const row = this.db.prepare(`SELECT
      COALESCE((SELECT SUM(length(CAST(entity_json AS BLOB))) FROM tasks),0) +
      COALESCE((SELECT SUM(length(CAST(entity_json AS BLOB))) FROM reports),0) +
      COALESCE((SELECT SUM(length(CAST(entity_json AS BLOB))) FROM reviews),0) +
      COALESCE((SELECT SUM(length(CAST(payload_hash AS BLOB))) + SUM(length(CAST(result_json AS BLOB))) FROM idempotency),0) +
      COALESCE((SELECT SUM(length(event_type)+length(principal_id)+length(project_id)+COALESCE(length(task_id),0)+COALESCE(length(report_id),0)+COALESCE(length(review_id),0)+length(created_at)+16) FROM events),0)
      AS value`).get() as { value: number };
    if (Number(row.value) > this.config.limits.maxHistoryBytes) throw new ExchangeError("LIMIT_EXCEEDED", "The exchange history quota has been reached.");
  }

  private read<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) { if (error instanceof ExchangeError) throw error; throw storageError(error); }
  }
}

function assertRevisionAndState(task: Task, expectedRevision: number, state: Task["state"]): void {
  if (task.revision !== expectedRevision) throw new ExchangeError("CONFLICT", "The task revision changed; read it again before retrying.");
  if (task.state !== state) throw new ExchangeError("INVALID_STATE", `The task is not in the required '${state}' state.`);
}
function legacyTaskError(): ExchangeError {
  return new ExchangeError("INVALID_STATE", "This task predates lifecycle-size reservation and cannot transition safely; preserve it and follow the documented offline recovery procedure.");
}
function hashPayload(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function parseJson<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw new ExchangeError("STORAGE_UNAVAILABLE", "Exchange storage contains unreadable data."); } }
function storageError(error: unknown): ExchangeError {
  if (error instanceof ExchangeError) return error;
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code.includes("BUSY") || code.includes("LOCKED")) return new ExchangeError("STORAGE_BUSY", "Exchange storage is busy; retry the same request.", true);
  return new ExchangeError("STORAGE_UNAVAILABLE", "Exchange storage is unavailable.", true);
}
function encodeCursor(projectId: string, states: string[], createdAt: string, taskId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, projectId, states, createdAt, taskId }), "utf8").toString("base64url");
}
function decodeCursor(cursor: string | undefined, projectId: string, states: string[]): { createdAt: string; taskId: string } | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.v !== 1 || value.projectId !== projectId || JSON.stringify(value.states) !== JSON.stringify(states) || typeof value.createdAt !== "string" || typeof value.taskId !== "string") throw new Error("invalid");
    return { createdAt: value.createdAt, taskId: value.taskId };
  } catch { throw new ExchangeError("INVALID_INPUT", "The task cursor is invalid for this project or filter."); }
}
