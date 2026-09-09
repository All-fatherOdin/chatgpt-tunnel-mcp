import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = resolve(root, "local");
const configDir = resolve(root, "config");
const probeFile = resolve(localDir, "probe.txt");
const configFile = resolve(configDir, "local.json");
const projectRoot = process.env.CHATGPT_TUNNEL_AGENT_MEMORY_KIT_ROOT;

await mkdir(localDir, { recursive: true });
await mkdir(configDir, { recursive: true });

try {
  await readFile(probeFile);
  console.error(`Probe already exists; left unchanged: ${probeFile}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const marker = `probe-${randomBytes(18).toString("base64url")}`;
  await writeFile(probeFile, `${marker}\n`, { encoding: "utf8", flag: "wx" });
  console.error(`Created probe with a random marker: ${probeFile}`);
}

try {
  const existing = JSON.parse(await readFile(configFile, "utf8"));
  if (projectRoot && !Array.isArray(existing.projects)) existing.projects = [];
  if (projectRoot && !existing.projects.some(project => project?.projectId === "agent-memory-kit")) {
    existing.projects.push(agentMemoryKitProject(projectRoot));
    await writeFile(configFile, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    console.error(`Added agent-memory-kit without changing existing probe or device settings: ${configFile}`);
  } else {
    console.error(`Config already exists; left unchanged: ${configFile}`);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const config = {
    deviceId: `device-${randomUUID()}`,
    probeFile: "../local/probe.txt",
    maxProbeBytes: 65536
  };
  if (projectRoot) config.projects = [agentMemoryKitProject(projectRoot)];
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.error(`Created local config with an opaque device ID: ${configFile}`);
}

function agentMemoryKitProject(root) {
  return {
    projectId: "agent-memory-kit",
    name: "AI-assisted System Design and Agent Memory Kit",
    description: "Portable project-owner toolkit; its templates are not automatically adopted by other projects.",
    root,
    readOnly: true,
    excludePaths: [],
    entryDocuments: [
      { label: "Repository overview", path: "README.md" },
      { label: "Start here", path: "START_HERE.md" },
      { label: "Role stack guide", path: "Agent Kit/kit/AI_AGENT_ROLE_STACK_GUIDE.md" },
      { label: "Codex integration guide", path: "Agent Kit/kit/CODEX_INTEGRATION_OWNER_GUIDE.md" }
    ],
    limits: { maxFileBytes: 1048576, maxResponseBytes: 131072, maxResults: 200, maxDepth: 8, searchTimeoutMs: 5000, maxSnippetChars: 300 }
  };
}
