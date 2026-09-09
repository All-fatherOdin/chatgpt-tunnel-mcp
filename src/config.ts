import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  deviceId: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be an opaque, non-secret identifier"),
  probeFile: z.string().min(1),
  maxProbeBytes: z.number().int().positive().max(1_048_576).default(65_536)
}).strict();

export type AppConfig = {
  deviceId: string;
  probeFile: string;
  maxProbeBytes: number;
};

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absoluteConfigPath = resolve(configPath);
  let raw: string;
  try {
    raw = await readFile(absoluteConfigPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read config file ${absoluteConfigPath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${errorMessage(error)}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  }

  const probeFile = isAbsolute(result.data.probeFile)
    ? resolve(result.data.probeFile)
    : resolve(dirname(absoluteConfigPath), result.data.probeFile);

  return { ...result.data, probeFile };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
