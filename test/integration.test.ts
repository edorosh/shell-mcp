// Acceptance criteria 1-12 of docs/product-spec.md section 13, against a real sandbox.
// Runs only when SHELL_MCP_IT_SANDBOX is set (see Task 9 in the plan). Usage, PowerShell:
//   $env:SHELL_MCP_IT_SANDBOX="myproj"; $env:SHELL_MCP_IT_HOST_ROOT="C:\Users\<you>\dev\myproj";
//   $env:SHELL_MCP_IT_GUEST_ROOT="/workspace"; npx vitest run test/integration.test.ts
// Criterion 10 stops and starts the sandbox; it only runs with SHELL_MCP_IT_ALLOW_STOP=1.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MicrosandboxBackend } from "../src/backend/microsandbox.js";
import { parseConfig } from "../src/config.js";
import { ShellService } from "../src/service.js";

const env = process.env;
const ENABLED = Boolean(env.SHELL_MCP_IT_SANDBOX);
const ALLOW_STOP = env.SHELL_MCP_IT_ALLOW_STOP === "1";

describe.skipIf(!ENABLED)("acceptance criteria (section 13)", () => {
  const sandbox = env.SHELL_MCP_IT_SANDBOX ?? "";
  const hostBase = env.SHELL_MCP_IT_HOST_ROOT ?? "";
  const guestBase = env.SHELL_MCP_IT_GUEST_ROOT ?? "";
  if (ENABLED && (!hostBase || !guestBase)) {
    throw new Error(
      "SHELL_MCP_IT_SANDBOX is set, so SHELL_MCP_IT_HOST_ROOT and SHELL_MCP_IT_GUEST_ROOT are also required",
    );
  }

  let scratch = ""; // directory name under the host root
  let hostDir = ""; // host path of the scratch dir
  let guestDir = ""; // guest path of the scratch dir
  let svc: ShellService;
  let backend: MicrosandboxBackend;
  let maxOutput: number;
  let hostRoot: string;

  const make = (extra: string[] = []) => {
    const cfg = parseConfig(
      ["--sandbox", sandbox, "--host-root", hostBase, "--guest-root", guestBase, ...extra],
      {},
    );
    hostRoot = cfg.mounts[0].host;
    maxOutput = cfg.maxOutput;
    backend = new MicrosandboxBackend(cfg.sandbox, cfg.shell, cfg.maxOutput);
    svc = new ShellService(cfg, backend);
    return cfg;
  };
  // Fresh service (own connection state) inside the scratch dir.
  const fresh = async (extra: string[] = []) => {
    make(extra);
    const r = await svc.shell({ command: `cd ${scratch}` });
    expect(r.isError, r.text).toBe(false);
  };
  const body = (text: string) => text.slice(text.indexOf("\n---\n") + 5);
  const head = (text: string) => text.split("\n")[0];
  const cwdLine = (text: string) => text.split("\n").find((l) => l.startsWith("cwd: "));

  beforeEach(async () => {
    scratch = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cfg = make();
    hostDir = path.join(cfg.mounts[0].host, scratch);
    guestDir = `${cfg.mounts[0].guest === "/" ? "" : cfg.mounts[0].guest}/${scratch}`;
    fs.mkdirSync(hostDir, { recursive: true });
    // Work inside the scratch dir for every test.
    const r = await svc.shell({ command: `cd ${scratch}` });
    expect(r.isError, r.text).toBe(false);
  });

  afterEach(async () => {
    // Stop any background jobs the test left running, then delete the scratch dir.
    for (const j of svc.jobs.list()) {
      try {
        await svc.kill({ job_id: j.id });
      } catch {
        /* best effort */
      }
    }
    fs.rmSync(hostDir, { recursive: true, force: true });
  });

  it("1. shell `echo hi` returns hi and exit code 0", async () => {
    const r = await svc.shell({ command: "echo hi" });
    expect(r.isError).toBe(false);
    expect(head(r.text)).toBe("exit code: 0");
    expect(body(r.text).trim()).toBe("hi");
  });

  it("2. shell `exit 3` returns exit code 3 and no tool error", async () => {
    const r = await svc.shell({ command: "exit 3" });
    expect(r.isError).toBe(false);
    expect(head(r.text)).toBe("exit code: 3");
  });

  it("3. `cd src` then `pwd` reports the guest path of src; cwd shows the host path of src", async () => {
    // Path rewriting off, so `pwd` shows the guest path while the cwd header shows the host path.
    await fresh(["--no-rewrite-output-paths"]);
    fs.mkdirSync(path.join(hostDir, "src"));
    const a = await svc.shell({ command: "cd src" });
    expect(a.isError).toBe(false);
    const r = await svc.shell({ command: "pwd" });
    expect(r.isError).toBe(false);
    expect(body(r.text).trim()).toBe(`${guestDir}/src`);
    expect(cwdLine(r.text)).toBe(`cwd: ${path.join(hostDir, "src")}`);
  });

  it("4. `export X=1` then `echo $X` prints an empty line", async () => {
    const a = await svc.shell({ command: "export X=1" });
    expect(a.isError).toBe(false);
    const r = await svc.shell({ command: "echo $X" });
    expect(r.isError).toBe(false);
    expect(body(r.text)).toBe("\n");
  });

  it("5. `sleep 30` with timeout_ms 1000 returns within a few seconds, timed out, process gone", async () => {
    const t0 = Date.now();
    const r = await svc.shell({ command: "sleep 30", timeout_ms: 1000 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(8000);
    expect(r.isError).toBe(false);
    expect(head(r.text)).toMatch(/^timed out after 1s/);
    // The bracket keeps the pattern from matching the bash -c running pgrep itself.
    const p = await svc.shell({ command: 'pgrep -f "sleep 3[0]"' });
    expect(p.isError).toBe(false);
    expect(head(p.text)).toBe("exit code: 1");
    expect(body(p.text).trim()).toBe("");
  }, 30_000);

  it("6. `cat` with no arguments finishes immediately (stdin closed)", async () => {
    const t0 = Date.now();
    const r = await svc.shell({ command: "cat", timeout_ms: 20_000 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.isError).toBe(false);
    expect(head(r.text)).toBe("exit code: 0");
  }, 30_000);

  it("7. 1 MB of output returns at most max-output characters with a truncation marker, keeping start and end", async () => {
    const r = await svc.shell({
      command: "printf START; head -c 1048576 /dev/zero | tr '\\0' x; printf END",
      timeout_ms: 60_000,
    });
    expect(r.isError).toBe(false);
    const out = body(r.text);
    expect(out.length).toBeLessThanOrEqual(maxOutput);
    expect(out).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/);
    expect(out.startsWith("START")).toBe(true);
    expect(out.trimEnd().endsWith("END")).toBe(true);
  }, 90_000);

  it("8. background loop: job_id, tick lines, listed running, kill, then killed or exited", async () => {
    const s = await svc.shell({ command: "while true; do echo tick; sleep 1; done", run_in_background: true });
    expect(s.isError).toBe(false);
    const m = /started background job (\S+)/.exec(s.text);
    expect(m, s.text).not.toBeNull();
    const id = m![1];

    await new Promise((res) => setTimeout(res, 3000));
    const o = await svc.output({ job_id: id });
    expect(o.isError).toBe(false);
    expect(o.text).toContain("tick");

    const l1 = await svc.list();
    const line1 = l1.text.split("\n").find((l) => l.startsWith(id));
    expect(line1, l1.text).toBeDefined();
    expect(line1).toContain("running");

    const k = await svc.kill({ job_id: id });
    expect(k.isError).toBe(false);

    let line2 = "";
    for (let i = 0; i < 10; i++) {
      const l2 = await svc.list();
      line2 = l2.text.split("\n").find((l) => l.startsWith(id)) ?? "";
      if (!line2.includes("running")) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    expect(line2).toMatch(/killed|exited/);
  }, 60_000);

  it("9. /workspace/src/a.ts:3 appears with the host path of src/a.ts; /workspace2/x is unchanged", async () => {
    const g = guestBase.replace(/\/+$/, "");
    const r = await svc.shell({ command: `echo ${g}/src/a.ts:3; echo ${g}2/x` });
    expect(r.isError).toBe(false);
    const out = body(r.text);
    expect(out).toContain(`${path.join(hostRoot, "src", "a.ts")}:3`);
    expect(out).not.toContain(`${g}/src/a.ts`);
    expect(out).toContain(`${g}2/x`);
  });

  it.skipIf(!ALLOW_STOP)("10. with the sandbox stopped, shell errors naming it and how to start it; after start the next call succeeds", async () => {
    // A long-running server: this service already holds a cached connection (beforeEach), and
    // one more call on it right before the stop keeps that connection warm.
    const stoppedSvc = svc;
    const before = await stoppedSvc.shell({ command: "echo before" });
    expect(before.isError, before.text).toBe(false);
    execFileSync("msb", ["stop", sandbox], { stdio: "inherit" });
    try {
      const r = await stoppedSvc.shell({ command: "echo hi" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(sandbox);
      expect(r.text).toContain(`msb start ${sandbox}`);
    } finally {
      execFileSync("msb", ["start", sandbox], { stdio: "inherit" });
    }
    // Same service instance: the next call succeeds without restarting the server.
    // Poll for up to ~30 s while the sandbox becomes connectable.
    let ok = await stoppedSvc.shell({ command: "echo hi" });
    for (let i = 0; i < 15 && ok.isError; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      ok = await stoppedSvc.shell({ command: "echo hi" });
    }
    expect(ok.isError, ok.text).toBe(false);
    expect(body(ok.text).trim()).toBe("hi");
  }, 180_000);

  it("11. a file written by shell (`echo x > out.txt`) is visible on the host at the host path", async () => {
    const r = await svc.shell({ command: "echo x > out.txt" });
    expect(r.isError).toBe(false);
    expect(fs.readFileSync(path.join(hostDir, "out.txt"), "utf8").trim()).toBe("x");
  });

  it("12. deleting the current directory from the host, then `pwd`, runs in the guest root and reports the reset", async () => {
    await fresh(["--no-rewrite-output-paths"]);
    fs.mkdirSync(path.join(hostDir, "gone"));
    const a = await svc.shell({ command: "cd gone" });
    expect(a.isError).toBe(false);
    fs.rmSync(path.join(hostDir, "gone"), { recursive: true, force: true });
    // The guest's view of the host mount lags behind a host-side delete (seen: still visible
    // right after, gone within 5 s). Wait until the guest no longer sees the directory, so the
    // test checks the reset logic and not the mount's cache timing.
    const visible = `test -d '${guestDir}/gone' && echo present || echo absent`;
    const deadline = Date.now() + 20_000;
    let seen = "present";
    while (seen !== "absent" && Date.now() < deadline) {
      seen = (await backend.run(visible, { timeoutMs: 10_000 })).output.trim();
      if (seen !== "absent") await new Promise((r) => setTimeout(r, 500));
    }
    expect(seen, "the guest still sees the deleted directory after 20 s").toBe("absent");
    const r = await svc.shell({ command: "pwd" });
    expect(r.isError).toBe(false);
    expect(body(r.text).trim()).toBe(guestBase.replace(/\/+$/, "") || "/");
    expect(cwdLine(r.text)).toBe(`cwd: ${hostRoot}`);
    expect(r.text).toContain("previous directory no longer existed; ran in workspace root");
  }, 60_000);
});
