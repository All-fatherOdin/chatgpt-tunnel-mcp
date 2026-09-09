import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AppConfig, ProjectConfig } from "./config.js";

export type ProjectErrorCode = "UNKNOWN_PROJECT" | "INVALID_PATH" | "EXCLUDED" | "NOT_FOUND" | "NOT_FILE" | "NOT_DIRECTORY" | "LINK_FORBIDDEN" | "TOO_LARGE" | "BINARY_FILE" | "INVALID_UTF8" | "INVALID_RANGE" | "ACCESS_DENIED" | "READ_FAILED";
export class ProjectError extends Error {
  constructor(public readonly code: ProjectErrorCode, message: string) { super(message); this.name = "ProjectError"; }
}

const DEFAULT_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "target", ".next", ".cache", "coverage", "vendor"]);
const DEFAULT_FILES = new Set([".env", ".env.local", ".env.production", ".env.development", "credentials.json", "secrets.json", "service-account.json", "id_rsa", "id_ed25519"]);
const DEFAULT_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx", ".jks", ".keystore", ".sqlite", ".sqlite3", ".db", ".mdb", ".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".mp3", ".mp4", ".mov", ".avi", ".wav"]);

export function publicProjects(config: AppConfig) {
  return config.projects.map(({ projectId, name, description, entryDocuments }) => ({ projectId, name, description, entryDocuments }));
}
function getProject(config: AppConfig, id: string): ProjectConfig {
  const found = config.projects.find(item => item.projectId === id);
  if (!found) throw new ProjectError("UNKNOWN_PROJECT", "Unknown or unauthorized project_id.");
  return found;
}
function cleanRelative(input: string, allowEmpty = false): string {
  if (typeof input !== "string" || (!allowEmpty && input.length === 0)) throw new ProjectError("INVALID_PATH", "A non-empty relative path is required.");
  if (input.includes("\0") || input.includes(":")) throw new ProjectError("INVALID_PATH", "Path contains a forbidden character.");
  const slash = input.replaceAll("\\", "/");
  if (isAbsolute(input) || slash.startsWith("/") || slash.startsWith("//") || /^\\\\[.?]\\/.test(input)) throw new ProjectError("INVALID_PATH", "Absolute, UNC, and device paths are forbidden.");
  const parts = slash.split("/").filter(part => part !== "" && part !== ".");
  if (parts.some(part => part === "..")) throw new ProjectError("INVALID_PATH", "Parent traversal is forbidden.");
  return parts.join("/");
}
function excluded(p: ProjectConfig, rel: string): boolean {
  const normalized = rel.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some(part => DEFAULT_DIRS.has(part))) return true;
  const file = parts.at(-1) ?? "";
  if (DEFAULT_FILES.has(file) || file.startsWith(".env.") || /(?:secret|credential)s?\.(?:json|ya?ml|toml|ini)$/i.test(file)) return true;
  const dot = file.lastIndexOf(".");
  if (dot >= 0 && DEFAULT_EXTENSIONS.has(file.slice(dot))) return true;
  return p.excludePaths.some(prefix => {
    const cleaned = cleanRelative(prefix).toLowerCase();
    return normalized === cleaned || normalized.startsWith(`${cleaned}/`);
  });
}
async function securePath(p: ProjectConfig, requested: string, kind: "file" | "directory") {
  const rel = cleanRelative(requested, kind === "directory");
  if (excluded(p, rel)) throw new ProjectError("EXCLUDED", "The requested path is excluded by project policy.");
  const absolute = resolve(p.root, ...rel.split("/").filter(Boolean));
  const within = relative(p.root, absolute);
  if (within.startsWith(`..${sep}`) || within === ".." || isAbsolute(within)) throw new ProjectError("INVALID_PATH", "Path escapes the configured project root.");
  try {
    const rootInfo = await lstat(p.root);
    if (rootInfo.isSymbolicLink()) throw new ProjectError("LINK_FORBIDDEN", "The configured project root cannot be a link.");
    const rootReal = await realpath(p.root);
    let cursor = p.root;
    for (const part of rel.split("/").filter(Boolean)) {
      cursor = resolve(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new ProjectError("LINK_FORBIDDEN", "Symbolic links, junctions, and reparse-point traversal are forbidden.");
    }
    const targetReal = await realpath(absolute);
    const realWithin = relative(rootReal, targetReal);
    if (realWithin.startsWith(`..${sep}`) || realWithin === ".." || isAbsolute(realWithin)) throw new ProjectError("LINK_FORBIDDEN", "Resolved path leaves the configured project root.");
    const info = await lstat(absolute);
    if (kind === "file" && !info.isFile()) throw new ProjectError("NOT_FILE", "The requested path is not a regular file.");
    if (kind === "directory" && !info.isDirectory()) throw new ProjectError("NOT_DIRECTORY", "The requested path is not a directory.");
  } catch (error) { mapFsError(error); }
  return { absolute, relative: rel };
}
function mapFsError(error: unknown): never {
  if (error instanceof ProjectError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") throw new ProjectError("NOT_FOUND", "The requested path does not exist.");
  if (code === "EACCES" || code === "EPERM") throw new ProjectError("ACCESS_DENIED", "Access to the requested path was denied.");
  throw new ProjectError("READ_FAILED", "The requested path could not be inspected or read.");
}
function clamp(value: number | undefined, maximum: number) { return value === undefined ? maximum : Math.min(value, maximum); }
function encodeCursor(offset: number) { return Buffer.from(String(offset)).toString("base64url"); }
function decodeCursor(cursor: string | undefined) {
  if (!cursor) return 0;
  const value = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/.test(value)) throw new ProjectError("INVALID_PATH", "Invalid continuation cursor.");
  return Number(value);
}

export async function listFiles(config: AppConfig, input: { projectId: string; path?: string | undefined; depth?: number | undefined; limit?: number | undefined; cursor?: string | undefined }) {
  const p = getProject(config, input.projectId);
  const start = await securePath(p, input.path ?? "", "directory");
  const depth = clamp(input.depth, p.limits.maxDepth), limit = clamp(input.limit, p.limits.maxResults);
  const all: Array<{ path: string; type: "file" | "directory" }> = [];
  async function walk(absolute: string, rel: string, remaining: number): Promise<void> {
    let entries; try { entries = await readdir(absolute, { withFileTypes: true }); } catch (error) { mapFsError(error); }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const childRel = [rel, entry.name].filter(Boolean).join("/");
      const childAbsolute = resolve(absolute, entry.name);
      if (excluded(p, childRel) || entry.isSymbolicLink() || (await lstat(childAbsolute)).isSymbolicLink()) continue;
      if (entry.isDirectory()) { all.push({ path: childRel, type: "directory" }); if (remaining > 0) await walk(childAbsolute, childRel, remaining - 1); }
      else if (entry.isFile()) all.push({ path: childRel, type: "file" });
    }
  }
  await walk(start.absolute, start.relative, depth);
  const offset = decodeCursor(input.cursor);
  if (offset > all.length) throw new ProjectError("INVALID_PATH", "Continuation cursor is outside the current result set.");
  const entries = all.slice(offset, offset + limit), next = offset + entries.length;
  return { projectId: p.projectId, directory: start.relative, depth, entries, truncated: next < all.length, nextCursor: next < all.length ? encodeCursor(next) : null };
}

async function bytesForFile(p: ProjectConfig, absolute: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(absolute, "r"); const stat = await handle.stat();
    if (stat.size > p.limits.maxFileBytes) throw new ProjectError("TOO_LARGE", `File exceeds the configured ${p.limits.maxFileBytes}-byte limit.`);
    const buffer = Buffer.alloc(stat.size); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead);
  } catch (error) { mapFsError(error); } finally { await handle?.close().catch(() => undefined); }
  throw new ProjectError("READ_FAILED", "The requested file could not be read.");
}
function decodeText(bytes: Buffer) {
  if (bytes.includes(0)) throw new ProjectError("BINARY_FILE", "Binary files are not readable as text.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ProjectError("INVALID_UTF8", "The file is not valid UTF-8."); }
}

export async function readProjectFile(config: AppConfig, input: { projectId: string; path: string; startLine?: number | undefined; endLine?: number | undefined }) {
  const p = getProject(config, input.projectId), target = await securePath(p, input.path, "file");
  const bytes = await bytesForFile(p, target.absolute), text = decodeText(bytes);
  const lines = text.length === 0 ? [] : text.split(/\r?\n/); if (text.endsWith("\n")) lines.pop();
  const totalLines = lines.length, start = input.startLine ?? (totalLines === 0 ? 0 : 1), requestedEnd = input.endLine ?? totalLines;
  if (totalLines === 0) {
    if ((input.startLine !== undefined && ![0, 1].includes(input.startLine)) || (input.endLine !== undefined && input.endLine !== 0)) throw new ProjectError("INVALID_RANGE", "The empty file has no readable line range.");
  } else if (start < 1 || requestedEnd < start || start > totalLines || requestedEnd > totalLines) throw new ProjectError("INVALID_RANGE", "Invalid line range for this file.");
  const selected: Array<{ line: number; text: string }> = []; let used = 0;
  for (let number = totalLines === 0 ? 1 : start; number <= Math.min(requestedEnd, totalLines); number++) {
    const value = lines[number - 1]!, cost = Buffer.byteLength(value, "utf8") + 32;
    if (selected.length > 0 && used + cost > p.limits.maxResponseBytes) break;
    if (cost > p.limits.maxResponseBytes) { selected.push({ line: number, text: Buffer.from(value).subarray(0, Math.max(0, p.limits.maxResponseBytes - 64)).toString("utf8") }); break; }
    selected.push({ line: number, text: value }); used += cost;
  }
  const actualEnd = selected.at(-1)?.line ?? 0, truncated = actualEnd < Math.min(requestedEnd, totalLines);
  return { projectId: p.projectId, path: target.relative, content: selected.map(item => item.text).join("\n"), lines: selected, range: { startLine: selected[0]?.line ?? 0, endLine: actualEnd, totalLines }, sha256: createHash("sha256").update(bytes).digest("hex"), sha256Basis: "entire current file byte sequence exactly as read, before UTF-8 decoding and line selection", readAtUtc: new Date().toISOString(), truncated, nextStartLine: truncated ? actualEnd + 1 : null };
}

export async function searchProjectText(config: AppConfig, input: { projectId: string; query: string; path?: string | undefined; limit?: number | undefined; snippetChars?: number | undefined }) {
  const p = getProject(config, input.projectId), start = await securePath(p, input.path ?? "", "directory");
  const limit = clamp(input.limit, p.limits.maxResults), snippetChars = clamp(input.snippetChars, p.limits.maxSnippetChars), started = performance.now(), deadline = started + p.limits.searchTimeoutMs;
  const results: Array<{ path: string; line: number; snippet: string }> = []; let timedOut = false, resultLimitReached = false, responseLimitReached = false, skippedLargeOrBinary = false, responseBytes = 0;
  async function walk(absolute: string, rel: string): Promise<void> {
    if (performance.now() >= deadline) { timedOut = true; return; }
    let entries; try { entries = await readdir(absolute, { withFileTypes: true }); } catch (error) { mapFsError(error); }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (performance.now() >= deadline) { timedOut = true; return; }
      const childRel = [rel, entry.name].filter(Boolean).join("/");
      const child = resolve(absolute, entry.name);
      if (excluded(p, childRel) || entry.isSymbolicLink() || (await lstat(child)).isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(child, childRel);
      else if (entry.isFile()) {
        try {
          const lines = decodeText(await bytesForFile(p, child)).split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) { const at = lines[i]!.indexOf(input.query); if (at < 0) continue; const from = Math.max(0, at - Math.floor((snippetChars - input.query.length) / 2)); const match = { path: childRel, line: i + 1, snippet: lines[i]!.slice(from, from + snippetChars) }; const cost = Buffer.byteLength(JSON.stringify(match), "utf8"); if (responseBytes + cost > p.limits.maxResponseBytes) { responseLimitReached = true; return; } results.push(match); responseBytes += cost; if (results.length >= limit) { resultLimitReached = true; return; } }
        } catch (error) { if (error instanceof ProjectError && ["TOO_LARGE", "BINARY_FILE", "INVALID_UTF8", "ACCESS_DENIED", "READ_FAILED"].includes(error.code)) skippedLargeOrBinary = true; else throw error; }
      }
      if (resultLimitReached || responseLimitReached || timedOut) return;
    }
  }
  await walk(start.absolute, start.relative);
  return { projectId: p.projectId, directory: start.relative, results, limited: timedOut || resultLimitReached || responseLimitReached || skippedLargeOrBinary, limits: { timedOut, resultLimitReached, responseLimitReached, skippedLargeOrBinary }, searchDurationMs: Math.round((performance.now() - started) * 100) / 100 };
}
