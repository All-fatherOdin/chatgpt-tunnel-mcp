import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryDirectories: string[] = [];
const root = resolve(import.meta.dirname, "../..");
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("legacy config keeps ping and read_probe and exposes an empty project registry", async () => {
  const fixture = await makeFixture(false);
  const session = await connect(fixture.config);
  try {
    const listed = await session.client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["list_files", "list_projects", "ping", "read_file", "read_probe", "search_text"]);
    for (const tool of listed.tools) { assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.outputSchema); }
    assert.equal(field(await call(session.client, "ping", {}), "deviceId"), "device-test-opaque");
    assert.equal(field(await call(session.client, "read_probe", {}), "text"), "probe marker\n");
    assert.deepEqual(field(await call(session.client, "list_projects", {}), "projects"), []);
  } finally { await session.transport.close(); }
});

test("projects are isolated; listing is deterministic, bounded and continuable", async () => {
  const fixture = await makeFixture(true);
  const session = await connect(fixture.config);
  try {
    const projects = field(await call(session.client, "list_projects", {}), "projects") as Array<Record<string, unknown>>;
    assert.deepEqual(projects.map(item => item.projectId), ["one", "two"]);
    assert.equal(JSON.stringify(projects).includes(fixture.one), false, "absolute roots must not be disclosed");
    const first = await call(session.client, "list_files", { projectId: "one", path: "", depth: 0, limit: 2 });
    assert.deepEqual((field(first, "entries") as Array<{ path: string }>).map(item => item.path), ["bad.txt", "empty.txt"]);
    assert.equal(field(first, "truncated"), true);
    const second = await call(session.client, "list_files", { projectId: "one", path: "", depth: 0, limit: 20, cursor: field(first, "nextCursor") });
    assert.ok((field(second, "entries") as Array<{ path: string }>).some(item => item.path === "README.md"));
    assert.equal(JSON.stringify(first).includes(".env"), false);
    assert.equal(field(await call(session.client, "read_file", { projectId: "two", path: "README.md" }), "content"), "second root");
    await expectError(session.client, "read_file", { projectId: "one", path: "../project two/README.md" }, /forbidden/i);
    await expectError(session.client, "read_file", { projectId: "missing", path: "README.md" }, /unknown/i);
  } finally { await session.transport.close(); }
});

test("read_file handles ranges, freshness, hashes, truncation, empty, excluded, binary and large files", async () => {
  const fixture = await makeFixture(true);
  const session = await connect(fixture.config);
  try {
    const ranged = await call(session.client, "read_file", { projectId: "one", path: "README.md", startLine: 2, endLine: 2 });
    assert.equal(field(ranged, "content"), "кириллица marker");
    assert.deepEqual(field(ranged, "range"), { startLine: 2, endLine: 2, totalLines: 3 });
    assert.equal(field(ranged, "sha256"), createHash("sha256").update("line one\nкириллица marker\nline three\n").digest("hex"));
    assert.match(String(field(ranged, "sha256Basis")), /entire current file byte sequence/);
    await writeFile(join(fixture.one, "README.md"), "changed now\n", "utf8");
    assert.equal(field(await call(session.client, "read_file", { projectId: "one", path: "README.md" }), "content"), "changed now");
    assert.deepEqual(field(await call(session.client, "read_file", { projectId: "one", path: "empty.txt" }), "lines"), []);
    const truncated = await call(session.client, "read_file", { projectId: "one", path: "many.txt" });
    assert.equal(field(truncated, "truncated"), true); assert.equal(typeof field(truncated, "nextStartLine"), "number");
    await expectError(session.client, "read_file", { projectId: "one", path: "README.md", startLine: 99 }, /range/i);
    await expectError(session.client, "read_file", { projectId: "one", path: "README.md", startLine: 1, endLine: 99 }, /range/i);
    await expectError(session.client, "read_file", { projectId: "one", path: ".env" }, /excluded/i);
    await expectError(session.client, "read_file", { projectId: "one", path: "raw.dat" }, /binary/i);
    await expectError(session.client, "read_file", { projectId: "one", path: "bad.txt" }, /UTF-8/i);
    await expectError(session.client, "read_file", { projectId: "one", path: "huge.txt" }, /limit/i);
  } finally { await session.transport.close(); }
});

test("literal search and path defenses apply consistently", async t => {
  const fixture = await makeFixture(true);
  let linkCreated = false;
  try { await symlink(fixture.two, join(fixture.one, "escape-link"), "junction"); linkCreated = true; } catch { t.diagnostic("junction creation unavailable; link assertion skipped"); }
  const session = await connect(fixture.config);
  try {
    const cyrillic = await call(session.client, "search_text", { projectId: "one", query: "кириллица", path: "folder with space" });
    assert.equal((field(cyrillic, "results") as Array<{ path: string }>)[0]?.path, "folder with space/notes.txt");
    const special = await call(session.client, "search_text", { projectId: "one", query: "a.*[$](x); --", limit: 1 });
    assert.equal((field(special, "results") as unknown[]).length, 1); assert.equal(field(special, "limited"), true);
    assert.deepEqual(field(await call(session.client, "search_text", { projectId: "one", query: "not present" }), "results"), []);
    assert.equal(JSON.stringify(await call(session.client, "search_text", { projectId: "one", query: "TOP-SECRET" })).includes("TOP-SECRET"), false);
    for (const path of ["../two/README.md", "C:/Windows/win.ini", "\\\\server\\share\\x", "README.md:secret"]) await expectError(session.client, "read_file", { projectId: "one", path }, /forbidden|relative|path/i);
    if (linkCreated) await expectError(session.client, "read_file", { projectId: "one", path: "escape-link/README.md" }, /link/i);
  } finally { await session.transport.close(); }
});

async function makeFixture(withProjects: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-tunnel-mcp-")); temporaryDirectories.push(directory);
  const probe = join(directory, "probe.txt"), config = join(directory, "config.json"), one = join(directory, "project one"), two = join(directory, "project two");
  await writeFile(probe, "probe marker\n", "utf8");
  const data: Record<string, unknown> = { deviceId: "device-test-opaque", probeFile: "./probe.txt", maxProbeBytes: 100 };
  if (withProjects) {
    await mkdir(join(one, "folder with space"), { recursive: true }); await mkdir(two, { recursive: true }); await mkdir(join(one, "private"), { recursive: true });
    await writeFile(join(one, "README.md"), "line one\nкириллица marker\nline three\n", "utf8");
    await writeFile(join(one, "folder with space", "notes.txt"), "кириллица and a.*[$](x); --\n", "utf8");
    await writeFile(join(one, "empty.txt"), "", "utf8"); await writeFile(join(one, ".env"), "TOP-SECRET", "utf8"); await writeFile(join(one, "private", "hidden.txt"), "TOP-SECRET", "utf8");
    await writeFile(join(one, "raw.dat"), Buffer.from([0, 1, 2])); await writeFile(join(one, "bad.txt"), Buffer.from([0xff, 0xfe])); await writeFile(join(one, "huge.txt"), "x".repeat(1001), "utf8"); await writeFile(join(one, "many.txt"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), "utf8");
    await writeFile(join(two, "README.md"), "second root\n", "utf8");
    const limits = { maxFileBytes: 1000, maxResponseBytes: 120, maxResults: 10, maxDepth: 3, searchTimeoutMs: 5000, maxSnippetChars: 100 };
    data.projects = [
      { projectId: "one", name: "One", description: "first", root: one, readOnly: true, excludePaths: ["private"], entryDocuments: [{ label: "README", path: "README.md" }], limits },
      { projectId: "two", name: "Two", description: "second", root: two, readOnly: true, excludePaths: [], entryDocuments: [], limits }
    ];
  }
  await writeFile(config, JSON.stringify(data), "utf8"); return { config, one, two };
}
async function connect(config: string) { const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/src/index.js"), "--config", config], stderr: "pipe" }); const client = new Client({ name: "integration-test", version: "1.0.0" }); await client.connect(transport); return { client, transport }; }
async function call(client: Client, name: string, args: Record<string, unknown>) { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent as Record<string, unknown>; }
function field(result: Record<string, unknown>, key: string) { return result[key]; }
async function expectError(client: Client, name: string, args: Record<string, unknown>, expected: RegExp) { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, true); const text = JSON.stringify(result.content); assert.match(text, expected); return text; }
