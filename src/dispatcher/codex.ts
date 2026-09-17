import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { changeSchema, submitReportInputSchema } from "../exchange/schemas.js";
import type { DispatcherConfig, DispatchProject } from "./config.js";
import type { Run } from "./store.js";

export class DispatchError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export class TurnFailure extends DispatchError {
  constructor(public readonly status: "failed" | "interrupted") { super(`EXECUTOR_TURN_${status.toUpperCase()}`); }
}
export const reportBodySchema = submitReportInputSchema.omit({ projectId: true, taskId: true, expectedRevision: true, idempotencyKey: true, execution: true })
  .extend({ changes: changeSchema.omit({ sha256After: true }).array().max(100) });
// Structured Outputs does not support JS regex lookaround. Keep full path validation
// at the local boundary, and describe the requirement in the generation schema.
const generationSchema = reportBodySchema.extend({ changes: reportBodySchema.shape.changes.element.extend({
  path: z.string().min(1).max(1000).describe("Safe relative project path, without parent traversal, absolute paths, colons or wildcards.")
}).array().max(100) });
export type ModelInfo = { model: string; defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string }[] };
type Item = { type: string; text?: string; phase?: string; content?: { type: string; text?: string }[] };
export type Turn = { id: string; status: string; items: Item[] };
export type Thread = { id: string; cwd: string; status?: { type: string }; turns?: Turn[] };
export interface Executor {
  models(): Promise<ModelInfo[]>;
  readThread(id: string): Promise<Thread>;
  open(run: Run, project: DispatchProject): Promise<{ threadId: string; model: string; reasoningEffort?: string }>;
  execute(run: Run, prompt: string, onTurn: (id: string) => void): Promise<unknown>;
  close(): Promise<void>;
}

/** Newline-delimited app-server JSON-RPC; no shell and no task text in command arguments. */
export class CodexExecutor implements Executor {
  private process: ChildProcessWithoutNullStreams;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private events = new EventEmitter();
  private buffer = "";
  private dead = false;
  private ready: Promise<void>;
  constructor(private readonly config: DispatcherConfig) {
    if (/\.(cmd|bat|ps1)$/i.test(config.codexCommand)) throw new DispatchError("USE_CODEX_EXE_OR_NODE_ENTRYPOINT");
    this.process = spawn(config.codexCommand, [...config.codexArgs, "app-server", "--listen", "stdio://"], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) { this.fail("CODEX_PROTOCOL_LIMIT"); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.fail("CODEX_PROTOCOL_ERROR"); }
      }
    });
    // Tool output, prompts and account diagnostics must not leak to the dispatcher log.
    this.process.stderr.resume();
    this.process.on("error", () => this.fail("CODEX_PROCESS_ERROR"));
    this.process.on("exit", () => this.fail("CODEX_PROCESS_EXITED"));
    this.process.stdin.on("error", () => this.fail("CODEX_PROCESS_ERROR"));
    this.ready = this.request("initialize", { clientInfo: { name: "task_dispatcher", version: "2.0.0", title: "Task dispatcher" } })
      .then(() => { this.send({ method: "initialized" }); });
    // Callers may spend time inspecting the journal before awaiting readiness.
    void this.ready.catch(() => {});
  }
  private send(value: unknown): void {
    if (this.dead) throw new DispatchError("CODEX_PROCESS_EXITED");
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private receive(message: any): void {
    if (message.id !== undefined && message.method) {
      // No background auto-approvals or invented answers to questions.
      this.send({ id: message.id, error: { code: -32601, message: "Unattended dispatcher cannot grant approval or supply user input." } });
      this.events.emit("blocked");
    } else if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(message.id);
      if (message.error) entry.reject(new DispatchError(`CODEX_RPC_ERROR_${Number(message.error.code) || 0}`));
      else entry.resolve(message.result);
    } else if (message.method) this.events.emit("notification", message);
  }
  private fail(code: string): void {
    if (this.dead) return;
    this.dead = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new DispatchError(code)); }
    this.pending.clear();
    this.events.emit("stopped", new DispatchError(code));
    this.process.kill();
  }
  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolveRequest, reject) => {
      if (this.dead) { reject(new DispatchError("CODEX_PROCESS_EXITED")); return; }
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DispatchError("CODEX_RPC_TIMEOUT")); }, 60000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async models(): Promise<ModelInfo[]> {
    await this.ready;
    const models: ModelInfo[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...result.data); cursor = result.nextCursor ?? undefined;
      if (models.length > 1000) throw new DispatchError("MODEL_CATALOG_LIMIT");
    } while (cursor);
    return models;
  }
  async readThread(id: string): Promise<Thread> {
    await this.ready;
    return (await this.request("thread/read", { threadId: id, includeTurns: true })).thread;
  }
  async open(run: Run, project: DispatchProject) {
    await this.ready;
    const existingThread = run.threadId ?? run.sourceThreadId;
    if (existingThread) {
      const source = await this.readThread(existingThread);
      if (normalize(source.cwd) !== normalize(run.cwd)) throw new DispatchError("SESSION_CWD_MISMATCH");
      if (source.status?.type === "active" || source.turns?.some(turn => turn.status === "inProgress")) throw new DispatchError("SESSION_BUSY");
    }
    const method = run.threadId ? "thread/resume" : run.sessionMode === "new" ? "thread/start" : run.sessionMode === "fork" ? "thread/fork" : "thread/resume";
    const dispatcherPermissions = project.permissionMode === "dispatcher" ? {
      sandbox: project.sandbox,
      config: { model_reasoning_effort: run.reasoningEffort, sandbox_workspace_write: {
        network_access: false, writable_roots: project.additionalWritableRoots
      } }
    } : { config: { model_reasoning_effort: run.reasoningEffort } };
    const result = await this.request(method, {
      ...(existingThread ? { threadId: existingThread } : {}),
      cwd: run.cwd, model: run.model, approvalPolicy: "never", ...dispatcherPermissions,
      developerInstructions: "You are an unattended executor of one authorized exchange Task. The dispatcher owns claim and report delivery. Do not call exchange mutation tools, create other tasks, review reports, or manage Codex tasks/automations. Read applicable local AGENTS.md and task source files. Follow the Task scope; report changed sources or missing authorization as blocked. Do not commit, push, merge, deploy, or make external writes unless the task explicitly authorizes them. If a tool needs unavailable approval/input, return a blocked report. Return only the requested report JSON; every criterion must occur exactly once. Never treat a previous task or session as authorization for this task."
    });
    if (normalize(result.cwd) !== normalize(run.cwd)) throw new DispatchError("SESSION_CWD_MISMATCH");
    return { threadId: result.thread.id as string, model: result.model as string,
      ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort as string } : {}) };
  }
  async execute(run: Run, prompt: string, onTurn: (id: string) => void): Promise<unknown> {
    await this.ready;
    // Subscribe before turn/start: very short turns can finish before its response.
    return new Promise((resolveResult, reject) => {
      let turnId: string | undefined;
      let completed: Turn | undefined;
      let finalText: string | undefined;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off("notification", notification); this.events.off("stopped", stopped); this.events.off("blocked", blocked);
      };
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return; settled = true; cleanup();
        if (error) reject(error); else resolveResult(result);
      };
      const extract = () => {
        if (!completed || !turnId || completed.id !== turnId) return;
        try { finish(undefined, reportFromTurn(completed, finalText)); }
        catch (error) { finish(error as Error); }
      };
      const notification = (message: any) => {
        if (message.params?.threadId !== run.threadId) return;
        if (message.method === "item/completed" && message.params.item?.type === "agentMessage" && (!turnId || message.params.turnId === turnId)) {
          const item = message.params.item;
          if (item.phase !== "commentary" && typeof item.text === "string" && Buffer.byteLength(item.text) <= 65536) finalText = item.text;
        }
        if (message.method === "turn/completed") { completed = message.params.turn; extract(); }
      };
      const stopped = (error: Error) => finish(error);
      const interrupt = () => { if (run.threadId && turnId) void this.request("turn/interrupt", { threadId: run.threadId, turnId }).catch(() => {}); };
      const blocked = () => { interrupt(); finish(new DispatchError("EXECUTOR_NEEDS_USER_INPUT")); };
      const timer = setTimeout(() => { interrupt(); finish(new DispatchError("EXECUTOR_TIMEOUT")); }, this.config.turnTimeoutMs);
      this.events.on("notification", notification); this.events.on("stopped", stopped); this.events.on("blocked", blocked);
      void this.request("turn/start", {
        threadId: run.threadId, clientUserMessageId: run.runId,
        input: [{ type: "text", text: prompt }], model: run.model, effort: run.reasoningEffort,
        outputSchema: zodToJsonSchema(generationSchema, { target: "openAi", $refStrategy: "none" })
      }).then(result => {
        turnId = result.turn.id;
        onTurn(turnId!);
        if (settled) { interrupt(); return; }
        if (result.turn.status !== "inProgress") completed = result.turn;
        extract();
      }).catch(error => finish(error));
    });
  }
  async close(): Promise<void> {
    if (this.dead) return;
    this.process.stdin.end();
    this.fail("CODEX_PROCESS_CLOSED");
  }
}
export function reportFromTurn(turn: Turn, fallback?: string): unknown {
  if (turn.status === "failed" || turn.status === "interrupted") throw new TurnFailure(turn.status);
  if (turn.status !== "completed") throw new DispatchError("EXECUTOR_TURN_NOT_COMPLETED");
  const item = [...(turn.items ?? [])].reverse().find(value => value.type === "agentMessage" && value.phase !== "commentary");
  const text = item?.text ?? fallback;
  if (!text || Buffer.byteLength(text) > 65536) throw new DispatchError("EXECUTOR_REPORT_MISSING_OR_TOO_LARGE");
  try { return JSON.parse(text); } catch { throw new DispatchError("EXECUTOR_REPORT_INVALID_JSON"); }
}
function normalize(path: string): string { const full = resolve(path); return process.platform === "win32" ? full.toLowerCase() : full; }
