import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import {
  cancelTaskInputSchema, cancelTaskOutputSchema, claimTaskInputSchema, claimTaskOutputSchema, createTaskInputSchema, createTaskOutputSchema,
  getReportInputSchema, getReportOutputSchema, getTaskInputSchema, getTaskOutputSchema, listTasksInputSchema, listTasksOutputSchema,
  reviewReportInputSchema, reviewReportOutputSchema, submitReportInputSchema, submitReportOutputSchema
} from "./schemas.js";
import { ExchangeService } from "./service.js";
import { ExchangeError } from "./store.js";

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutationAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const cancelAnnotations = { ...mutationAnnotations, destructiveHint: true } as const;
type Runner = <T extends Record<string, unknown>>(tool: string, operation: () => Promise<T> | T) => Promise<unknown>;

export function registerExchangeTools(server: McpServer, config: AppConfig, run: Runner): void {
  if (!config.exchange) return;
  const service = new ExchangeService(config);
  server.registerTool("list_tasks", {
    title: "List exchange tasks", description: "List current task cards for an allowed project using a filter-bound keyset cursor.", inputSchema: deferredValidation(listTasksInputSchema), outputSchema: listTasksOutputSchema, annotations: readAnnotations
  }, input => run("list_tasks", () => service.listTasks(validated(listTasksInputSchema, input))) as never);
  server.registerTool("get_task", {
    title: "Get exchange task", description: "Read one task, lifecycle, report ID and review. When dispatcherStatePath is locally configured, executionStatus exposes launch progress, model, session and attention code without starting work.", inputSchema: deferredValidation(getTaskInputSchema), outputSchema: getTaskOutputSchema, annotations: readAnnotations
  }, input => run("get_task", () => { const value = validated(getTaskInputSchema, input); return service.getTask(value.projectId, value.taskId); }) as never);
  server.registerTool("get_report", {
    title: "Get exchange report", description: "Read one immutable worker report from an allowed project.", inputSchema: deferredValidation(getReportInputSchema), outputSchema: getReportOutputSchema, annotations: readAnnotations
  }, input => run("get_report", () => { const value = validated(getReportInputSchema, input); return service.getReport(value.projectId, value.reportId); }) as never);

  if (config.exchange.role === "planner") {
    server.registerTool("create_task", {
      title: "Create exchange task", description: "Publish a structured task. execution.autoStart=true explicitly authorizes a separately configured local dispatcher to execute its scope; optional model/reasoningEffort/session override launch defaults. Without opt-in it stays manual. This MCP server never launches processes or modifies project files.", inputSchema: deferredValidation(createTaskInputSchema), outputSchema: createTaskOutputSchema, annotations: mutationAnnotations
    }, input => run("create_task", () => service.createTask(validated(createTaskInputSchema, input))) as never);
    server.registerTool("review_report", {
      title: "Review exchange report", description: "Record acceptance or a request for changes on the exact report. Does not merge, publish, or create a follow-up automatically.", inputSchema: deferredValidation(reviewReportInputSchema), outputSchema: reviewReportOutputSchema, annotations: mutationAnnotations
    }, input => run("review_report", () => service.reviewReport(validated(reviewReportInputSchema, input))) as never);
    server.registerTool("cancel_task", {
      title: "Cancel queued exchange task", description: "Cancel a task created by this planner while queued. Reason is limited to 8,002 UTF-8 bytes as a serialized JSON string; history is retained.", inputSchema: deferredValidation(cancelTaskInputSchema), outputSchema: cancelTaskOutputSchema, annotations: cancelAnnotations
    }, input => run("cancel_task", () => service.cancelTask(validated(cancelTaskInputSchema, input))) as never);
  } else {
    server.registerTool("claim_task", {
      title: "Claim exchange task", description: "Atomically claim one queued task as the configured worker principal. Does not start background work.", inputSchema: deferredValidation(claimTaskInputSchema), outputSchema: claimTaskOutputSchema, annotations: mutationAnnotations
    }, input => run("claim_task", () => service.claimTask(validated(claimTaskInputSchema, input))) as never);
    server.registerTool("submit_report", {
      title: "Submit exchange report", description: "Publish one immutable final report for a task claimed by this worker. Described commands are never executed by MCP.", inputSchema: deferredValidation(submitReportInputSchema), outputSchema: submitReportOutputSchema, annotations: mutationAnnotations
    }, input => run("submit_report", () => service.submitReport(validated(submitReportInputSchema, input))) as never);
  }
}

// The SDK validates before invoking a handler and otherwise emits an unstructured error.
// Keep the advertised strict schema, defer its runtime parse into the instrumented handler,
// and return the same safe error envelope as all other exchange failures.
function deferredValidation<T extends z.ZodTypeAny>(schema: T): T {
  const wrapper = Object.create(schema) as T;
  Object.defineProperty(wrapper, "safeParseAsync", { value: async (input: unknown) => ({ success: true, data: input }) });
  return wrapper;
}

function validated<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map(issue => {
      // Strict object schemas only put declared field names and array indexes in paths.
      // Never echo issue.message, received values or unknown keys: they may contain secrets.
      const path = issue.path.reduce<string>((result, part) => typeof part === "number"
        ? `${result}[${part}]` : `${result}${result ? "." : ""}${part}`, "") || "$";
      return `${path}: ${validationHint(issue)}`;
    });
    const remainder = parsed.error.issues.length > 5 ? " Additional errors omitted." : "";
    throw new ExchangeError("INVALID_INPUT", `Invalid input: ${issues.join("; ")}.${remainder}`);
  }
  return parsed.data;
}

function validationHint(issue: z.ZodIssue): string {
  switch (issue.code) {
    case "invalid_type": return issue.received === "undefined" ? "required field is missing" : `expected ${issue.expected}`;
    case "invalid_string":
      if (issue.validation === "uuid") return "must be a UUID";
      if (issue.path.at(-1) === "sha256" || issue.path.at(-1) === "sha256After") return "must contain exactly 64 hexadecimal characters";
      return "must match the format in the tool schema";
    case "unrecognized_keys": return "unknown fields are not allowed; use only fields in the tool schema";
    case "invalid_enum_value": return `must be one of ${issue.options.join(", ")}`;
    case "invalid_literal": return "must match the literal in the tool schema";
    case "too_small": return `${issue.type} must be ${issue.inclusive ? "at least" : "greater than"} ${issue.minimum}`;
    case "too_big": return `${issue.type} must be ${issue.inclusive ? "at most" : "less than"} ${issue.maximum}`;
    default: return "must satisfy the tool schema";
  }
}
