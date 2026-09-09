import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { errorMessage } from "./config.js";
import { logToolCall } from "./logger.js";
import { ProbeError, readProbe } from "./probe.js";

export const SERVER_NAME = "chatgpt-tunnel-mcp";
export const SERVER_VERSION = "0.1.0";

const emptyInput = z.object({}).strict();
const pingOutput = z.object({
  utcTime: z.string(),
  serverVersion: z.string(),
  deviceId: z.string()
});
const probeOutput = z.object({
  text: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  readAtUtc: z.string()
});

export function createServer(config: AppConfig): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool("ping", {
    title: "Ping local probe server",
    description: "Check that the local MCP server is reachable. Returns UTC time, server version, and an opaque configured device identifier.",
    inputSchema: emptyInput,
    outputSchema: pingOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => instrument("ping", async () => ({
    utcTime: new Date().toISOString(),
    serverVersion: SERVER_VERSION,
    deviceId: config.deviceId
  })));

  server.registerTool("read_probe", {
    title: "Read configured probe file",
    description: "Read only the single UTF-8 probe file selected by local configuration. The caller cannot provide or change its path. Returns current text, its SHA-256, and UTC read time.",
    inputSchema: emptyInput,
    outputSchema: probeOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => instrument("read_probe", () => readProbe(config)));

  return server;
}

async function instrument<T extends Record<string, unknown>>(tool: string, operation: () => Promise<T> | T) {
  const correlationId = randomUUID();
  const started = performance.now();
  try {
    const structuredContent = await operation();
    logToolCall({ tool, correlationId, durationMs: roundedDuration(started), outcome: "success" });
    return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
  } catch (error) {
    const errorCode = error instanceof ProbeError ? error.code : "UNEXPECTED";
    logToolCall({ tool, correlationId, durationMs: roundedDuration(started), outcome: "error", errorCode });
    return {
      content: [{ type: "text" as const, text: error instanceof ProbeError ? error.message : `Tool failed: ${errorMessage(error)}` }],
      isError: true as const
    };
  }
}

function roundedDuration(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}
