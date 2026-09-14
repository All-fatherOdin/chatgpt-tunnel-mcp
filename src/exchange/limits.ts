import type { Task } from "./schemas.js";

export const MAX_TASK_BYTES = 32_768;
export const MAX_REPORT_BYTES = 65_536;
export const MAX_REVIEW_BYTES = 8_192;
export const MAX_RESPONSE_BYTES = 131_072;
export const MIN_CONFIGURED_TASK_BYTES = 9_216;
export const MIN_EXCHANGE_RESPONSE_BYTES = 65_600;
export const MAX_PRINCIPAL_LENGTH = 128;
export const MAX_CANCEL_REASON_JSON_BYTES = 8_002;

const MAX_PRINCIPAL = "p".repeat(MAX_PRINCIPAL_LENGTH);
const MAX_CANCEL_REASON = "x".repeat(MAX_CANCEL_REASON_JSON_BYTES - 2);
const TIMESTAMP_PLACEHOLDER = "9999-12-31T23:59:59.999Z";

/** Largest serialized Task reachable from a newly-created queued Task. */
export function taskLifecycleBytes(task: Task): number {
  const queued = withoutLifecycle(task);
  const claimed = { ...queued, revision: 4, state: "changes_requested" as const, claimedBy: MAX_PRINCIPAL, claimedAt: TIMESTAMP_PLACEHOLDER };
  const cancelled = { ...queued, revision: 2, state: "cancelled" as const, cancelReason: MAX_CANCEL_REASON };
  return Math.max(jsonBytes(queued), jsonBytes(claimed), jsonBytes(cancelled));
}

export function claimedTaskLifecycleBytes(task: Task, claimedBy: string, claimedAt: string): number {
  const queued = withoutLifecycle(task);
  const states = [["in_progress", 2], ["reported", 3], ["accepted", 4], ["changes_requested", 4]] as const;
  return Math.max(...states.map(([state, revision]) => jsonBytes({ ...queued, revision, state, claimedBy, claimedAt })));
}

export function cancelledTask(task: Task, reason: string): Task {
  return { ...withoutLifecycle(task), revision: 2, state: "cancelled", cancelReason: reason };
}

export function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
export function cancelReasonJsonBytes(reason: string): number { return jsonBytes(reason); }

function withoutLifecycle(task: Task): Task {
  const clean = { ...task };
  delete clean.claimedBy;
  delete clean.claimedAt;
  delete clean.cancelReason;
  return { ...clean, revision: 1, state: "queued" };
}
