import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { AppConfig } from "./config.js";

export type ProbeResult = {
  text: string;
  sha256: string;
  readAtUtc: string;
};

export class ProbeError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "TOO_LARGE" | "ACCESS_DENIED" | "INVALID_UTF8" | "READ_FAILED", message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

export async function readProbe(config: AppConfig): Promise<ProbeResult> {
  let handle;
  try {
    handle = await open(config.probeFile, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ProbeError("READ_FAILED", "Configured probe path is not a regular file.");
    if (stat.size > config.maxProbeBytes) throw tooLarge(config.maxProbeBytes);

    const buffer = Buffer.alloc(config.maxProbeBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > config.maxProbeBytes) throw tooLarge(config.maxProbeBytes);
    const content = buffer.subarray(0, bytesRead);

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new ProbeError("INVALID_UTF8", "The configured probe file is not valid UTF-8.");
    }

    return {
      text,
      sha256: createHash("sha256").update(content).digest("hex"),
      readAtUtc: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new ProbeError("NOT_FOUND", "The configured probe file does not exist.");
    if (code === "EACCES" || code === "EPERM") throw new ProbeError("ACCESS_DENIED", "Access to the configured probe file was denied.");
    throw new ProbeError("READ_FAILED", "The configured probe file could not be read.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function tooLarge(limit: number): ProbeError {
  return new ProbeError("TOO_LARGE", `The configured probe file exceeds the ${limit}-byte limit.`);
}
