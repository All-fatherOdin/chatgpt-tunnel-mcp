import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporaryDirectories: string[] = [];
const root = resolve(import.meta.dirname, "../..");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test("real MCP client lists strict read-only tools and observes file changes", async () => {
  const fixture = await makeFixture("first marker\n", 100);
  const { client, transport } = await connect(fixture.config);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["ping", "read_probe"]);
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.inputSchema.type, "object");
      assert.deepEqual(tool.inputSchema.properties, {});
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
    }

    const ping = await client.callTool({ name: "ping", arguments: {} });
    assert.equal(ping.isError, undefined);
    assert.equal((ping.structuredContent as { deviceId: string }).deviceId, "device-test-opaque");

    const first = await client.callTool({ name: "read_probe", arguments: {} });
    assert.equal((first.structuredContent as { text: string }).text, "first marker\n");
    await writeFile(fixture.probe, "changed marker\n", "utf8");
    const second = await client.callTool({ name: "read_probe", arguments: {} });
    const output = second.structuredContent as { text: string; sha256: string };
    assert.equal(output.text, "changed marker\n");
    assert.equal(output.sha256, createHash("sha256").update("changed marker\n").digest("hex"));

    const arbitraryPath = await client.callTool({ name: "read_probe", arguments: { path: "C:\\sensitive.txt" } });
    assert.equal(arbitraryPath.isError, true);
    const validationContent = arbitraryPath.content as Array<{ type: string; text: string }>;
    assert.match(validationContent[0]!.text, /Invalid arguments/i);
  } finally {
    await transport.close();
  }
});

test("missing probe returns a useful tool error", async () => {
  const fixture = await makeFixture(undefined, 100);
  const { client, transport } = await connect(fixture.config);
  try {
    const result = await client.callTool({ name: "read_probe", arguments: {} });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.match(content[0]!.text, /does not exist/i);
  } finally {
    await transport.close();
  }
});

test("oversized probe is rejected without returning its content", async () => {
  const secret = "do-not-return-this-marker";
  const fixture = await makeFixture(secret, 4);
  const { client, transport } = await connect(fixture.config);
  try {
    const result = await client.callTool({ name: "read_probe", arguments: {} });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    assert.match(text, /4-byte limit/i);
    assert.doesNotMatch(text, new RegExp(secret));
  } finally {
    await transport.close();
  }
});

async function makeFixture(content: string | undefined, maxProbeBytes: number) {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-tunnel-mcp-"));
  temporaryDirectories.push(directory);
  const probe = join(directory, "probe.txt");
  const config = join(directory, "config.json");
  if (content !== undefined) await writeFile(probe, content, "utf8");
  await writeFile(config, JSON.stringify({ deviceId: "device-test-opaque", probeFile: "./probe.txt", maxProbeBytes }), "utf8");
  return { probe, config };
}

async function connect(config: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/src/index.js"), "--config", config],
    stderr: "pipe"
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}
