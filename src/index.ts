#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCheck } from "./check.js";
import { runPrepare } from "./prepare.js";
import type { Provisioner, ProvisionSdk } from "./backend/provision.js";
import { type Config, ConfigError, parseCli } from "./config.js";
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

/** Create mode only. Importing the provisioner does not load the native module; `loadSdk` does, lazily. */
async function makeProvisioner(cfg: Config): Promise<Provisioner> {
  const { Provisioner } = await import("./backend/provision.js");
  return new Provisioner(cfg.sandbox, cfg.machine!, cfg.mounts, { recreate: cfg.recreate }, {
    loadSdk: () => import("microsandbox") as unknown as Promise<ProvisionSdk>,
    platform: cfg.platform,
  });
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
    const cfg = cli.config;
    const provisioner = await makeProvisioner(cfg);
    const code = await runPrepare(provisioner, (line) => process.stdout.write(`${line}\n`), cfg.sandbox);
    process.exitCode = code;
    process.stdout.write("", () => process.exit(code));
    return;
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
        ...(cfg.machine ? { inspect: () => makeProvisioner(cfg).then((p) => p.inspect()) } : {}),
      },
      (line) => process.stdout.write(`${line}\n`),
    );
    // Exit from the write callback so a TTY has flushed the output; the backend may hold handles.
    process.exitCode = code;
    process.stdout.write("", () => process.exit(code));
    return;
  }
  const cfg = cli.config;
  log(
    cfg.machine
      ? `version ${v.self}, microsandbox SDK ${v.sdk}, create mode, sandbox "${cfg.sandbox}", image ${cfg.machine.image}`
      : `version ${v.self}, microsandbox SDK ${v.sdk}, attach mode, sandbox "${cfg.sandbox}"`,
  );
  // Loaded only when serving, so --help and --version never touch the native module.
  const { MicrosandboxBackend } = await import("./backend/microsandbox.js");
  let provisioner: Provisioner | undefined;
  if (cfg.machine) {
    provisioner = await makeProvisioner(cfg);
  }
  // Every attempt, background or per call, logs its stages to stderr.
  const backend = new MicrosandboxBackend(
    cfg.sandbox, cfg.shell, cfg.maxOutput,
    provisioner ? { provisioner: { ensure: () => provisioner.ensure((stage) => log(stage)), progress: () => provisioner.progress() } } : {},
  );
  const service = new ShellService(cfg, backend);
  const server = createServer(cfg, service, v.self);
  await server.connect(new StdioServerTransport());
  // Create mode: provision in the background; failures surface on the first tool call.
  if (provisioner) backend.warm();
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
