import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { digest, ReadProtocolError } from "./read-protocol.js";

const BLOCK = 64 * 1024;
const STRIDE = 750;
export interface TextIndex { generation: string; sha256: string; size: number; totalLines: number; checkpoints: number[]; bomBytes: number }
const cache = new Map<string, TextIndex>();
const MAX_CACHE_CHECKPOINTS = 250_000;

export async function fileGeneration(path: string): Promise<string> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "Source is no longer a regular file.");
  return statGeneration(stat);
}
function statGeneration(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) {
  return digest([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
}
export async function assertGeneration(path: string, expected: string) {
  if (await fileGeneration(path) !== expected) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "Source changed during the read. Discard this generation and restart the original request.");
}
export async function assertHandleGeneration(handle: FileHandle, expected: string) {
  if (statGeneration(await handle.stat({ bigint: true })) !== expected) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "The open file no longer matches the pinned generation.");
}
export async function readBytes(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const part = await handle.read(bytes, read, length - read, offset + read);
    if (!part.bytesRead) break;
    read += part.bytesRead;
  }
  return bytes.subarray(0, read);
}

// Initial read streams once for SHA-256, UTF-8 validation and a sparse line
// index. Subsequent pages seek directly; cached state never contains file text.
export async function indexText(path: string, maximum: number): Promise<TextIndex> {
  const generation = await fileGeneration(path);
  const cached = cache.get(path);
  if (cached?.generation === generation && cached.size <= maximum) {
    cache.delete(path); cache.set(path, cached); return cached;
  }
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat({ bigint: true });
    if (statGeneration(stat) !== generation) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "Source changed while opening it.");
    const size = Number(stat.size);
    if (size > maximum) throw new TextReadError("TOO_LARGE", `File exceeds the configured ${maximum}-byte limit.`);
    const hash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true });
    const checkpoints = [0]; let newlines = 0, lastByte = -1, bomBytes = 0;
    for (let offset = 0; offset < size;) {
      const bytes = await readBytes(handle, offset, Math.min(BLOCK, size - offset));
      if (!bytes.length) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "Source became shorter during indexing.");
      if (offset === 0 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) { bomBytes = 3; checkpoints[0] = 3; }
      if (bytes.includes(0)) throw new TextReadError("BINARY_FILE", "Binary files are not readable as text.");
      try { decoder.decode(bytes, { stream: true }); } catch { throw new TextReadError("INVALID_UTF8", "The file is not valid UTF-8."); }
      hash.update(bytes);
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
        newlines++;
        if (newlines % STRIDE === 0) checkpoints.push(offset + i + 1);
      }
      lastByte = bytes.at(-1)!; offset += bytes.length;
    }
    try { decoder.decode(); } catch { throw new TextReadError("INVALID_UTF8", "The file is not valid UTF-8."); }
    await assertGeneration(path, generation);
    await assertHandleGeneration(handle, generation);
    const result = { generation, sha256: hash.digest("hex"), size, totalLines: size === bomBytes ? 0 : newlines + (lastByte === 10 ? 0 : 1), checkpoints, bomBytes };
    cache.delete(path); cache.set(path, result);
    let count = [...cache.values()].reduce((sum, value) => sum + value.checkpoints.length, 0);
    while (cache.size > 32 || count > MAX_CACHE_CHECKPOINTS) {
      const first = cache.keys().next().value!; count -= cache.get(first)!.checkpoints.length; cache.delete(first);
    }
    return result;
  } finally { await handle.close(); }
}
export class TextReadError extends Error {
  constructor(public readonly code: "TOO_LARGE" | "BINARY_FILE" | "INVALID_UTF8", message: string) { super(message); }
}

export async function lineOffset(handle: FileHandle, index: TextIndex, line: number): Promise<number> {
  if (line > index.totalLines) return index.size;
  const block = Math.floor((line - 1) / STRIDE);
  let current = block * STRIDE + 1, offset = index.checkpoints[block]!;
  while (current < line) {
    const bytes = await readBytes(handle, offset, Math.min(BLOCK, index.size - offset));
    if (!bytes.length) throw new ReadProtocolError("SOURCE_CHANGED_DURING_READ", "Source became shorter during seeking.");
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10 && ++current === line) return offset + i + 1;
    offset += bytes.length;
  }
  return offset;
}

// Return a prefix ending at a UTF-8 boundary. Keep CRLF together so a page
// cannot mistake a partial CR for literal text or lose the line terminator.
export function safePrefix(bytes: Buffer, maximum: number): Buffer {
  let end = Math.min(bytes.length, maximum);
  if (end < bytes.length) {
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end > 0 && bytes[end - 1] === 13 && bytes[end] === 10) end--;
  }
  return bytes.subarray(0, end);
}
