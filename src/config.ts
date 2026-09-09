import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const limitsSchema = z.object({
  maxFileBytes: z.number().int().positive().max(4_194_304).default(1_048_576),
  maxResponseBytes: z.number().int().positive().max(1_048_576).default(131_072),
  maxResults: z.number().int().positive().max(2_000).default(200),
  maxDepth: z.number().int().min(0).max(20).default(8),
  searchTimeoutMs: z.number().int().positive().max(30_000).default(5_000),
  maxSnippetChars: z.number().int().positive().max(2_000).default(300)
}).strict().default({});

const projectSchema = z.object({
  projectId: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1).max(200),
  description: z.string().max(1_000).default(""),
  root: z.string().min(1),
  readOnly: z.literal(true),
  excludePaths: z.array(z.string().min(1).max(1_000)).max(200).default([]),
  entryDocuments: z.array(z.object({ label: z.string().min(1).max(100), path: z.string().min(1).max(1_000) }).strict()).max(50).default([]),
  limits: limitsSchema
}).strict();

const configSchema = z.object({
  deviceId: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be an opaque, non-secret identifier"),
  probeFile: z.string().min(1),
  maxProbeBytes: z.number().int().positive().max(1_048_576).default(65_536),
  projects: z.array(projectSchema).max(50).optional()
}).strict();

export type ProjectLimits = z.infer<typeof limitsSchema>;
export type ProjectConfig = Omit<z.infer<typeof projectSchema>, "root"> & { root: string };
export type AppConfig = { deviceId: string; probeFile: string; maxProbeBytes: number; projects: ProjectConfig[] };

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absoluteConfigPath = resolve(configPath);
  let raw: string;
  try { raw = await readFile(absoluteConfigPath, "utf8"); }
  catch (error) { throw new Error(`Cannot read config file: ${errorMessage(error)}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`Config file is not valid JSON: ${errorMessage(error)}`); }
  const result = configSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid config: ${result.error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  const ids = new Set<string>();
  const projects = (result.data.projects ?? []).map(item => {
    if (ids.has(item.projectId)) throw new Error(`Invalid config: duplicate projectId '${item.projectId}'`);
    ids.add(item.projectId);
    if (!isAbsolute(item.root)) throw new Error(`Invalid config: root for project '${item.projectId}' must be absolute`);
    for (const value of [...item.excludePaths, ...item.entryDocuments.map(document => document.path)]) {
      if (!isSafeRelative(value)) throw new Error(`Invalid config: project '${item.projectId}' contains a non-relative navigation or exclusion path`);
    }
    return { ...item, root: resolve(item.root) };
  });
  return {
    deviceId: result.data.deviceId,
    probeFile: isAbsolute(result.data.probeFile) ? resolve(result.data.probeFile) : resolve(dirname(absoluteConfigPath), result.data.probeFile),
    maxProbeBytes: result.data.maxProbeBytes,
    projects
  };
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isSafeRelative(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return !isAbsolute(value) && !normalized.startsWith("/") && !normalized.includes(":") && !normalized.includes("\0") && !normalized.split("/").includes("..");
}
