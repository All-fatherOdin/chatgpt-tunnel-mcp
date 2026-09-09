import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = resolve(root, "local");
const configDir = resolve(root, "config");
const probeFile = resolve(localDir, "probe.txt");
const configFile = resolve(configDir, "local.json");

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
  await readFile(configFile);
  console.error(`Config already exists; left unchanged: ${configFile}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const config = {
    deviceId: `device-${randomUUID()}`,
    probeFile: "../local/probe.txt",
    maxProbeBytes: 65536
  };
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.error(`Created local config with an opaque device ID: ${configFile}`);
}
