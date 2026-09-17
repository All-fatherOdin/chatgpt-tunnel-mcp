import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, appendFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import type { AppConfig, ProjectLimits } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { listFiles, readProjectFile, searchProjectText } from "../src/projects.js";
import { ReadProtocolError, responseBytes, toolResult } from "../src/read-protocol.js";
import { indexText } from "../src/text-index.js";
import { BoundedStdioTransport, MAX_WIRE_BYTES } from "../src/bounded-transport.js";

async function fixture(t: TestContext, limits: Partial<ProjectLimits> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-read-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: AppConfig = { deviceId: "read-test-device", probeFile: "", maxProbeBytes: 100, projects: [{ projectId: "test", name: "test", description: "", root, readOnly: true, excludePaths: [], entryDocuments: [], limits: { maxFileBytes: 32 * 1024 * 1024, maxResponseBytes: 16384, maxResults: 200, maxDepth: 8, searchTimeoutMs: 5000, maxSnippetChars: 300, ...limits } }] };
  return { root, config, limits: config.projects[0]!.limits };
}
type ReadInput = Parameters<typeof readProjectFile>[1];
type SearchInput = Parameters<typeof searchProjectText>[1];
function code(expected: string) { return (error: unknown) => error instanceof ReadProtocolError && error.code === expected; }

test("long UTF-8 lines round-trip across bounded pages, with CRLF, blanks, escapes and EOF", async t => {
  const { root, config, limits } = await fixture(t);
  const expected = ["short", "", '😀кириллица\\\"\t'.repeat(4000), "", "tail\r"];
  const bytes = Buffer.from("\uFEFF" + expected.join("\r\n"));
  await writeFile(join(root, "log.txt"), bytes);
  let args: ReadInput = { projectId: "test", path: "log.txt" };
  const reconstructed = new Map<number, string>();
  let previousByte = 3, pages = 0, generation = "";
  for (;;) {
    const page = await readProjectFile(config, args); pages++;
    assert.ok(pages < 500, "continuation must progress");
    assert.ok(responseBytes(page) <= limits.maxResponseBytes);
    assert.equal(page.byteRange.start, previousByte);
    assert.ok(page.byteRange.end > previousByte);
    previousByte = page.byteRange.end;
    if (generation) assert.equal(page.generation, generation);
    generation = page.generation;
    assert.equal(page.sha256, createHash("sha256").update(bytes).digest("hex"));
    for (const item of page.lines) {
      assert.ok(!item.text.includes("\uFFFD"));
      reconstructed.set(item.line, (reconstructed.get(item.line) ?? "") + item.text);
    }
    if (!page.continuation) {
      assert.equal(page.coverage.status, "complete");
      assert.equal(page.coverage.completed_lines, expected.length);
      break;
    }
    assert.equal(page.coverage.status, "partial");
    assert.equal(page.truncated, true);
    assert.equal(page.continuation.next_tool, "read_file");
    // Simulates saved/restored anchors after conversation compaction.
    args = JSON.parse(JSON.stringify(page.continuation.next_arguments)) as ReadInput;
  }
  assert.ok(pages > 2);
  assert.equal(previousByte, bytes.length);
  assert.deepEqual([...reconstructed.values()], expected);
});

test("single long final line never claims completion before its last fragment", async t => {
  const { root, config } = await fixture(t, { maxResponseBytes: 131072 });
  await writeFile(join(root, "one.txt"), "x".repeat(200000));
  const first = await readProjectFile(config, { projectId: "test", path: "one.txt" });
  assert.equal(first.truncated, true);
  assert.equal(first.nextStartLine, 1);
  assert.equal(first.lines[0]!.lineComplete, false);
  assert.ok(first.continuation);
  assert.ok(responseBytes(first) <= 131072);
});

test("range reads use sparse indexes, page cap and complete only the requested scope", async t => {
  const { root, config } = await fixture(t, { maxResponseBytes: 1048576 });
  const text = Array.from({ length: 2600 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  const path = join(root, "lines.txt"); await writeFile(path, text);
  const initialIndex = await indexText(path, config.projects[0]!.limits.maxFileBytes);
  const first = await readProjectFile(config, { projectId: "test", path: "lines.txt", startLine: 748, endLine: 1600 });
  assert.equal(first.lines.length, 750);
  assert.equal(first.lines[0]!.text, "line-748");
  assert.equal(first.lines.at(-1)!.text, "line-1497");
  const final = await readProjectFile(config, first.continuation!.next_arguments as ReadInput);
  assert.equal(final.lines[0]!.text, "line-1498");
  assert.equal(final.lines.at(-1)!.text, "line-1600");
  assert.equal(final.continuation, null);
  assert.equal(final.coverage.completed_lines, 853);
  assert.equal(final.range.totalLines, 2600);
  assert.equal(await indexText(path, config.projects[0]!.limits.maxFileBytes), initialIndex, "unchanged source reuses sparse index without rehashing");
});

test("read cursors reject changed scope, tampering, append, truncation and replacement", async t => {
  const { root, config } = await fixture(t);
  const path = join(root, "a.txt");
  const text = "line\n".repeat(1000);
  await writeFile(path, text); await writeFile(join(root, "b.txt"), text);
  const first = await readProjectFile(config, { projectId: "test", path: "a.txt" });
  const args = first.continuation!.next_arguments as ReadInput;
  await assert.rejects(readProjectFile(config, { ...args, path: "b.txt" }), code("CURSOR_INVALID"));
  await assert.rejects(readProjectFile(config, { ...args, endLine: 500 }), code("CURSOR_INVALID"));
  await assert.rejects(readProjectFile(config, { ...args, cursor: `x${args.cursor}` }), code("CURSOR_INVALID"));
  await appendFile(path, "new\n");
  await assert.rejects(readProjectFile(config, args), code("CURSOR_STALE"));
  const appended = await readProjectFile(config, { projectId: "test", path: "a.txt" });
  await writeFile(path, "short");
  await assert.rejects(readProjectFile(config, appended.continuation!.next_arguments as ReadInput), code("CURSOR_STALE"));
  await writeFile(path, text);
  const beforeReplace = await readProjectFile(config, { projectId: "test", path: "a.txt" });
  await rename(path, join(root, "old.txt")); await writeFile(path, text);
  await assert.rejects(readProjectFile(config, beforeReplace.continuation!.next_arguments as ReadInput), code("CURSOR_STALE"));
});

test("empty and BOM-only files have complete zero-line coverage", async t => {
  const { root, config } = await fixture(t);
  for (const text of ["", "\uFEFF"]) {
    await writeFile(join(root, "empty.txt"), text);
    const result = await readProjectFile(config, { projectId: "test", path: "empty.txt" });
    assert.deepEqual(result.lines, []);
    assert.equal(result.continuation, null);
    assert.equal(result.coverage.completed_lines, 0);
    assert.equal(result.coverage.status, "complete");
  }
});

test("large configured files stream through the index instead of the old 4 MiB ceiling", async t => {
  const { root, config } = await fixture(t);
  const text = "a".repeat(5 * 1024 * 1024) + "\nlast\n";
  await writeFile(join(root, "large.txt"), text);
  const page = await readProjectFile(config, { projectId: "test", path: "large.txt", startLine: 2, endLine: 2 });
  assert.equal(page.content, "last");
  assert.equal(page.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(page.coverage.status, "complete");
});

test("100000 logical lines complete in bounded pages with no duplicates or omissions", async t => {
  const { root, config, limits } = await fixture(t, { maxResponseBytes: 1048576 });
  await writeFile(join(root, "100k.txt"), Array.from({ length: 100000 }, (_, i) => `line-${i + 1}\n`).join(""));
  let args: ReadInput = { projectId: "test", path: "100k.txt", startLine: 1, endLine: 100000 };
  let expected = 1, pages = 0;
  for (;;) {
    const page = await readProjectFile(config, args); pages++;
    assert.ok(pages <= 134);
    assert.ok(page.lines.length <= 750);
    assert.ok(responseBytes(page) <= limits.maxResponseBytes);
    for (const fragment of page.lines) {
      assert.equal(fragment.line, expected);
      assert.equal(fragment.text, `line-${expected++}`);
      assert.equal(fragment.lineComplete, true);
    }
    if (!page.continuation) { assert.equal(page.coverage.completed_lines, 100000); break; }
    args = page.continuation.next_arguments as ReadInput;
  }
  assert.equal(pages, 134);
  assert.equal(expected, 100001);
});

test("a complete small response fits even when intermediate continuation metadata would not", async t => {
  const { root, config, limits } = await fixture(t, { maxResponseBytes: 4096 });
  await writeFile(join(root, "a.txt"), "small\n");
  const read = await readProjectFile(config, { projectId: "test", path: "a.txt" });
  const list = await listFiles(config, { projectId: "test" });
  const search = await searchProjectText(config, { projectId: "test", query: "small" });
  assert.equal(read.content, "small");
  assert.equal(read.continuation, null);
  assert.equal(list.continuation, null);
  assert.ok(responseBytes(read) <= limits.maxResponseBytes);
  assert.ok(responseBytes(list) <= limits.maxResponseBytes);
  assert.equal(search.results[0]!.snippet, "small");
  assert.equal(search.coverage.status, "complete");
  assert.equal(search.continuation, null);
  assert.ok(responseBytes(search) <= limits.maxResponseBytes);
});

test("config admits explicit large-file limits and rejects obsolete tiny response budgets", async t => {
  const { root, config } = await fixture(t);
  config.projects[0]!.limits.maxFileBytes = 1073741824;
  const file = join(root, "config.json");
  await writeFile(file, JSON.stringify({ ...config, probeFile: join(root, "probe.txt") }));
  assert.equal((await loadConfig(file)).projects[0]!.limits.maxFileBytes, 1073741824);
  config.projects[0]!.limits.maxResponseBytes = 4095;
  await writeFile(file, JSON.stringify({ ...config, probeFile: join(root, "probe.txt") }));
  await assert.rejects(loadConfig(file), /Invalid config/);
});

test("paginated search finds every matching line once, including cross-chunk queries", async t => {
  const { root, config, limits } = await fixture(t);
  await mkdir(join(root, "nested"));
  const lines = Array.from({ length: 25 }, (_, i) => `a-${i} needle 😀`);
  await writeFile(join(root, "a.txt"), lines.join("\r\n"));
  await writeFile(join(root, "nested", "b.txt"), "x".repeat(4093) + "needle" + "😀".repeat(3000) + "\r\nneedle\r\n");
  let args: SearchInput = { projectId: "test", query: "needle", limit: 3 };
  const matches: string[] = [];
  for (let pages = 0;; pages++) {
    assert.ok(pages < 100);
    const page = await searchProjectText(config, args);
    assert.ok(responseBytes(page) <= limits.maxResponseBytes);
    for (const hit of page.results) { matches.push(`${hit.path}:${hit.line}`); assert.ok(hit.snippet.includes("needle")); assert.ok(!hit.snippet.includes("\uFFFD")); }
    if (!page.continuation) {
      assert.equal(page.coverage.status, "complete");
      assert.equal(page.coverage.processed_targets, 2);
      break;
    }
    args = JSON.parse(JSON.stringify(page.continuation.next_arguments)) as SearchInput;
  }
  assert.equal(matches.length, 27);
  assert.equal(new Set(matches).size, 27);
  assert.deepEqual(matches.slice(-2), ["nested/b.txt:1", "nested/b.txt:2"]);
});

test("search records cumulative bounded skips and never emits hits from invalid files", async t => {
  const { root, config, limits } = await fixture(t, { maxFileBytes: 10000 });
  for (let i = 0; i < 30; i++) await writeFile(join(root, `bad-${i.toString().padStart(2, "0")}.txt`), Buffer.concat([Buffer.from("needle\n".repeat(10)), Buffer.from([0xff])]));
  await writeFile(join(root, "binary.dat"), Buffer.from([0]));
  await writeFile(join(root, "huge.txt"), "x".repeat(10001));
  await writeFile(join(root, "valid.txt"), "needle\nneedle\n");
  let args: SearchInput = { projectId: "test", query: "needle", limit: 1 };
  let count = 0;
  for (let pages = 0;; pages++) {
    assert.ok(pages < 100);
    const page = await searchProjectText(config, args);
    assert.ok(responseBytes(page) <= limits.maxResponseBytes);
    count += page.results.length;
    assert.ok(page.results.every(hit => hit.path === "valid.txt"));
    if (!page.continuation) {
      assert.equal(page.coverage.status, "partial");
      assert.equal(page.coverage.skipped_target_count, 32);
      assert.equal(page.coverage.skipped_targets.length, 5);
      assert.equal(page.coverage.skipped_reason_counts.INVALID_UTF8, 30);
      assert.equal(page.coverage.processed_targets, 1);
      break;
    }
    args = page.continuation.next_arguments as SearchInput;
  }
  assert.equal(count, 2);
});

test("search and listing cursors reject changed queries and changed corpora", async t => {
  const { root, config } = await fixture(t);
  await writeFile(join(root, "a.txt"), "needle\nneedle\n");
  await writeFile(join(root, "b.txt"), "needle\n");
  const search = await searchProjectText(config, { projectId: "test", query: "needle", limit: 1 });
  const args = search.continuation!.next_arguments as SearchInput;
  await assert.rejects(searchProjectText(config, { ...args, query: "other" }), code("CURSOR_INVALID"));
  const listing = await listFiles(config, { projectId: "test", limit: 1 });
  await writeFile(join(root, "c.txt"), "new");
  await assert.rejects(searchProjectText(config, args), code("CURSOR_STALE"));
  await assert.rejects(listFiles(config, listing.continuation!.next_arguments as Parameters<typeof listFiles>[1]), code("CURSOR_STALE"));
});

test("time-limited search resumes inside a long line without losing a cross-chunk match", async t => {
  const { root, config } = await fixture(t, { searchTimeoutMs: 12 });
  const text = "a".repeat(4093) + "needle" + "b".repeat(120000) + "\nneedle\n";
  await writeFile(join(root, "long.txt"), text);
  await indexText(join(root, "long.txt"), config.projects[0]!.limits.maxFileBytes);
  let ticks = 0;
  t.mock.method(performance, "now", () => ticks++);
  let args: SearchInput = { projectId: "test", query: "needle", snippetChars: 30 };
  const hits: number[] = []; let partialPages = 0;
  for (let pages = 0;; pages++) {
    assert.ok(pages < 100, "cursor must advance through a long line");
    const page = await searchProjectText(config, args);
    hits.push(...page.results.map(item => item.line));
    if (!page.continuation) { assert.equal(page.coverage.status, "complete"); break; }
    assert.equal(page.limits.timedOut, true);
    partialPages++;
    args = page.continuation.next_arguments as SearchInput;
  }
  assert.ok(partialPages > 1);
  assert.deepEqual(hits, [1, 2]);
});

test("an exhausted time budget cannot return an unchanged continuation forever", async t => {
  const { root, config } = await fixture(t, { searchTimeoutMs: 1 });
  await writeFile(join(root, "a.txt"), "needle");
  let ticks = 0;
  t.mock.method(performance, "now", () => ticks += 10);
  await assert.rejects(searchProjectText(config, { projectId: "test", query: "needle" }), code("SEARCH_TIMEOUT"));
});

test("listing byte budget paginates long paths without duplicates and reports bounded scope", async t => {
  const { root, config, limits } = await fixture(t, { maxResponseBytes: 8192 });
  const names = Array.from({ length: 45 }, (_, i) => `${String(i).padStart(2, "0")}-${"x".repeat(100)}.txt`);
  await Promise.all(names.map(name => writeFile(join(root, name), "")));
  const seen: string[] = []; let args: Parameters<typeof listFiles>[1] = { projectId: "test", depth: 0 };
  for (let pages = 0;; pages++) {
    assert.ok(pages < 50);
    const result = await listFiles(config, args);
    assert.ok(responseBytes(result) <= limits.maxResponseBytes);
    seen.push(...result.entries.map(item => item.path));
    if (!result.continuation) { assert.equal(result.coverage.status, "complete"); break; }
    args = result.continuation.next_arguments as typeof args;
  }
  assert.deepEqual(seen, names);
});

test("actual serialized transport frames enforce project and global limits", async t => {
  const { config } = await fixture(t, { maxResponseBytes: 4096 });
  const stdout = new PassThrough(), stdin = new PassThrough();
  let output = ""; stdout.on("data", chunk => { output += chunk.toString(); });
  const transport = new BoundedStdioTransport(config, stdin, stdout);
  const payload = { projectId: "test", trust: "UNTRUSTED_EVIDENCE", text: '"\\😀'.repeat(2000) };
  await transport.send({ jsonrpc: "2.0", id: 7, result: toolResult(payload) });
  assert.ok(Buffer.byteLength(output) <= 4096);
  assert.equal(JSON.parse(output).id, 7);
  assert.match(JSON.parse(output).error.message, /RESPONSE_PAGE_TOO_LARGE/);
  output = "";
  await transport.send({ jsonrpc: "2.0", id: 8, result: { text: "x".repeat(MAX_WIRE_BYTES) } });
  assert.ok(Buffer.byteLength(output) < MAX_WIRE_BYTES);
  assert.match(JSON.parse(output).error.message, /RESPONSE_PAGE_TOO_LARGE/);
  output = "";
  await transport.send({ jsonrpc: "2.0", id: 9, result: toolResult({ projectId: "test", trust: "UNTRUSTED_EVIDENCE", text: "small" }) });
  assert.equal(JSON.parse(output).result.structuredContent.text, "small");
  await transport.close();
});
