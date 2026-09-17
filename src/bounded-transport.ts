import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Readable, Writable } from "node:stream";
import type { AppConfig } from "./config.js";

export const MAX_WIRE_BYTES = 8_000_000;
export function wireBytes(message: JSONRPCMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8") + 1; // stdio newline
}

/** Last line of defence: measure the actual serialized frame, including ID. */
export class BoundedStdioTransport extends StdioServerTransport {
  private readonly requestBudgets = new Map<string, number>();
  constructor(private readonly config: AppConfig, stdin?: Readable, stdout?: Writable) {
    super(stdin, stdout);
  }
  override async start(): Promise<void> {
    const onmessage = this.onmessage;
    this.onmessage = message => {
      if ("method" in message && message.method === "notifications/cancelled") {
        const params = message.params as { requestId?: string | number } | undefined;
        if (params?.requestId !== undefined) this.requestBudgets.delete(JSON.stringify(params.requestId));
      }
      if ("method" in message && message.method === "tools/call" && "id" in message) {
        const params = message.params as { name?: string; arguments?: { projectId?: string } } | undefined;
        if (["read_file", "list_files", "search_text"].includes(params?.name ?? "")) {
          const project = this.config.projects.find(item => item.projectId === params?.arguments?.projectId);
          // Unknown-project/validation errors still receive a small default cap.
          this.requestBudgets.set(JSON.stringify(message.id), project?.limits.maxResponseBytes ?? 131072);
        }
      }
      onmessage?.(message);
    };
    return super.start();
  }
  override async send(message: JSONRPCMessage): Promise<void> {
    let budget = MAX_WIRE_BYTES;
    if ("id" in message && !("method" in message)) {
      const key = JSON.stringify(message.id);
      budget = this.requestBudgets.get(key) ?? budget;
      this.requestBudgets.delete(key);
    }
    if ("result" in message) {
      const payload = message.result.structuredContent as Record<string, unknown> | undefined;
      if (payload?.trust === "UNTRUSTED_EVIDENCE") {
        const project = this.config.projects.find(item => item.projectId === payload.projectId);
        if (project) budget = Math.min(budget, project.limits.maxResponseBytes);
      }
    }
    if (wireBytes(message) <= budget) return super.send(message);
    if ("id" in message) {
      const replacement: JSONRPCMessage = { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "RESPONSE_PAGE_TOO_LARGE: serialized response exceeds the configured limit. Narrow the request or increase the project response budget." } };
      if (wireBytes(replacement) <= budget) return super.send(replacement);
    }
    // An oversized request ID cannot even fit in a bounded error frame.
    await this.close();
    throw new Error("Response cannot fit the wire budget, including its request ID.");
  }
  override async close(): Promise<void> {
    this.requestBudgets.clear();
    return super.close();
  }
}
