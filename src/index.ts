import { BoundedStdioTransport } from "./bounded-transport.js";
import { loadConfig, errorMessage } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

function configArgument(argv: string[]): string {
  const index = argv.indexOf("--config");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value) throw new Error("--config requires a file path");
    return value;
  }
  return process.env.CHATGPT_TUNNEL_MCP_CONFIG ?? "config/local.json";
}

try {
  const config = await loadConfig(configArgument(process.argv.slice(2)));
  const server = createServer(config);
  await server.connect(new BoundedStdioTransport(config));
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio\n`);
} catch (error) {
  process.stderr.write(`Startup failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
