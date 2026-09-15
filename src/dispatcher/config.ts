import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { assertCanonicalSeparation, assertNoLinks, loadConfig, pathsOverlap, prepareStoreDirectory, type AppConfig } from "../config.js";
import { executorOptionsSchema, scopeSchema } from "../exchange/schemas.js";

export const dispatcherConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workerConfig: z.string().min(1),
  statePath: z.string().min(1),
  codexCommand: z.string().min(1),
  codexArgs: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().min(1000).max(60000).default(5000),
  turnTimeoutMs: z.number().int().min(1000).max(86400000).default(1800000),
  executor: executorOptionsSchema.omit({ session: true }).extend({ model: z.string().min(1).max(200) }).strict(),
  projects: z.array(z.object({
    projectId: z.string().min(1).max(100),
    enabled: z.boolean().default(false),
    allowedPlannerIds: z.array(z.string().min(1)).min(1),
    allowWholeProject: z.boolean().default(false),
    allowedPaths: scopeSchema.shape.allowedPaths,
    executor: executorOptionsSchema.omit({ session: true }).default({}),
    maxSessionTasks: z.number().int().min(1).max(100).default(5),
    sandbox: z.enum(["read-only", "workspace-write"]).default("workspace-write")
  }).strict()).min(1).max(50)
}).strict();
export type DispatcherConfig = z.infer<typeof dispatcherConfigSchema>;
export type DispatchProject = DispatcherConfig["projects"][number];

export async function loadDispatcherConfig(path: string): Promise<{ config: DispatcherConfig; app: AppConfig }> {
  const file = resolve(path);
  const parsed = dispatcherConfigSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new Error("Invalid dispatcher config; check the example and field types.");
  const config = parsed.data;
  config.workerConfig = resolve(dirname(file), config.workerConfig);
  const app = await loadConfig(config.workerConfig);
  if (app.exchange?.role !== "worker") throw new Error("Dispatcher requires a worker exchange profile.");
  if (!isAbsolute(config.statePath) || config.statePath.startsWith("\\\\") || config.statePath.startsWith("//") || config.statePath.replaceAll("\\", "/").split("/").includes("..")) throw new Error("Dispatcher statePath must be an absolute local path.");
  config.statePath = resolve(config.statePath);
  if (app.exchange.dispatcherStatePath && app.exchange.dispatcherStatePath !== config.statePath) throw new Error("Worker dispatcherStatePath must match the dispatcher statePath.");
  if (pathsOverlap(config.statePath, app.exchange.storePath)) throw new Error("Dispatcher state must be separate from exchange storage.");
  for (const project of app.projects) if (pathsOverlap(config.statePath, project.root)) throw new Error("Dispatcher state must be outside project roots.");
  await prepareStoreDirectory(config.statePath);
  await assertCanonicalSeparation(config.statePath, app.projects);
  const seen = new Set<string>();
  for (const entry of config.projects) {
    const project = app.projects.find(item => item.projectId === entry.projectId);
    if (seen.has(entry.projectId) || !project || !app.exchange.allowedProjectIds.includes(entry.projectId)) throw new Error("Dispatcher project must be unique and allowed by worker config.");
    seen.add(entry.projectId);
    if (!entry.enabled) continue;
    if (!entry.allowWholeProject && entry.allowedPaths.length === 0) throw new Error("Enabled project needs allowedPaths or allowWholeProject.");
    await assertNoLinks(project.root);
    if (!(await stat(project.root)).isDirectory()) throw new Error("Project root must be an existing directory.");
    project.root = await realpath(project.root);
  }
  return { config, app };
}
