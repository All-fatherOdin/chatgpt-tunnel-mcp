import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AppConfig, ProjectConfig } from "./config.js";
import { continuation, decodeCursor, digest, PROJECT_READ_CONTRACT, ReadProtocolError, requireFits, responseBytes } from "./read-protocol.js";
import { assertGeneration, assertHandleGeneration, fileGeneration, indexText, lineOffset, readBytes, safePrefix, TextReadError } from "./text-index.js";

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

type Skip = { path: string; reason: string };
type CatalogEntry = { path: string; type: "file" | "directory"; generation: string };
type Catalog = { entries: CatalogEntry[]; skipped: Skip[]; generation: string };
// Policy exclusions are outside coverage. Failures inside the allowed scope are
// explicit targets, including directories whose descendants cannot be enumerated.
async function catalog(p: ProjectConfig, path: string, depth: number, searching = false): Promise<Catalog> {
  const start = await securePath(p, path, "directory");
  const entries: CatalogEntry[] = [], skipped: Skip[] = [];
  async function walk(absolute: string, rel: string, remaining: number): Promise<void> {
    let children;
    try { await securePath(p, rel, "directory"); children = await readdir(absolute, { withFileTypes: true }); }
    catch { skipped.push({ path: rel, reason: "DIRECTORY_UNREADABLE" }); return; }
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      const childRel = [rel, child.name].filter(Boolean).join("/");
      if (excluded(p, childRel)) continue;
      const childPath = resolve(absolute, child.name);
      try {
        const stat = await lstat(childPath);
        if (child.isSymbolicLink() || stat.isSymbolicLink()) { skipped.push({ path: childRel, reason: "LINK_FORBIDDEN" }); continue; }
        if (stat.isDirectory()) {
          entries.push({ path: childRel, type: "directory", generation: "directory" });
          if (remaining > 0) await walk(childPath, childRel, remaining - 1);
          else if (searching) skipped.push({ path: childRel, reason: "DEPTH_LIMIT" });
        } else if (stat.isFile()) entries.push({ path: childRel, type: "file", generation: await fileGeneration(childPath) });
        else skipped.push({ path: childRel, reason: "NOT_FILE" });
      } catch (error) {
        if (error instanceof ProjectError && error.code === "TOO_LARGE") throw error;
        skipped.push({ path: childRel, reason: "STAT_FAILED" });
      }
      if (entries.length + skipped.length > 100_000) throw new ProjectError("TOO_LARGE", "Catalog exceeds 100000 targets; narrow the path or listing depth.");
    }
  }
  await walk(start.absolute, start.relative, depth);
  return { entries, skipped, generation: digest({ entries, skipped }) };
}
type SkipSummary = { count: number; reasons: Record<string, number>; sample: Skip[]; digest: string };
function emptySkips(): SkipSummary { return { count: 0, reasons: {}, sample: [], digest: digest([]) }; }
function addSkip(summary: SkipSummary, item: Skip) {
  summary.count++; summary.reasons[item.reason] = (summary.reasons[item.reason] ?? 0) + 1;
  if (summary.sample.length < 5) summary.sample.push(item);
  summary.digest = digest([summary.digest, item]);
}
function summarizeSkips(skipped: Skip[]): SkipSummary {
  const summary = emptySkips(); for (const item of skipped) addSkip(summary, item); return summary;
}
function coverage(requested: number, processed: number, skipped: SkipSummary, complete: boolean, inProgress = false) {
  return {
    status: complete && skipped.count === 0 ? "complete" : processed === 0 && !inProgress ? "none" : "partial",
    scope: "requested range/path within project policy",
    requested_targets: requested, processed_targets: processed,
    pending_targets: Math.max(0, requested - processed - skipped.count),
    skipped_target_count: skipped.count, skipped_targets: skipped.sample,
    skipped_reason_counts: skipped.reasons, skipped_targets_digest_sha256: skipped.digest,
    skipped_digest_basis: "SHA-256 hash chain in traversal order"
  };
}
function original(input: object): Record<string, unknown> {
  const { cursor: _cursor, ...args } = input as Record<string, unknown>;
  return args;
}
async function stableCatalog(p: ProjectConfig, path: string, depth: number, expected: string, searching = false) {
  if ((await catalog(p, path, depth, searching)).generation !== expected) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "Directory contents changed during this page. Restart the original request.");
}

export async function listFiles(config: AppConfig, input: { projectId: string; path?: string | undefined; depth?: number | undefined; limit?: number | undefined; cursor?: string | undefined }) {
  const p = getProject(config, input.projectId), path = cleanRelative(input.path ?? "", true);
  const depth = clamp(input.depth, p.limits.maxDepth), limit = clamp(input.limit, p.limits.maxResults);
  const found = await catalog(p, path, depth), scope = digest(["list_files", p.root, p.excludePaths, p.projectId, path, depth]);
  const offset = decodeCursor<number>(input.cursor, scope, found.generation) ?? 0;
  const args = original(input), source_id = digest([p.projectId, path]), skipped = summarizeSkips(found.skipped);
  const build = (end: number) => {
    const next = end < found.entries.length ? continuation("list_files", args, scope, found.generation, end) : null;
    return {
      projectId: p.projectId, directory: path, depth, source_id, generation: found.generation,
      trust: "UNTRUSTED_EVIDENCE", read_contract: PROJECT_READ_CONTRACT,
      entries: found.entries.slice(offset, end).map(({ path, type }) => ({ path, type })),
      truncated: next !== null, nextCursor: next?.cursor ?? null, continuation: next,
      coverage: coverage(found.entries.length + found.skipped.length, end, skipped, next === null)
    };
  };
  // Binary search avoids repeatedly serializing thousands of rejected entries.
  let end = Math.min(found.entries.length, offset + limit), result = build(end);
  // Completion removes the cursor, so that last candidate can be smaller than
  // intermediate pages. Check it before assuming monotonically increasing size.
  if (responseBytes(result) > p.limits.maxResponseBytes) {
    let low = offset, high = end - 1; end = offset; result = build(offset);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2), candidate = build(middle);
      if (responseBytes(candidate) <= p.limits.maxResponseBytes) { end = middle; result = candidate; low = middle + 1; }
      else high = middle - 1;
    }
  }
  requireFits(result, p.limits.maxResponseBytes);
  if (end === offset && offset < found.entries.length) throw new ReadProtocolError("RESPONSE_PAGE_TOO_LARGE", "One listing entry cannot fit; increase the response limit or narrow the path.");
  await stableCatalog(p, path, depth, found.generation);
  return result;
}

type ReadPosition = { byte: number; line: number; endByte: number };
type Fragment = { line: number; text: string; startByte: number; endByte: number; lineComplete: boolean };
export async function readProjectFile(config: AppConfig, input: { projectId: string; path: string; startLine?: number | undefined; endLine?: number | undefined; cursor?: string | undefined }) {
  const p = getProject(config, input.projectId), target = await securePath(p, input.path, "file");
  try {
    const scope = digest(["read_file", p.root, p.excludePaths, p.projectId, target.relative, input.startLine ?? null, input.endLine ?? null]);
    // Validate the cursor before ranges: a truncated/replaced source must not
    // turn a stale chain into an unrelated INVALID_RANGE error.
    const generation = await fileGeneration(target.absolute);
    const resumed = decodeCursor<ReadPosition>(input.cursor, scope, generation);
    const index = await indexText(target.absolute, p.limits.maxFileBytes);
    if (index.generation !== generation) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "Source changed before indexing. Restart the original request.");
    const start = input.startLine ?? (index.totalLines ? 1 : 0), end = input.endLine ?? index.totalLines;
    if (index.totalLines === 0 ? ![0, 1].includes(start) || end !== 0 : start < 1 || end < start || end > index.totalLines) throw new ProjectError("INVALID_RANGE", "Invalid line range for this file.");
    const handle = await open(target.absolute, "r");
    try {
      await assertGeneration(target.absolute, index.generation);
      await assertHandleGeneration(handle, index.generation);
      const firstByte = resumed?.byte ?? (index.totalLines ? await lineOffset(handle, index, start) : index.bomBytes);
      const finalByte = resumed?.endByte ?? (end === index.totalLines ? index.size : await lineOffset(handle, index, end + 1));
      const position = resumed ?? { byte: firstByte, line: start || 1, endByte: finalByte };
      // Read bounded bytes plus lookahead to preserve UTF-8 and CRLF boundaries.
      const bytes = await readBytes(handle, firstByte, Math.min(finalByte - firstByte, p.limits.maxResponseBytes + 4));
      const args = original(input), readAtUtc = new Date().toISOString();
      const build = (maximum: number) => {
        let part = safePrefix(bytes, maximum);
        let newlines = 0;
        for (let i = 0; i < part.length; i++) if (part[i] === 10 && ++newlines === 750) { part = part.subarray(0, i + 1); break; }
        const fragments: Fragment[] = []; let from = 0, line = position.line;
        for (let i = 0; i < part.length; i++) if (part[i] === 10) {
          const textEnd = i > from && part[i - 1] === 13 ? i - 1 : i;
          fragments.push({ line, text: part.subarray(from, textEnd).toString("utf8"), startByte: firstByte + from, endByte: firstByte + i + 1, lineComplete: true });
          from = i + 1; line++;
        }
        const nextByte = firstByte + part.length;
        if (from < part.length) fragments.push({ line, text: part.subarray(from).toString("utf8"), startByte: firstByte + from, endByte: nextByte, lineComplete: nextByte === finalByte });
        const truncated = nextByte < finalByte;
        const next = truncated ? continuation("read_file", args, scope, index.generation, { byte: nextByte, line, endByte: finalByte }) : null;
        const completed = fragments.filter(item => item.lineComplete).length;
        return {
          projectId: p.projectId, path: target.relative,
          source_id: digest([p.projectId, target.relative]), generation: index.generation,
          trust: "UNTRUSTED_EVIDENCE", read_contract: PROJECT_READ_CONTRACT,
          content: fragments.map(item => item.text).join("\n"), lines: fragments,
          range: { startLine: fragments[0]?.line ?? 0, endLine: fragments.at(-1)?.line ?? 0, totalLines: index.totalLines },
          requestedRange: { startLine: start, endLine: end }, byteRange: { start: firstByte, end: nextByte },
          sha256: index.sha256,
          sha256Basis: "entire current file byte sequence exactly as read, before UTF-8 decoding and line selection",
          readAtUtc, truncated, nextStartLine: truncated ? line : null, continuation: next,
          coverage: {
            status: truncated ? "partial" : "complete", scope: "requestedRange",
            requested_lines: index.totalLines ? end - start + 1 : 0,
            completed_lines: index.totalLines ? position.line - (start || 1) + completed : 0,
            page_completed_lines: completed, skipped_targets: []
          }
        };
      };
      let best = build(Math.min(bytes.length, p.limits.maxResponseBytes));
      if (responseBytes(best) > p.limits.maxResponseBytes) {
        let low = 0, high = Math.min(bytes.length, p.limits.maxResponseBytes) - 1;
        best = build(0);
        while (low <= high) {
          const mid = Math.floor((low + high) / 2), candidate = build(mid);
          if (responseBytes(candidate) <= p.limits.maxResponseBytes) { best = candidate; low = mid + 1; } else high = mid - 1;
        }
      }
      requireFits(best, p.limits.maxResponseBytes);
      if (best.truncated && best.byteRange.end === firstByte) throw new ReadProtocolError("RESPONSE_PAGE_TOO_LARGE", "No text can fit with continuation metadata; increase the response limit.");
      await assertGeneration(target.absolute, index.generation);
      await assertHandleGeneration(handle, index.generation);
      return best;
    } finally { await handle.close(); }
  } catch (error) { if (error instanceof TextReadError || error instanceof ReadProtocolError) throw error; mapFsError(error); }
}

type SearchPosition = {
  file: number; byte: number; line: number; tail: string; snippet: string | null;
  processed: number; skipped: SkipSummary;
};
function prefixText(text: string, length: number): string {
  let end = Math.min(text.length, length);
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}
function tailText(text: string, length: number): string {
  let start = Math.max(0, text.length - length);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
  return text.slice(start);
}
export async function searchProjectText(config: AppConfig, input: { projectId: string; query: string; path?: string | undefined; limit?: number | undefined; snippetChars?: number | undefined; cursor?: string | undefined }) {
  const p = getProject(config, input.projectId), path = cleanRelative(input.path ?? "", true);
  const started = performance.now();
  const limit = clamp(input.limit, p.limits.maxResults), snippetChars = clamp(input.snippetChars, p.limits.maxSnippetChars);
  const contextChars = Math.max(0, Math.floor((snippetChars - input.query.length) / 2));
  const found = await catalog(p, path, 100, true), files = found.entries.filter(item => item.type === "file");
  const deadline = performance.now() + p.limits.searchTimeoutMs;
  const scope = digest(["search_text", p.root, p.excludePaths, p.projectId, path, input.query, snippetChars, p.limits.maxFileBytes]);
  const args = original(input);
  const pos = decodeCursor<SearchPosition>(input.cursor, scope, found.generation) ?? { file: 0, byte: 0, line: 1, tail: "", snippet: null, processed: 0, skipped: summarizeSkips(found.skipped) };
  const initialPosition = { file: pos.file, byte: pos.byte };
  const results: Array<{ path: string; line: number; snippet: string; source_id: string }> = [];
  let timedOut = false, responseLimitReached = false, resultLimitReached = false;
  let activeFile: { index: number; size: number } | undefined;
  const build = () => {
    // Price the completed-file checkpoint before accepting its final hit. EOF
    // removes the cursor for the last file and can make a small final page fit.
    const checkpoint = activeFile?.index === pos.file && activeFile.size === pos.byte
      ? { ...pos, file: pos.file + 1, byte: 0, line: 1, tail: "", snippet: null, processed: pos.processed + 1 }
      : pos;
    const done = checkpoint.file >= files.length;
    const next = done ? null : continuation("search_text", args, scope, found.generation, checkpoint);
    return {
      projectId: p.projectId, directory: path, source_id: digest([p.projectId, path]), generation: found.generation,
      trust: "UNTRUSTED_EVIDENCE", read_contract: PROJECT_READ_CONTRACT, snippetChars,
      progress: { next_path: files[checkpoint.file]?.path ?? null, next_line: done ? null : checkpoint.line, next_byte: done ? null : checkpoint.byte },
      results, limited: !done || checkpoint.skipped.count > 0,
      limits: { timedOut, responseLimitReached, resultLimitReached, skippedLargeOrBinary: checkpoint.skipped.count > 0 },
      continuation: next, nextCursor: next?.cursor ?? null,
      coverage: coverage(files.length + found.skipped.length, checkpoint.processed, checkpoint.skipped, done, checkpoint.byte > 0),
      searchDurationMs: Math.round(performance.now() - started)
    };
  };
  const advanceFile = () => { pos.file++; pos.byte = 0; pos.line = 1; pos.tail = ""; pos.snippet = null; };
  // Skip counts and the hash chain are cumulative; only five examples are kept.
  while (pos.file < files.length) {
    if (performance.now() >= deadline) { timedOut = true; break; }
    const file = files[pos.file]!;
    let handle;
    try {
      const target = await securePath(p, file.path, "file");
      await assertGeneration(target.absolute, file.generation);
      // Validate the complete file before emitting any hits: a binary/invalid
      // tail must not invalidate matches already returned on earlier pages.
      await indexText(target.absolute, p.limits.maxFileBytes);
      handle = await open(target.absolute, "r");
      await assertHandleGeneration(handle, file.generation);
      const stat = await handle.stat();
      activeFile = { index: pos.file, size: stat.size };
      if (stat.size > p.limits.maxFileBytes) throw new TextReadError("TOO_LARGE", "File exceeds the configured limit.");
      if (pos.byte === 0) {
        const head = await readBytes(handle, 0, Math.min(3, stat.size));
        if (head.equals(Buffer.from([0xef, 0xbb, 0xbf]))) pos.byte = 3;
      }
      while (pos.byte < stat.size) {
        if (performance.now() >= deadline) { timedOut = true; break; }
        const raw = await readBytes(handle, pos.byte, Math.min(4096 + 4, stat.size - pos.byte));
        if (!raw.length) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "Source shortened during search.");
        const chunk = safePrefix(raw, 4096);
        if (chunk.includes(0)) throw new TextReadError("BINARY_FILE", "Binary file.");
        try { new TextDecoder("utf-8", { fatal: true }).decode(chunk); } catch { throw new TextReadError("INVALID_UTF8", "Invalid UTF-8."); }
        let from = 0;
        while (from < chunk.length) {
          const newline = chunk.indexOf(10, from), end = newline < 0 ? chunk.length : newline + 1;
          const before = { ...pos }, resultCount = results.length;
          const segmentEnd = newline > from && chunk[newline - 1] === 13 ? newline - 1 : newline;
          const segment = chunk.subarray(from, newline < 0 ? end : segmentEnd).toString("utf8");
          if (pos.snippet !== null) pos.snippet = (pos.snippet + segment).slice(0, snippetChars + 1);
          else {
            const combined = pos.tail + segment, at = combined.indexOf(input.query);
            if (at >= 0) {
              let snippetStart = Math.max(0, at - contextChars);
              if (snippetStart > 0 && /[\uDC00-\uDFFF]/.test(combined[snippetStart]!)) snippetStart--;
              pos.snippet = combined.slice(snippetStart, snippetStart + snippetChars + 1);
              pos.tail = "";
            } else pos.tail = tailText(combined, Math.max(input.query.length - 1 + contextChars, 1));
          }
          pos.byte += end - from;
          const lineDone = newline >= 0 || pos.byte === stat.size;
          if (lineDone) {
            if (pos.snippet !== null) results.push({ path: file.path, line: pos.line, snippet: prefixText(pos.snippet, snippetChars), source_id: digest([p.projectId, file.path]) });
            pos.line++; pos.tail = ""; pos.snippet = null;
          }
          if (responseBytes(build()) > p.limits.maxResponseBytes) {
            Object.assign(pos, before); results.length = resultCount; responseLimitReached = true; break;
          }
          from = end;
          if (results.length >= limit) { resultLimitReached = true; break; }
        }
        if (resultLimitReached || responseLimitReached) break;
      }
      await assertGeneration(target.absolute, file.generation);
      await assertHandleGeneration(handle, file.generation);
      if (pos.byte === stat.size) { pos.processed++; advanceFile(); }
      if (timedOut || resultLimitReached || responseLimitReached) break;
    } catch (error) {
      if (error instanceof ReadProtocolError) throw error;
      const reason = error instanceof TextReadError || error instanceof ProjectError ? error.code : "READ_FAILED";
      addSkip(pos.skipped, { path: file.path, reason }); advanceFile();
      // A bounded page may stop before further failures grow its metadata.
      if (responseBytes(build()) > p.limits.maxResponseBytes) throw new ReadProtocolError("RESPONSE_PAGE_TOO_LARGE", "Skip metadata exceeds the response limit; narrow the search path.");
    } finally { await handle?.close(); }
  }
  const result = build(); requireFits(result, p.limits.maxResponseBytes);
  if (responseLimitReached && results.length === 0) throw new ReadProtocolError("RESPONSE_PAGE_TOO_LARGE", "Search state or one result cannot fit; reduce snippetChars or narrow the search path.");
  if (timedOut && pos.file === initialPosition.file && pos.byte === initialPosition.byte) throw new ReadProtocolError("SEARCH_TIMEOUT", "Search made no progress before its time limit. Narrow the path or increase searchTimeoutMs; do not repeat the unchanged request.");
  await stableCatalog(p, path, 100, found.generation, true);
  return result;
}
