import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";

const entry = "dist/index.js";

function runNode(args: string[], input?: string, waitFor?: (out: string) => boolean) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("SHELL_MCP_")) delete env[k];
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; stdout=${stdout} stderr=${stderr}`));
    }, 5000);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (waitFor?.(stdout)) child.stdin.end();
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.write(input);
    else child.stdin.end();
  });
}

// Create-mode runs use a unique throwaway sandbox name and an image under the never-resolving
// `.invalid` TLD, so a pull fails and no real sandbox is ever created on CI hosts.
const throwaway = () => ["--sandbox", `shell-mcp-unit-${randomUUID().slice(0, 8)}`, "--image", "invalid.invalid/shell-mcp-unit:0", "--mount", `${tmpdir()}:/workspace`];

describe("entry point", () => {
  beforeAll(() => {
    execSync("npm run build", { stdio: "ignore" });
  }, 120_000);

  it("exits 1 with a config error on stderr and nothing on stdout", async () => {
    const r = await runNode([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("sandbox");
    expect(r.stdout).toBe("");
  });

  it("--check against a nonexistent sandbox exits 1 with a FAIL line on stdout", async () => {
    const r = await runNode(["--check", "--sandbox", "no-such-sandbox-shell-mcp-test", "--host-root", tmpdir(), "--guest-root", "/workspace"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^FAIL/m);
  });

  it("serves the four tools without contacting the sandbox", async () => {
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const input = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
    const r = await runNode(
      ["--sandbox", "no-such-sandbox-shell-mcp-test", "--host-root", tmpdir(), "--guest-root", "/workspace"],
      input,
      (out) => out.includes('"id":2'),
    );
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const list = lines.find((l) => l.id === 2);
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ["shell", "shell_kill", "shell_list", "shell_output"],
    );
    expect(r.stderr).toContain("shell-mcp");
  });

  it("exits 0 promptly when stdin ends, with clean stdout", async () => {
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const t0 = Date.now();
    const r = await runNode(
      ["--sandbox", "no-such-sandbox-shell-mcp-test", "--host-root", tmpdir(), "--guest-root", "/workspace"],
      msgs.map((m) => JSON.stringify(m)).join("\n") + "\n",
      (out) => out.includes('"id":2'),
    );
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    for (const line of r.stdout.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("--version prints the package and SDK versions and exits 0", async () => {
    const readVersion = (p: string) => (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
    const self = readVersion("package.json");
    const sdk = readVersion(path.join(path.dirname(createRequire(import.meta.url).resolve("microsandbox")), "..", "package.json"));
    const r = await runNode(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`shell-mcp ${self} (microsandbox SDK ${sdk})\n`);
  });

  it("--help prints usage on stdout, nothing on stderr, and exits 0", async () => {
    const r = await runNode(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--sandbox");
    expect(r.stdout).toContain("SHELL_MCP_SANDBOX");
    expect(r.stderr).toBe("");
  });

  it("serving in attach mode logs the mode", async () => {
    const r = await runNode(["--sandbox", "no-such-sandbox-shell-mcp-test", "--host-root", tmpdir(), "--guest-root", "/workspace"]);
    expect(r.stderr).toContain('attach mode, sandbox "no-such-sandbox-shell-mcp-test"');
  });

  it("serving in create mode logs the mode and image, with MCP only on stdout", async () => {
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const args = throwaway();
    const r = await runNode(args, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", (out) => out.includes('"id":2'));
    expect(r.stderr).toContain(`create mode, sandbox "${args[1]}", image invalid.invalid/shell-mcp-unit:0`);
    for (const l of r.stdout.trim().split("\n")) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("--prepare fails on an unresolvable image without writing MCP", async () => {
    const r = await runNode(["--prepare", ...throwaway()]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^FAIL/m);
    expect(r.stdout).not.toContain("jsonrpc");
  }, 30_000);

  it("create-mode --check reports the sandbox as not created, without writing MCP", async () => {
    const r = await runNode(["--check", ...throwaway()]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("not created yet; run with --prepare");
    expect(r.stdout).not.toContain("jsonrpc");
  }, 30_000);

  it("--prepare without --image is a config error on stderr", async () => {
    const r = await runNode(["--prepare", "--sandbox", "x", "--host-root", tmpdir(), "--guest-root", "/workspace"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--prepare needs --image");
    expect(r.stdout).toBe("");
  });
});
