#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MicrosandboxBackend } from "./backend/microsandbox.js";
import { ConfigError, parseConfig } from "./config.js";
import { ShellService } from "./service.js";
import { createServer } from "./tools.js";

// stdout carries MCP only; every diagnostic goes to stderr.
const log = (msg: string) => process.stderr.write(`shell-mcp: ${msg}\n`);

function versions(): { self: string; sdk: string } {
  const read = (p: string) => (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "unknown";
  const require = createRequire(import.meta.url);
  let self = "unknown";
  let sdk = "unknown";
  try {
    self = read(fileURLToPath(new URL("../package.json", import.meta.url)));
  } catch {}
  try {
    // Resolving the entry does not load the native module.
    sdk = read(path.join(path.dirname(require.resolve("microsandbox")), "..", "package.json"));
  } catch {}
  return { self, sdk };
}

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = parseConfig(process.argv.slice(2), process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      log(e.message);
      process.exit(1);
    }
    throw e;
  }
  const v = versions();
  log(`version ${v.self}, microsandbox SDK ${v.sdk}, sandbox "${cfg.sandbox}"`);
  const backend = new MicrosandboxBackend(cfg.sandbox, cfg.shell, cfg.maxOutput);
  const service = new ShellService(cfg, backend);
  const server = createServer(cfg, service);
  await server.connect(new StdioServerTransport());
  // The client is gone once stdin ends: exit even if a command or timer is still pending, so
  // orphaned servers do not linger.
  const shutdown = () => {
    void server.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
}

main().catch((e: unknown) => {
  log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
