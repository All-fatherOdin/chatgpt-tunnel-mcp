import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { MAX_REPORT_BYTES, MAX_RESPONSE_BYTES, MAX_REVIEW_BYTES, MAX_TASK_BYTES, MIN_CONFIGURED_TASK_BYTES, MIN_EXCHANGE_RESPONSE_BYTES } from "./exchange/limits.js";

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

const exchangeLimitsSchema = z.object({
  maxTaskBytes: z.number().int().min(MIN_CONFIGURED_TASK_BYTES).max(MAX_TASK_BYTES).default(MAX_TASK_BYTES),
  maxReportBytes: z.number().int().positive().max(MAX_REPORT_BYTES).default(MAX_REPORT_BYTES),
  maxReviewBytes: z.number().int().positive().max(MAX_REVIEW_BYTES).default(MAX_REVIEW_BYTES),
  maxResponseBytes: z.number().int().min(MIN_EXCHANGE_RESPONSE_BYTES).max(MAX_RESPONSE_BYTES).default(MAX_RESPONSE_BYTES),
  defaultListLimit: z.number().int().positive().max(100).default(20),
  maxListLimit: z.number().int().positive().max(100).default(100),
  maxTasks: z.number().int().positive().max(10_000).default(10_000),
  maxHistoryBytes: z.number().int().positive().max(268_435_456).default(268_435_456),
  busyTimeoutMs: z.number().int().min(0).max(30_000).default(5_000)
}).strict().default({});

const disabledExchangeSchema = z.object({ enabled: z.literal(false) }).strict();
const enabledExchangeSchema = z.object({
  enabled: z.literal(true),
  storePath: z.string().min(1),
  dispatcherStatePath: z.string().min(1).optional(),
  principalId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  role: z.enum(["planner", "worker"]),
  allowedProjectIds: z.array(z.string().min(1).max(100)).min(1).max(50),
  limits: exchangeLimitsSchema
}).strict();

const configSchema = z.object({
  deviceId: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be an opaque, non-secret identifier"),
  probeFile: z.string().min(1),
  maxProbeBytes: z.number().int().positive().max(1_048_576).default(65_536),
  projects: z.array(projectSchema).max(50).optional(),
  exchange: z.union([disabledExchangeSchema, enabledExchangeSchema]).optional()
}).strict();

export type ProjectLimits = z.infer<typeof limitsSchema>;
export type ProjectConfig = Omit<z.infer<typeof projectSchema>, "root"> & { root: string };
export type ExchangeLimits = z.infer<typeof exchangeLimitsSchema>;
export type ExchangeConfig = Omit<z.infer<typeof enabledExchangeSchema>, "storePath"> & { storePath: string };
export type AppConfig = { deviceId: string; probeFile: string; maxProbeBytes: number; projects: ProjectConfig[]; exchange?: ExchangeConfig | undefined };

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
  let exchange: ExchangeConfig | undefined;
  if (result.data.exchange?.enabled === true) {
    if (result.data.exchange.limits.defaultListLimit > result.data.exchange.limits.maxListLimit) throw new Error("Invalid config: exchange defaultListLimit must not exceed maxListLimit");
    const allowed = new Set(result.data.exchange.allowedProjectIds);
    if (allowed.size !== result.data.exchange.allowedProjectIds.length) throw new Error("Invalid config: exchange allowedProjectIds contains duplicates");
    for (const allowedId of allowed) if (!ids.has(allowedId)) throw new Error(`Invalid config: exchange references unknown projectId '${allowedId}'`);
    if (!isAbsolute(result.data.exchange.storePath) || isNetworkPath(result.data.exchange.storePath) || hasTraversal(result.data.exchange.storePath)) throw new Error("Invalid config: exchange storePath must be an absolute local path without traversal");
    const storePath = resolve(result.data.exchange.storePath);
    for (const project of projects) if (pathsOverlap(storePath, project.root)) throw new Error("Invalid config: exchange storePath must be outside every project root");
    await prepareStoreDirectory(storePath);
    await assertCanonicalSeparation(storePath, projects);
    exchange = { ...result.data.exchange, storePath };
    if (exchange.dispatcherStatePath) {
      const path = exchange.dispatcherStatePath;
      if (!isAbsolute(path) || isNetworkPath(path) || hasTraversal(path) || pathsOverlap(path, storePath) || projects.some(project => pathsOverlap(path, project.root))) throw new Error("Invalid config: dispatcherStatePath must be separate absolute local storage outside project roots");
      exchange.dispatcherStatePath = resolve(path);
      await prepareStoreDirectory(exchange.dispatcherStatePath);
      await assertCanonicalSeparation(exchange.dispatcherStatePath, projects);
    }
  }
  return {
    deviceId: result.data.deviceId,
    probeFile: isAbsolute(result.data.probeFile) ? resolve(result.data.probeFile) : resolve(dirname(absoluteConfigPath), result.data.probeFile),
    maxProbeBytes: result.data.maxProbeBytes,
    projects,
    ...(exchange ? { exchange } : {})
  };
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isSafeRelative(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return !isAbsolute(value) && !normalized.startsWith("/") && !normalized.includes(":") && !normalized.includes("\0") && !normalized.split("/").includes("..");
}

function isNetworkPath(value: string): boolean {
  const normalized = value.replaceAll("/", "\\");
  return normalized.startsWith("\\\\");
}

function hasTraversal(value: string): boolean { return value.replaceAll("\\", "/").split("/").includes(".."); }

export function pathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  const a = normalize(left), b = normalize(right);
  const ab = relative(a, b), ba = relative(b, a);
  const inside = (value: string) => value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
  return inside(ab) || inside(ba);
}

export async function prepareStoreDirectory(storePath: string): Promise<void> {
  const directory = dirname(storePath);
  try {
    await assertNoLinks(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertNoLinks(directory);
    if (process.platform !== "win32") await chmod(directory, 0o700);
    try {
      const existing = await lstat(storePath);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("exchange storePath must name a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch {
    throw new Error("Invalid config: exchange storage directory is unavailable or contains a link/reparse point");
  }
}

export async function assertNoLinks(targetDirectory: string): Promise<void> {
  const root = parse(targetDirectory).root;
  const parts = relative(root, targetDirectory).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function assertCanonicalSeparation(storePath: string, projects: ProjectConfig[]): Promise<void> {
  try {
    const storeReal = resolve(await realpath(dirname(storePath)), basename(storePath));
    for (const project of projects) {
      try {
        if ((await lstat(project.root)).isSymbolicLink()) throw new Error("linked project root");
        if (pathsOverlap(storeReal, await realpath(project.root))) throw new Error("overlap");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch {
    throw new Error("Invalid config: exchange storage cannot be canonically separated from project roots");
  }
}
