import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import type { ClaimTaskInput, ExecutorOptions, SubmitReportInput } from "../exchange/schemas.js";
import type { WorkspaceState } from "./workspace.js";

export type Run = {
  runId: string; taskId: string; projectId: string; cwd: string;
  phase: "prepared" | "claimed" | "starting" | "running" | "delivering" | "done";
  createdAt: string; updatedAt: string; attention?: string;
  overrides: ExecutorOptions; model: string; reasoningEffort?: string;
  modelSource: string; effortSource: string;
  sessionMode: "new" | "resume" | "fork"; sessionReason: string;
  sourceThreadId?: string; threadId?: string; turnId?: string;
  actualModel?: string; actualReasoningEffort?: string;
  claim: ClaimTaskInput; report?: SubmitReportInput; reportId?: string;
  workspaceBefore?: WorkspaceState; workspaceAfter?: WorkspaceState;
};

/** Separate durable journal. The exchange database remains owned by ExchangeService. */
export class RunStore {
  private db: Database.Database;
  private locked = false;
  constructor(path: string, identity: string) {
    this.db = new Database(path);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    const version = this.db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error("Unsupported dispatcher journal version."); }
    if (version === 0 && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) { this.db.close(); throw new Error("Refusing to initialize an unrelated database."); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (task_id TEXT PRIMARY KEY, entity_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatcher_lock (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
      PRAGMA user_version = 1;`);
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('identity', ?)").run(identity);
    const saved = this.db.prepare("SELECT value FROM metadata WHERE key='identity'").get() as { value: string };
    if (saved.value !== identity) { this.db.close(); throw new Error("Journal belongs to a different exchange/worker."); }
  }
  acquire(): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT pid FROM dispatcher_lock WHERE id=1").get() as { pid: number } | undefined;
      if (row && alive(row.pid)) throw new Error("Dispatcher already running (journal is locked).");
      this.db.prepare("INSERT OR REPLACE INTO dispatcher_lock VALUES (1, ?)").run(process.pid);
    }).immediate();
    this.locked = true;
  }
  get(taskId: string): Run | undefined {
    const row = this.db.prepare("SELECT entity_json FROM runs WHERE task_id=?").get(taskId) as { entity_json: string } | undefined;
    return row ? JSON.parse(row.entity_json) as Run : undefined;
  }
  list(): Run[] {
    return (this.db.prepare("SELECT entity_json FROM runs ORDER BY rowid").all() as { entity_json: string }[]).map(row => JSON.parse(row.entity_json) as Run);
  }
  save(run: Run): void {
    if (!this.locked) throw new Error("Journal writes require the dispatcher lock.");
    run.updatedAt = new Date().toISOString();
    this.db.prepare("INSERT INTO runs VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET entity_json=excluded.entity_json").run(run.taskId, JSON.stringify(run));
  }
  close(): void {
    if (this.locked) this.db.prepare("DELETE FROM dispatcher_lock WHERE id=1 AND pid=?").run(process.pid);
    this.locked = false;
    this.db.close();
  }
}
export function readRuns(path: string, identity: string): Run[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    if (db.pragma("user_version", { simple: true }) !== 1) throw new Error("Unsupported dispatcher journal version.");
    const row = db.prepare("SELECT value FROM metadata WHERE key='identity'").get() as { value: string } | undefined;
    if (row?.value !== identity) throw new Error("Journal belongs to a different exchange/worker.");
    return (db.prepare("SELECT entity_json FROM runs ORDER BY rowid").all() as { entity_json: string }[]).map(row => JSON.parse(row.entity_json) as Run);
  } finally { db.close(); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
