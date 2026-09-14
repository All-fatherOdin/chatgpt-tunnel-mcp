import { randomUUID } from "node:crypto";
import type { AppConfig, ExchangeConfig } from "../config.js";
import { ProjectError, readProjectFile } from "../projects.js";
import type { CancelTaskInput, ClaimTaskInput, CreateTaskInput, ListTasksInput, Report, Review, ReviewReportInput, SubmitReportInput, Task } from "./schemas.js";
import { ExchangeError, ExchangeStore } from "./store.js";
import { MAX_CANCEL_REASON_JSON_BYTES, cancelReasonJsonBytes, jsonBytes, taskLifecycleBytes } from "./limits.js";

export class ExchangeService {
  private readonly exchange: ExchangeConfig;
  private readonly store: ExchangeStore;
  constructor(private readonly appConfig: AppConfig) {
    if (!appConfig.exchange) throw new Error("Exchange is not enabled");
    this.exchange = appConfig.exchange;
    this.store = new ExchangeStore(this.exchange);
  }

  async createTask(input: CreateTaskInput) {
    this.authorize(input.projectId, "planner");
    const prior = this.store.getIdempotent("create_task", input.idempotencyKey, input);
    if (prior) return prior;
    if (input.scope.wholeProject !== true && input.scope.allowedPaths.length === 0) throw new ExchangeError("INVALID_INPUT", "Set wholeProject=true or provide at least one allowed path.");
    if (input.scope.wholeProject === true && input.scope.allowedPaths.length > 0) throw new ExchangeError("INVALID_INPUT", "Allowed paths must be empty when wholeProject=true.");
    assertUnique(input.acceptanceCriteria.map(item => item.id), "Acceptance criterion IDs must be unique.");
    for (const source of input.sourceRefs) {
      if ((source.startLine === undefined) !== (source.endLine === undefined) || (source.startLine !== undefined && source.endLine! < source.startLine)) throw new ExchangeError("INVALID_INPUT", "Source reference line ranges are invalid.");
      try { await readProjectFile(this.appConfig, { projectId: input.projectId, path: source.path, ...(source.startLine ? { startLine: source.startLine, endLine: source.endLine } : {}) }); }
      catch (error) {
        if (error instanceof ProjectError) throw new ExchangeError("INVALID_INPUT", "A source reference is not readable under project policy.");
        throw error;
      }
    }
    const task: Task = {
      schemaVersion: 1, taskId: randomUUID(), projectId: input.projectId, createdAt: new Date().toISOString(), createdBy: this.exchange.principalId,
      revision: 1, state: "queued", ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), title: input.title, objective: input.objective,
      scope: input.scope, constraints: input.constraints, acceptanceCriteria: input.acceptanceCriteria, sourceRefs: input.sourceRefs
    };
    if (taskLifecycleBytes(task) > this.exchange.limits.maxTaskBytes) throw new ExchangeError("LIMIT_EXCEEDED", "Task leaves insufficient space for its lifecycle metadata.");
    assertResponseBytes({ task }, this.exchange.limits.maxResponseBytes);
    return this.store.createTask(task, input.idempotencyKey, input);
  }

  listTasks(input: ListTasksInput) {
    this.authorize(input.projectId);
    return this.store.listTasks(input.projectId, input.states, input.cursor, input.limit);
  }

  getTask(projectId: string, taskId: string) {
    this.authorize(projectId);
    const result = this.store.getTask(projectId, taskId);
    assertResponseBytes(result, this.exchange.limits.maxResponseBytes);
    return result;
  }

  getReport(projectId: string, reportId: string) {
    this.authorize(projectId);
    const result = { report: this.store.getReport(projectId, reportId) };
    assertResponseBytes(result, this.exchange.limits.maxResponseBytes);
    return result;
  }

  claimTask(input: ClaimTaskInput) {
    this.authorize(input.projectId, "worker");
    const prior = this.store.getIdempotent("claim_task", input.idempotencyKey, input);
    if (prior) return prior;
    const task = this.store.getTask(input.projectId, input.taskId).task;
    return this.store.claimTask({ ...task, revision: input.expectedRevision }, input.idempotencyKey, input);
  }

  submitReport(input: SubmitReportInput) {
    this.authorize(input.projectId, "worker");
    const task = this.store.getTask(input.projectId, input.taskId).task;
    if (task.claimedBy !== this.exchange.principalId) throw new ExchangeError("FORBIDDEN", "This worker does not own the task claim.");
    const prior = this.store.getIdempotent("submit_report", input.idempotencyKey, input);
    if (prior) return prior;
    if (input.outcome === "blocked" && (input.limitations.length === 0 || input.questions.length === 0)) throw new ExchangeError("INVALID_INPUT", "Blocked reports require a limitation and a question or missing condition.");
    const expectedIds = task.acceptanceCriteria.map(item => item.id).sort();
    const actualIds = input.criterionResults.map(item => item.criterionId);
    assertUnique(actualIds, "Criterion results must contain unique criterion IDs.");
    if (JSON.stringify([...actualIds].sort()) !== JSON.stringify(expectedIds)) throw new ExchangeError("INVALID_INPUT", "Criterion results must cover every task criterion exactly once.");
    const report: Report = {
      schemaVersion: 1, reportId: randomUUID(), taskId: input.taskId, projectId: input.projectId, createdAt: new Date().toISOString(), createdBy: this.exchange.principalId,
      outcome: input.outcome, summary: input.summary, changes: input.changes, checks: input.checks, criterionResults: input.criterionResults, limitations: input.limitations, questions: input.questions
    };
    assertBytes(report, this.exchange.limits.maxReportBytes, "Report");
    assertResponseBytes({ report }, this.exchange.limits.maxResponseBytes);
    return this.store.submitReport(report, input.expectedRevision, input.idempotencyKey, input);
  }

  reviewReport(input: ReviewReportInput) {
    this.authorize(input.projectId, "planner");
    const task = this.store.getTask(input.projectId, input.taskId);
    if (task.task.createdBy !== this.exchange.principalId) throw new ExchangeError("FORBIDDEN", "Only the task creator may review its report.");
    if (task.reportId !== input.reportId) throw new ExchangeError("NOT_FOUND", "The report was not found.");
    const prior = this.store.getIdempotent("review_report", input.idempotencyKey, input);
    if (prior) return prior;
    const review: Review = { schemaVersion: 1, reviewId: randomUUID(), taskId: input.taskId, reportId: input.reportId, createdAt: new Date().toISOString(), createdBy: this.exchange.principalId, decision: input.decision, comment: input.comment };
    assertBytes(review, this.exchange.limits.maxReviewBytes, "Review");
    const reviewedTask = { ...task.task, revision: task.task.revision + 1, state: input.decision };
    assertResponseBytes({ task: reviewedTask, reportId: input.reportId, review }, this.exchange.limits.maxResponseBytes);
    return this.store.reviewReport(input.projectId, review, input.expectedRevision, input.idempotencyKey, input);
  }

  cancelTask(input: CancelTaskInput) {
    this.authorize(input.projectId, "planner");
    const task = this.store.getTask(input.projectId, input.taskId).task;
    if (task.createdBy !== this.exchange.principalId) throw new ExchangeError("FORBIDDEN", "Only the task creator may cancel it.");
    const prior = this.store.getIdempotent("cancel_task", input.idempotencyKey, input);
    if (prior) return prior;
    if (cancelReasonJsonBytes(input.reason) > MAX_CANCEL_REASON_JSON_BYTES) throw new ExchangeError("LIMIT_EXCEEDED", "Cancellation reason exceeds its lifecycle byte allowance.");
    return this.store.cancelTask(input.projectId, input.taskId, input.expectedRevision, input.reason, input.idempotencyKey, input);
  }

  private authorize(projectId: string, role?: "planner" | "worker"): void {
    const registered = this.appConfig.projects.some(project => project.projectId === projectId);
    const allowed = this.exchange.allowedProjectIds.includes(projectId);
    if (!registered || !allowed) throw new ExchangeError("NOT_FOUND", "The requested exchange entity was not found.");
    if (role && this.exchange.role !== role) throw new ExchangeError("FORBIDDEN", "This exchange role cannot perform the requested operation.");
  }
}

function assertUnique(values: string[], message: string): void {
  if (new Set(values).size !== values.length) throw new ExchangeError("INVALID_INPUT", message);
}
function assertBytes(value: unknown, limit: number, label: string): void {
  if (jsonBytes(value) > limit) throw new ExchangeError("LIMIT_EXCEEDED", `${label} exceeds its configured byte limit.`);
}
function assertResponseBytes(value: unknown, limit: number): void {
  if (jsonBytes(value) > limit) throw new ExchangeError("LIMIT_EXCEEDED", "The response exceeds its configured byte limit.");
}
