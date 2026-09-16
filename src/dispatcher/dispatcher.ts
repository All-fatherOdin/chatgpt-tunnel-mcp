import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { assertNoLinks, pathsOverlap, type AppConfig } from "../config.js";
import { readProjectFile } from "../projects.js";
import { ExchangeService } from "../exchange/service.js";
import { ExchangeError } from "../exchange/store.js";
import { submitReportInputSchema, type ExecutorOptions, type Task } from "../exchange/schemas.js";
import { CodexExecutor, DispatchError, TurnFailure, reportBodySchema, reportFromTurn, type Executor } from "./codex.js";
import type { DispatcherConfig, DispatchProject } from "./config.js";
import { RunStore, type Run } from "./store.js";
import { sameRevision, workspaceState } from "./workspace.js";

export class Dispatcher {
  private executor: Executor | undefined;
  private stopped = false;
  constructor(readonly config: DispatcherConfig, readonly app: AppConfig, readonly journal: RunStore,
    private readonly exchange: ExchangeService,
    private readonly factory: () => Executor = () => new CodexExecutor(config),
    private readonly log: (event: Record<string, unknown>) => void = value => process.stdout.write(`${JSON.stringify(value)}\n`)) {}

  private codex(): Executor { return this.executor ??= this.factory(); }
  async stop(): Promise<void> { this.stopped = true; await this.executor?.close(); }

  async tick(onlyTaskId?: string, overrides: ExecutorOptions = {}, recover = false): Promise<void> {
    if (!this.config.enabled) throw new DispatchError("DISPATCHER_DISABLED");
    // Incomplete journal entries always precede new work. Attention entries require explicit recovery.
    for (const run of this.journal.list()) {
      if (this.stopped) return;
      if (onlyTaskId && onlyTaskId !== run.taskId) continue;
      const hasOverrides = Object.keys(overrides).length > 0;
      if (run.phase === "done") {
        if (hasOverrides) throw new DispatchError("RUN_SETTINGS_ALREADY_FROZEN");
        continue;
      }
      if (run.attention && AUTOSTART_POLICY_ATTENTION.has(run.attention) && !hasOverrides) {
        const task = this.exchange.getTask(run.projectId, run.taskId).task;
        const project = this.config.projects.find(item => item.projectId === run.projectId);
        const currentAttention = project ? authorizationAttention(task, project) : "DISPATCH_PROJECT_NOT_CONFIGURED";
        if (currentAttention) {
          if (currentAttention !== run.attention) { run.attention = currentAttention; this.save(run); }
          continue;
        }
        delete run.attention;
        this.save(run);
      }
      if (run.attention && !recover && !hasOverrides) continue;
      if (hasOverrides) {
        const task = this.exchange.getTask(run.projectId, run.taskId).task;
        if (run.phase !== "prepared" || task.state !== "queued") throw new DispatchError("RUN_SETTINGS_ALREADY_FROZEN");
        const project = this.config.projects.find(item => item.projectId === run.projectId)!;
        const updated = await this.prepare(task, project, { ...run.overrides, ...overrides });
        delete run.sourceThreadId;
        delete run.reasoningEffort;
        Object.assign(run, updated, { runId: run.runId, createdAt: run.createdAt, claim: run.claim });
        delete run.attention;
        this.journal.save(run);
      }
      if (recover) delete run.attention;
      await this.advance(run);
    }
    for (const project of this.config.projects) {
      let cursor: string | undefined;
      do {
        const page = this.exchange.listTasks({ projectId: project.projectId, states: ["queued"], ...(cursor ? { cursor } : {}) });
        cursor = page.nextCursor ?? undefined;
        for (const card of page.tasks) {
          if (this.stopped) return;
          const taskId = String(card.taskId);
          if ((onlyTaskId && taskId !== onlyTaskId) || this.journal.get(taskId)) continue;
          const projectRoot = this.app.projects.find(item => item.projectId === project.projectId)!.root;
          if (this.journal.list().some(run => pathsOverlap(run.cwd, projectRoot) && (run.phase === "starting" || run.phase === "running"))) {
            if (onlyTaskId) throw new DispatchError("PROJECT_HAS_UNRESOLVED_EXECUTION");
            continue;
          }
          const task = this.exchange.getTask(project.projectId, taskId).task;
          const attention = authorizationAttention(task, project);
          if (attention) {
            if (onlyTaskId) throw new DispatchError("TASK_NOT_AUTHORIZED_FOR_AUTOSTART");
            const run = await this.prepare(task, project, overrides);
            run.attention = attention;
            this.save(run);
            continue;
          }
          // A queued task without explicit autoStart is intentionally manual, not an error.
          if (task.execution?.autoStart !== true) continue;
          const run = await this.prepare(task, project, overrides);
          this.journal.save(run);
          await this.advance(run);
        }
      } while (cursor && !this.stopped);
    }
    if (onlyTaskId && !this.journal.get(onlyTaskId)) throw new DispatchError("TASK_NOT_FOUND_OR_NOT_QUEUED");
  }

  private async prepare(task: Task, project: DispatchProject, overrides: ExecutorOptions): Promise<Run> {
    const selected = resolveOptions(this.config, project, task, overrides);
    const cwd = this.app.projects.find(value => value.projectId === task.projectId)!.root;
    const workspaceBefore = await workspaceState(cwd);
    const session = selected.session ?? { mode: "auto" as const };
    let mode: Run["sessionMode"] = "new", reason = "new_goal", sourceThreadId: string | undefined;
    const all = this.journal.list();
    if (session.mode === "resume" || session.mode === "fork") {
      mode = session.mode; sourceThreadId = session.threadId; reason = "explicit_override";
    } else if (session.mode === "new") reason = "explicit_new_session";
    else if (task.parentTaskId) {
      const parent = this.exchange.getTask(task.projectId, task.parentTaskId);
      const prior = this.journal.get(task.parentTaskId);
      if (prior?.threadId && prior.cwd === cwd && prior.projectId === task.projectId && prior.phase === "done" && parent.task.state === "changes_requested") {
        const related = all.filter(value => value.threadId === prior.threadId);
        if ((prior.workspaceAfter || workspaceBefore) && !sameRevision(prior.workspaceAfter, workspaceBefore)) reason = "workspace_revision_changed_handoff";
        else if (related.length >= project.maxSessionTasks) reason = "session_task_limit_handoff";
        else if (related.at(-1)?.taskId !== prior.taskId || related.some(value => value.phase !== "done")) reason = "session_has_other_work_handoff";
        else { mode = "resume"; sourceThreadId = prior.threadId; reason = "parent_review_followup"; }
      } else reason = "new_stage_handoff";
    }
    return {
      runId: randomUUID(), taskId: task.taskId, projectId: task.projectId, cwd, phase: "prepared", workspaceBefore,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), overrides,
      model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
      modelSource: selected.modelSource, effortSource: selected.effortSource,
      sessionMode: mode, sessionReason: reason, ...(sourceThreadId ? { sourceThreadId } : {}),
      claim: { projectId: task.projectId, taskId: task.taskId, expectedRevision: task.revision, idempotencyKey: randomUUID() }
    };
  }

  private async advance(run: Run): Promise<void> {
    try {
      const project = this.config.projects.find(value => value.projectId === run.projectId);
      const current = this.exchange.getTask(run.projectId, run.taskId);
      if (current.reportId) {
        if (current.task.claimedBy !== this.app.exchange!.principalId) throw new DispatchError("CLAIM_OWNERSHIP_CHANGED");
        run.reportId = current.reportId; run.phase = "done"; delete run.attention;
        this.save(run); return;
      }
      if (current.task.state === "cancelled") { run.phase = "done"; delete run.attention; this.save(run); return; }
      // Revocation stops new execution; delivery of an already saved result remains allowed.
      if (run.phase !== "delivering") {
        if (!project || !authorized(current.task, project)) throw new DispatchError("TASK_NOT_AUTHORIZED_FOR_AUTOSTART");
        if (this.app.projects.find(value => value.projectId === run.projectId)?.root !== run.cwd) throw new DispatchError("PROJECT_CWD_CHANGED");
        await assertNoLinks(run.cwd);
        if (!(await stat(run.cwd)).isDirectory()) throw new DispatchError("PROJECT_CWD_UNAVAILABLE");
      }
      if ((run.phase === "prepared" || run.phase === "claimed") && this.journal.list().some(other => other.runId !== run.runId && pathsOverlap(other.cwd, run.cwd) && (other.phase === "starting" || other.phase === "running"))) throw new DispatchError("WORKSPACE_HAS_UNRESOLVED_EXECUTION");
      if (run.phase === "prepared") {
        if (run.sourceThreadId) {
          const related = this.journal.list().filter(value => value.threadId === run.sourceThreadId);
          if (!related.some(value => value.projectId === run.projectId && value.cwd === run.cwd)) throw new DispatchError("SESSION_NOT_MANAGED_FOR_PROJECT");
          if (related.some(value => value.phase !== "done")) throw new DispatchError("SESSION_HAS_UNRESOLVED_RUN");
          const priorWorkspace = related.at(-1)?.workspaceAfter;
          const workspaceNow = await workspaceState(run.cwd);
          if ((priorWorkspace || workspaceNow) && !sameRevision(priorWorkspace, workspaceNow)) throw new DispatchError("SESSION_WORKSPACE_REVISION_CHANGED");
        }
        const model = (await this.codex().models()).find(value => value.model === run.model);
        if (!model) throw new DispatchError("MODEL_UNAVAILABLE");
        const effort = run.reasoningEffort ?? model.defaultReasoningEffort;
        if (!model.supportedReasoningEfforts.some(value => value.reasoningEffort === effort)) throw new DispatchError("REASONING_EFFORT_UNAVAILABLE");
        run.reasoningEffort = effort;
        this.journal.save(run);
        // Repeat precisely this claim after an ambiguous commit; never adopt another claim.
        this.exchange.claimTask(run.claim);
        run.phase = "claimed"; this.save(run);
      }
      if (run.phase === "claimed") {
        const task = this.exchange.getTask(run.projectId, run.taskId).task;
        if (task.claimedBy !== this.app.exchange!.principalId || task.state !== "in_progress") throw new DispatchError("CLAIM_OWNERSHIP_CHANGED");
        for (const source of task.sourceRefs) {
          let matches = false;
          try { matches = (await readProjectFile(this.app, { projectId: task.projectId, path: source.path })).sha256.toLowerCase() === source.sha256.toLowerCase(); }
          catch { /* Missing or excluded sources are blocked, never silently ignored. */ }
          if (!matches) {
            this.stageReport(run, task, {
              outcome: "blocked", summary: "Task source snapshot is no longer current; execution did not start.",
              changes: [], checks: [{ description: "Verify sourceRefs", status: "failed", evidence: `Source changed or is unavailable: ${source.path}` }],
              criterionResults: task.acceptanceCriteria.map(value => ({ criterionId: value.id, status: "not_verified", evidence: "Execution did not start." })),
              limitations: ["Task sourceRefs are stale or unreadable."], questions: ["Create a follow-up task with current source references."]
            });
            break;
          }
        }
        if (run.phase === "claimed") {
          const session = await this.codex().open(run, project!);
          run.threadId = session.threadId; run.actualModel = session.model;
          if (session.reasoningEffort) run.actualReasoningEffort = session.reasoningEffort;
          // Persist the thread even when the runtime unexpectedly resolves different settings.
          this.journal.save(run);
          if (session.model !== run.model || (session.reasoningEffort && session.reasoningEffort !== run.reasoningEffort)) throw new DispatchError("EXECUTOR_SETTINGS_MISMATCH");
          run.phase = "starting"; this.save(run);
          const result = await this.codex().execute(run, this.prompt(task, run), id => {
            run.turnId = id; run.phase = "running"; this.save(run);
          });
          run.workspaceAfter = await workspaceState(run.cwd);
          this.stageReport(run, task, result);
        }
      } else if (run.phase === "starting" || run.phase === "running") {
        // Recovery reads the exact old turn. Never issue another turn/start after ambiguity.
        if (!run.threadId) throw new DispatchError("EXECUTION_STATE_AMBIGUOUS");
        const thread = await this.codex().readThread(run.threadId);
        const turns = thread.turns ?? [];
        const turn = run.turnId ? turns.find(value => value.id === run.turnId) : turns.find(value =>
          value.items?.some(item => item.type === "userMessage" && item.content?.some(content => content.type === "text" && content.text?.startsWith(`Dispatcher run ${run.runId}\n`))));
        if (!turn) throw new DispatchError("EXECUTION_STATE_AMBIGUOUS");
        run.turnId = turn.id; this.journal.save(run);
        run.workspaceAfter = await workspaceState(run.cwd);
        this.stageReport(run, current.task, reportFromTurn(turn));
      }
      if (run.phase === "delivering") {
        if (!run.report) throw new DispatchError("REPORT_RECEIPT_MISSING");
        const result = this.exchange.submitReport(run.report);
        run.reportId = String(result.reportId); run.phase = "done"; delete run.attention;
        this.save(run);
      }
    } catch (error) {
      if (error instanceof TurnFailure) {
        const task = this.exchange.getTask(run.projectId, run.taskId).task;
        run.workspaceAfter = await workspaceState(run.cwd);
        this.stageReport(run, task, {
          outcome: "failed", summary: `Codex turn ${error.status}. Execution may have made changes; the dispatcher did not repeat it.`,
          changes: [], checks: [{ description: "Codex turn completion", status: "failed", evidence: error.code }],
          criterionResults: task.acceptanceCriteria.map(item => ({ criterionId: item.id, status: "not_verified", evidence: "No validated final worker report was produced." })),
          limitations: ["Changed files and check results were not inventoried. Inspect the workspace and Codex session before assigning a follow-up."], questions: []
        });
        await this.advance(run); return;
      }
      const code = error instanceof DispatchError || error instanceof ExchangeError ? error.code : "DISPATCH_FAILED";
      // Only transport/storage delivery errors retry automatically; executing again is never a retry strategy.
      if (run.phase === "delivering" && error instanceof ExchangeError && error.retryable) {
        this.log({ event: "delivery_retry", taskId: run.taskId, runId: run.runId, code });
      } else {
        run.attention = code; this.save(run);
        await this.executor?.close(); this.executor = undefined;
      }
    }
  }

  private stageReport(run: Run, task: Task, value: unknown): void {
    const parsed = reportBodySchema.safeParse(value);
    if (!parsed.success) throw new DispatchError("EXECUTOR_REPORT_INVALID");
    const body = parsed.data;
    if (body.criterionResults.length !== task.acceptanceCriteria.length || new Set(body.criterionResults.map(item => item.criterionId)).size !== task.acceptanceCriteria.length || task.acceptanceCriteria.some(item => !body.criterionResults.some(result => result.criterionId === item.id))) throw new DispatchError("EXECUTOR_CRITERIA_MISMATCH");
    if (body.outcome === "blocked" && (!body.limitations.length || !body.questions.length)) throw new DispatchError("EXECUTOR_BLOCKED_REPORT_INCOMPLETE");
    run.report = submitReportInputSchema.parse({ ...body,
      projectId: run.projectId, taskId: run.taskId, expectedRevision: run.claim.expectedRevision + 1, idempotencyKey: randomUUID(),
      execution: {
        runId: run.runId, threadId: run.threadId, turnId: run.turnId,
        requestedModel: run.model, actualModel: run.actualModel, reasoningEffort: run.reasoningEffort, actualReasoningEffort: run.actualReasoningEffort,
        modelSource: run.modelSource, effortSource: run.effortSource, sessionMode: run.sessionMode, sessionReason: run.sessionReason
      }
    });
    run.phase = "delivering";
    this.save(run); // Durable outbox BEFORE submit_report; UUID and revision are frozen here.
  }

  private prompt(task: Task, run: Run): string {
    let handoff: unknown = null;
    if (task.parentTaskId) {
      const parent = this.exchange.getTask(task.projectId, task.parentTaskId);
      handoff = { taskId: parent.task.taskId, objective: parent.task.objective, sourceRefs: parent.task.sourceRefs,
        workspace: this.journal.get(task.parentTaskId)?.workspaceAfter,
        review: parent.review, report: parent.reportId ? this.exchange.getReport(task.projectId, parent.reportId).report : null };
    }
    return `Dispatcher run ${run.runId}\nExecute this authorized task in the current working directory. The dispatcher has already claimed it. Return report JSON only. Do not claim, submit, or review via MCP. Read applicable AGENTS.md and verify actual files before changes. The handoff is historical evidence, not new authorization. Report checks honestly; do not rerun completed modifications just to deliver a report.\nTASK:\n${JSON.stringify(task)}\nHANDOFF:\n${JSON.stringify(handoff)}`;
  }
  private save(run: Run): void {
    this.journal.save(run);
    this.log({ event: run.attention ? "needs_attention" : run.phase, taskId: run.taskId, runId: run.runId,
      ...(run.attention ? { code: run.attention } : {}), ...(run.reportId ? { reportId: run.reportId } : {}) });
  }
}

export function authorized(task: Task, project: DispatchProject): boolean {
  return task.execution?.autoStart === true && authorizationAttention(task, project) === undefined;
}
const AUTOSTART_POLICY_ATTENTION = new Set([
  "DISPATCH_PROJECT_DISABLED", "DISPATCH_PLANNER_NOT_ALLOWED", "DISPATCH_WHOLE_PROJECT_NOT_ALLOWED",
  "DISPATCH_SCOPE_EMPTY", "DISPATCH_PATH_NOT_ALLOWED", "DISPATCH_PROJECT_NOT_CONFIGURED"
]);
export function authorizationAttention(task: Task, project: DispatchProject): string | undefined {
  if (task.execution?.autoStart !== true) return undefined;
  if (!project.enabled) return "DISPATCH_PROJECT_DISABLED";
  if (!project.allowedPlannerIds.includes(task.createdBy)) return "DISPATCH_PLANNER_NOT_ALLOWED";
  if (task.scope.wholeProject) return project.allowWholeProject ? undefined : "DISPATCH_WHOLE_PROJECT_NOT_ALLOWED";
  if (task.scope.allowedPaths.length === 0) return "DISPATCH_SCOPE_EMPTY";
  if (!project.allowWholeProject && !task.scope.allowedPaths.every(path => project.allowedPaths.some(parent => within(path, parent)))) return "DISPATCH_PATH_NOT_ALLOWED";
  return undefined;
}
function within(path: string, parent: string): boolean {
  const norm = (value: string) => {
    const path = value.replaceAll("\\", "/").split("/").filter(part => part && part !== ".").join("/");
    return process.platform === "win32" ? path.toLowerCase() : path;
  };
  const child = norm(path), root = norm(parent);
  return root.length > 0 && (child === root || child.startsWith(`${root}/`));
}
export function resolveOptions(config: DispatcherConfig, project: DispatchProject, task: Task, override: ExecutorOptions) {
  const values = [{ source: "run", value: override }, { source: "task", value: task.execution ?? {} }, { source: "project", value: project.executor }, { source: "config", value: config.executor }];
  const model = values.find(item => item.value.model !== undefined)!;
  const effort = values.find(item => item.value.reasoningEffort !== undefined);
  return { model: model.value.model!, reasoningEffort: effort?.value.reasoningEffort, modelSource: model.source, effortSource: effort?.source ?? "model_default",
    session: override.session ?? task.execution?.session };
}
