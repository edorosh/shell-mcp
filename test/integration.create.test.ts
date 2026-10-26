// Create-mode integration suite: the built server (dist/index.js) over MCP stdio, creating its own
// throwaway sandbox. Runs only when SHELL_MCP_IT_IMAGE and SHELL_MCP_IT_HOST_ROOT are set. Usage, PowerShell:
//   npm run build
//   $env:SHELL_MCP_IT_IMAGE="ubuntu:24.04"; $env:SHELL_MCP_IT_HOST_ROOT="C:\Users\<you>\dev"; npx vitest run test/integration.create.test.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const env = process.env;
// The server gets the ambient environment minus every SHELL_MCP_* key (user settings and SHELL_MCP_IT_*
// must not leak in); what a test needs is passed as flags.
const serverEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("SHELL_MCP_")));
const ENABLED = Boolean(env.SHELL_MCP_IT_IMAGE && env.SHELL_MCP_IT_HOST_ROOT);
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const GUEST = "/workspace";
const PREPARE_BUDGET_MS = 5 * 60_000;
// Stages that only a create (or recreate) logs; reuse must show none of them.
const CREATE_STAGE = /^shell-mcp: (creating|pulling |removing)/m;

interface Running {
  call: (command: string) => Promise<{ isError: boolean; text: string }>;
  /** Retries while the sandbox is still being prepared, for up to 5 minutes. */
  callReady: (command: string) => Promise<{ isError: boolean; text: string }>;
  stderr: () => string;
  close: () => Promise<void>;
}

describe.skipIf(!ENABLED)("create mode (real sandbox)", () => {
  const image = env.SHELL_MCP_IT_IMAGE ?? "";
  const name = `shell-mcp-it-${Math.random().toString(36).slice(2, 10)}`;
  let hostDir = "";
  const open: Running[] = [];

  const flags = (memory: string, extra: string[] = []) => [
    "--sandbox", name,
    "--image", image,
    "--mount", `${hostDir}:${GUEST}`,
    "--allow-domain", "example.com",
    "--memory", memory,
    ...extra,
  ];

  const start = async (args: string[]): Promise<Running> => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST, ...args], env: serverEnv(), stderr: "pipe" });
    let err = "";
    transport.stderr?.on("data", (d) => (err += String(d)));
    const client = new Client({ name: "shell-mcp-it", version: "0.0.0" });
    await client.connect(transport);
    const call: Running["call"] = async (command) => {
      const r = (await client.callTool({ name: "shell", arguments: { command, timeout_ms: 60_000 } })) as {
        isError?: boolean;
        content: { type: string; text?: string }[];
      };
      return { isError: Boolean(r.isError), text: r.content.map((c) => c.text ?? "").join("\n") };
    };
    const callReady: Running["callReady"] = async (command) => {
      const deadline = Date.now() + PREPARE_BUDGET_MS;
      for (;;) {
        const r = await call(command);
        if (!(r.isError && r.text.includes("still being prepared")) || Date.now() > deadline) return r;
        await new Promise((res) => setTimeout(res, 3000));
      }
    };
    const running: Running = { call, callReady, stderr: () => err, close: () => client.close().catch(() => {}) };
    open.push(running);
    return running;
  };

  const body = (text: string) => text.slice(text.indexOf("\n---\n") + 5);
  const head = (text: string) => text.split("\n")[0];

  beforeAll(() => {
    if (!fs.existsSync(DIST)) throw new Error("dist/index.js is missing; run `npm run build` first");
    hostDir = fs.mkdtempSync(path.join(env.SHELL_MCP_IT_HOST_ROOT ?? "", "it-create-"));
  });

  afterAll(async () => {
    for (const s of open) await s.close();
    try {
      const { Sandbox } = (await import("microsandbox")) as any;
      try {
        const handle = await Sandbox.get(name);
        if (handle.status === "running") await handle.stop();
      } catch {
        /* best effort */
      }
      await Sandbox.remove(name);
    } catch {
      /* best effort: cleanup must never mask a failure */
    }
    try {
      fs.rmSync(hostDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }, 120_000);

  it("creates the sandbox on the first call: uname -s is Linux", async () => {
    const s = await start(flags("1024"));
    const r = await s.callReady("uname -s");
    expect(r.isError, r.text).toBe(false);
    expect(head(r.text)).toBe("exit code: 0");
    expect(body(r.text).trim()).toBe("Linux");
    expect(s.stderr()).toMatch(CREATE_STAGE);
    await s.close();
  }, PREPARE_BUDGET_MS + 60_000);

  it("a file written on the host is listed in the guest", async () => {
    fs.writeFileSync(path.join(hostDir, "from-host.txt"), "hello\n");
    const s = await start(flags("1024"));
    const r = await s.callReady(`ls ${GUEST}`);
    expect(r.isError, r.text).toBe(false);
    expect(body(r.text)).toContain("from-host.txt");
    await s.close();
  }, PREPARE_BUDGET_MS + 60_000);

  it("allows TCP to the allowed domain and blocks another public host", async () => {
    const s = await start(flags("1024"));
    const probe = (host: string) => s.callReady(`timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/443'`);
    const allowed = await probe("example.com");
    expect(allowed.isError, allowed.text).toBe(false);
    expect(head(allowed.text), allowed.text).toBe("exit code: 0");
    const blocked = await probe("www.iana.org");
    expect(blocked.isError, blocked.text).toBe(false);
    expect(head(blocked.text), blocked.text).not.toBe("exit code: 0");
    await s.close();
  }, PREPARE_BUDGET_MS + 60_000);

  it("a restart with the same flags reuses the sandbox (no create stage)", async () => {
    const s = await start(flags("1024"));
    const r = await s.callReady("echo reused");
    expect(r.isError, r.text).toBe(false);
    expect(body(r.text).trim()).toBe("reused");
    expect(s.stderr()).not.toMatch(CREATE_STAGE);
    await s.close();
  }, PREPARE_BUDGET_MS + 60_000);

  it("a restart with another --memory fails and names --recreate", async () => {
    const s = await start(flags("1536"));
    const r = await s.callReady("echo hi");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("--recreate");
    await s.close();
  }, PREPARE_BUDGET_MS + 60_000);

  it("a restart with --recreate works", async () => {
    const s = await start(flags("1536", ["--recreate"]));
    const r = await s.callReady("uname -s");
    expect(r.isError, r.text).toBe(false);
    expect(body(r.text).trim()).toBe("Linux");
    expect(s.stderr()).toMatch(/^shell-mcp: removing/m);
    await s.close();
  }, PREPARE_BUDGET_MS + 60_000);
});
