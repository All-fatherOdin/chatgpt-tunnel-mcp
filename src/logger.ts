export type ToolOutcome = "success" | "error";

export function logToolCall(event: {
  tool: string;
  correlationId: string;
  durationMs: number;
  outcome: ToolOutcome;
  errorCode?: string;
}): void {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}
