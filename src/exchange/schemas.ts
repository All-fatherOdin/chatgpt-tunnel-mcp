import { z } from "zod";

export const taskStates = ["queued", "in_progress", "reported", "accepted", "changes_requested", "cancelled"] as const;
export const reportOutcomes = ["completed", "blocked", "failed"] as const;
export const reviewDecisions = ["accepted", "changes_requested"] as const;

const id = z.string().uuid().describe("UUID string. For idempotencyKey, generate a new UUID per operation and reuse it with identical arguments on retry.");
const text = z.string().max(8_000);
const requiredText = text.min(1);
const relativePath = z.string().min(1).max(1_000).regex(/^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))(?!.*[:*?\0]).+$/, "must be a safe relative path without wildcards");
const stringList = z.array(text).max(100);

export const executorOptionsSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  reasoningEffort: z.string().min(1).max(40).optional(),
  session: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }).strict(),
    z.object({ mode: z.literal("new") }).strict(),
    z.object({ mode: z.literal("resume"), threadId: z.string().min(1).max(200) }).strict(),
    z.object({ mode: z.literal("fork"), threadId: z.string().min(1).max(200) }).strict()
  ]).optional()
}).strict();
export const executionSchema = executorOptionsSchema.extend({ autoStart: z.boolean().default(false) }).strict();
export type ExecutorOptions = z.infer<typeof executorOptionsSchema>;

export const scopeSchema = z.object({
  wholeProject: z.literal(true).optional(),
  allowedPaths: z.array(relativePath).max(100).default([]),
  outOfScope: stringList.default([])
}).strict();

export const criterionSchema = z.object({ id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), description: requiredText }).strict();
export const sourceRefSchema = z.object({
  path: relativePath,
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional()
}).strict();

const createTaskContent = {
  execution: executionSchema.optional(),
  parentTaskId: id.optional(),
  title: z.string().min(1).max(200),
  objective: requiredText,
  scope: scopeSchema,
  constraints: stringList,
  acceptanceCriteria: z.array(criterionSchema).min(1).max(100),
  sourceRefs: z.array(sourceRefSchema).max(100)
};
export const createTaskInputSchema = z.object({ projectId: z.string().min(1).max(100), idempotencyKey: id, ...createTaskContent }).strict();

export const listTasksInputSchema = z.object({
  projectId: z.string().min(1).max(100),
  states: z.array(z.enum(taskStates)).min(1).max(taskStates.length).optional(),
  cursor: z.string().min(1).max(2_000).optional(),
  limit: z.number().int().positive().max(100).optional()
}).strict();
export const getTaskInputSchema = z.object({ projectId: z.string().min(1).max(100), taskId: id }).strict();
const mutationBase = { projectId: z.string().min(1).max(100), taskId: id, expectedRevision: z.number().int().positive(), idempotencyKey: id };
export const claimTaskInputSchema = z.object(mutationBase).strict();

export const changeSchema = z.object({ path: relativePath, description: requiredText, sha256After: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).strict();
export const checkSchema = z.object({ description: requiredText, status: z.enum(["passed", "failed", "not_run"]), evidence: text }).strict();
export const criterionResultSchema = z.object({ criterionId: z.string().min(1).max(200), status: z.enum(["met", "unmet", "not_verified"]), evidence: text }).strict();
export const executionReceiptSchema = z.object({
  runId: id, threadId: z.string().max(200).optional(), turnId: z.string().max(200).optional(),
  requestedModel: z.string().max(200), actualModel: z.string().max(200).optional(),
  reasoningEffort: z.string().max(40).optional(), actualReasoningEffort: z.string().max(40).optional(),
  modelSource: z.string().max(40), effortSource: z.string().max(40),
  sessionMode: z.enum(["new", "resume", "fork"]), sessionReason: z.string().max(200)
}).strict();
export const submitReportInputSchema = z.object({
  ...mutationBase,
  execution: executionReceiptSchema.optional(),
  outcome: z.enum(reportOutcomes),
  summary: requiredText,
  changes: z.array(changeSchema).max(100),
  checks: z.array(checkSchema).max(100),
  criterionResults: z.array(criterionResultSchema).max(100),
  limitations: stringList,
  questions: stringList
}).strict();

export const getReportInputSchema = z.object({ projectId: z.string().min(1).max(100), reportId: id }).strict();
export const reviewReportInputSchema = z.object({ ...mutationBase, reportId: id, decision: z.enum(reviewDecisions), comment: requiredText }).strict();
export const cancelTaskInputSchema = z.object({
  ...mutationBase,
  reason: requiredText.describe("At most 8,002 UTF-8 bytes after JSON string serialization, including surrounding quotes and escaping.")
}).strict();

export const taskSchema = z.object({
  schemaVersion: z.literal(1), taskId: id, projectId: z.string(), createdAt: z.string().datetime(), createdBy: z.string(), revision: z.number().int().positive(), state: z.enum(taskStates),
  ...createTaskContent,
  claimedBy: z.string().optional(), claimedAt: z.string().datetime().optional(), cancelReason: text.optional()
}).strict();
export const reportSchema = z.object({
  schemaVersion: z.literal(1), reportId: id, taskId: id, projectId: z.string(), createdAt: z.string().datetime(), createdBy: z.string(),
  execution: executionReceiptSchema.optional(),
  outcome: z.enum(reportOutcomes), summary: requiredText, changes: z.array(changeSchema).max(100), checks: z.array(checkSchema).max(100), criterionResults: z.array(criterionResultSchema).max(100), limitations: stringList, questions: stringList
}).strict();
export const reviewSchema = z.object({ schemaVersion: z.literal(1), reviewId: id, taskId: id, reportId: id, createdAt: z.string().datetime(), createdBy: z.string(), decision: z.enum(reviewDecisions), comment: text }).strict();

export const createTaskOutputSchema = z.object({ taskId: id, state: z.literal("queued"), revision: z.number().int(), createdAt: z.string().datetime() }).strict();
export const taskCardSchema = z.object({ taskId: id, title: z.string(), state: z.enum(taskStates), revision: z.number().int(), createdAt: z.string().datetime(), claimedBy: z.string().optional(), reportId: id.optional() }).strict();
export const listTasksOutputSchema = z.object({ tasks: z.array(taskCardSchema), nextCursor: z.string().nullable() }).strict();
export const executionStatusSchema = z.object({
  runId: id, phase: z.enum(["prepared", "claimed", "starting", "running", "delivering", "done"]),
  updatedAt: z.string().datetime(), attention: z.string().max(200).optional(),
  threadId: z.string().max(200).optional(), turnId: z.string().max(200).optional(),
  model: z.string().max(200), reasoningEffort: z.string().max(40).optional(),
  actualModel: z.string().max(200).optional(), actualReasoningEffort: z.string().max(40).optional(),
  sessionMode: z.enum(["new", "resume", "fork"]), sessionReason: z.string().max(200)
}).strict();
export const getTaskOutputSchema = z.object({ task: taskSchema, reportId: id.optional(), review: reviewSchema.optional(), executionStatus: executionStatusSchema.optional() }).strict();
export const claimTaskOutputSchema = z.object({ taskId: id, state: z.literal("in_progress"), revision: z.number().int(), claimedBy: z.string() }).strict();
export const submitReportOutputSchema = z.object({ reportId: id, taskId: id, state: z.literal("reported"), revision: z.number().int() }).strict();
export const getReportOutputSchema = z.object({ report: reportSchema }).strict();
export const reviewReportOutputSchema = z.object({ reviewId: id, taskId: id, state: z.enum(["accepted", "changes_requested"]), revision: z.number().int() }).strict();
export const cancelTaskOutputSchema = z.object({ taskId: id, state: z.literal("cancelled"), revision: z.number().int() }).strict();

export type Task = z.infer<typeof taskSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskInputSchema>;
export type SubmitReportInput = z.infer<typeof submitReportInputSchema>;
export type ReviewReportInput = z.infer<typeof reviewReportInputSchema>;
export type CancelTaskInput = z.infer<typeof cancelTaskInputSchema>;
