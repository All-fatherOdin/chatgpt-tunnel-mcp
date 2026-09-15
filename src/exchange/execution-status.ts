import Database from "better-sqlite3";
import { existsSync, lstatSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { executionStatusSchema } from "./schemas.js";
import { ExchangeError } from "./store.js";

/** Optional read-only projection, with no journal initialization or execution capability. */
export function readExecutionStatus(path: string | undefined, storePath: string, projectId: string, taskId: string) {
  if (!path || !existsSync(path)) return undefined;
  let db: Database.Database | undefined;
  try {
    let cursor = resolve(path);
    while (cursor !== parse(cursor).root) {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("linked journal");
      cursor = dirname(cursor);
    }
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
    if (db.pragma("user_version", { simple: true }) !== 1) throw new Error("journal version");
    const identity = db.prepare("SELECT value FROM metadata WHERE key='identity'").get() as { value: string } | undefined;
    if (!identity || JSON.parse(identity.value).store !== storePath) throw new Error("journal identity");
    const row = db.prepare("SELECT entity_json FROM runs WHERE task_id=?").get(taskId) as { entity_json: string } | undefined;
    if (!row) return undefined;
    const run = JSON.parse(row.entity_json);
    if (run.projectId !== projectId) return undefined;
    return executionStatusSchema.parse({ runId: run.runId, phase: run.phase, updatedAt: run.updatedAt, attention: run.attention,
      threadId: run.threadId, turnId: run.turnId, model: run.model, reasoningEffort: run.reasoningEffort,
      actualModel: run.actualModel, actualReasoningEffort: run.actualReasoningEffort, sessionMode: run.sessionMode, sessionReason: run.sessionReason });
  } catch { throw new ExchangeError("STORAGE_UNAVAILABLE", "Dispatcher status is unavailable; exchange history is unchanged.", true); }
  finally { db?.close(); }
}
