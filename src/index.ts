#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCheck } from "./check.js";
import { ConfigError, parseCli } from "./config.js";
import { checkRuntime, runtimeLogLine } from "./runtime.js";
import { ShellService } from "./service.js";
import { createServer } from "./tools.js";
import { usage } from "./usage.js";

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
  let cli;
  try {
    cli = parseCli(process.argv.slice(2), process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      log(e.message);
      process.exit(1);
    }
    throw e;
  }
  const v = versions();
  if (cli.mode === "help") {
    process.stdout.write(usage());
    return;
  }
  if (cli.mode === "version") {
    process.stdout.write(`shell-mcp ${v.self} (microsandbox SDK ${v.sdk})\n`);
    return;
  }
  if (cli.mode === "prepare") {
    log("--prepare is not implemented yet");
    process.exit(1);
  }
  if (cli.mode === "check") {
    const cfg = cli.config;
    // Importing the backend module does not load the native module; the check's native step does.
    const { MicrosandboxBackend } = await import("./backend/microsandbox.js");
    const code = await runCheck(
      cfg,
      {
        loadSdk: () => import("microsandbox"),
        backend: new MicrosandboxBackend(cfg.sandbox, cfg.shell, cfg.maxOutput),
        runtime: () => checkRuntime(v.sdk),
        readdir: (p) => readdir(p),
      },
      (line) => process.stdout.write(`${line}\n`),
    );
    // Exit from the write callback so a TTY has flushed the output; the backend may hold handles.
    process.exitCode = code;
    process.stdout.write("", () => process.exit(code));
    return;
  }
  const cfg = cli.config;
  log(`version ${v.self}, microsandbox SDK ${v.sdk}, sandbox "${cfg.sandbox}"`);
  // Loaded only when serving, so --help and --version never touch the native module.
  const { MicrosandboxBackend } = await import("./backend/microsandbox.js");
  const backend = new MicrosandboxBackend(cfg.sandbox, cfg.shell, cfg.maxOutput);
  const service = new ShellService(cfg, backend);
  const server = createServer(cfg, service, v.self);
  await server.connect(new StdioServerTransport());
  // Advisory only and not awaited: a slow or failing check must never delay or stop serving.
  void checkRuntime(v.sdk).then(
    (r) => log(runtimeLogLine(r)),
    (e) => log(`runtime check failed: ${e}`),
  );
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
