import { describe, expect, it } from "vitest";
import { BackendError, type RunResult } from "../src/backend/types.js";
import { type Config, parseConfig } from "../src/config.js";
import { ShellService } from "../src/service.js";
import { FakeBackend } from "./fakeBackend.js";

const mk = (extra: string[] = []): Config =>
  parseConfig(
    ["--sandbox", "sb", "--host-root", "C:\\Users\\e\\proj", "--guest-root", "/workspace", ...extra],
    {},
    { platform: "win32", exists: () => true },
  );
const ok = (output: string, exitCode: number | null = 0, extra: Partial<RunResult> = {}): RunResult =>
  ({ output, exitCode, timedOut: false, droppedChars: 0, ...extra });
const setup = (cfg = mk(), deps: ConstructorParameters<typeof ShellService>[2] = {}) => {
  const fb = new FakeBackend();
  return { fb, svc: new ShellService(cfg, fb, { nonce: "n", ...deps }) };
};
const M = (p: string) => `\n__SHELLMCP_CWD_n__${p}\n`;

describe("ShellService.shell foreground", () => {
  it("formats success and tracks cwd", async () => {
    const { fb, svc } = setup();
    fb.queueRun(ok("hi\n" + M("/workspace/src")));
    const r = await svc.shell({ command: "echo hi" });
    expect(r).toEqual({ text: "exit code: 0\ncwd: C:\\Users\\e\\proj\\src\n---\nhi\n", isError: false });
    expect(svc.cwd).toBe("/workspace/src");
    await svc.shell({ command: "pwd" });
    expect(fb.runs[1]!.script).toContain("cd -- '/workspace/src'");
  });

  it("non-zero exit is not an error", async () => {
    const { fb, svc } = setup();
    fb.queueRun(ok("" + M("/workspace"), 3));
    const r = await svc.shell({ command: "exit 3" });
    expect(r.text).toContain("exit code: 3");
    expect(r.isError).toBe(false);
  });

  it("clamps and validates timeout", async () => {
    const { fb, svc } = setup();
    await svc.shell({ command: "a", timeout_ms: 5_000_000 });
    await svc.shell({ command: "a" });
    expect(fb.runs.map((r) => r.timeoutMs)).toEqual([600000, 120000]);
    for (const t of [0, -1]) {
      const r = await svc.shell({ command: "a", timeout_ms: t });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("timeout_ms must be a positive integer");
    }
    expect(fb.runs).toHaveLength(2);
  });

  it("reports timeout without exit code line", async () => {
    const { fb, svc } = setup();
    fb.queueRun(ok("partial\n", null, { timedOut: true }));
    const r = await svc.shell({ command: "sleep 999" });
    expect(r.text.startsWith("timed out after 120s (process killed)")).toBe(true);
    expect(r.text).toContain("partial");
    expect(r.text).not.toContain("exit code:");
  });

  it("notes an unconfirmed exit after a timeout kill, keeping the first line", async () => {
    const { fb, svc } = setup();
    fb.queueRun(ok("partial\n", null, { timedOut: true, exitUnconfirmed: true }));
    const r = await svc.shell({ command: "sleep 999" });
    expect(r.text.split("\n")[0]).toBe("timed out after 120s (process killed)");
    expect(r.text).toContain("note: kill sent, but the process exit was not confirmed");
    expect(r.text).toContain("partial");
    fb.queueRun(ok("partial\n", null, { timedOut: true }));
    expect((await svc.shell({ command: "sleep 999" })).text).not.toContain("not confirmed");
  });

  it("notes a reset directory", async () => {
    const { fb, svc } = setup();
    fb.queueRun(ok("__SHELLMCP_RESET_n__\nx\n" + M("/workspace")));
    const r = await svc.shell({ command: "x" });
    expect(r.text).toContain("note: previous directory no longer existed; ran in workspace root");
    expect(r.text).not.toContain("__SHELLMCP_RESET_");
  });

  it("rewrites paths before truncating", async () => {
    const { fb, svc } = setup(mk(["--max-output", "200"]));
    fb.queueRun(ok("x".repeat(1000) + "\nsee /workspace/a.ts\n" + M("/workspace")));
    const r = await svc.shell({ command: "x" });
    const body = r.text.split("---\n")[1]!;
    expect(body.length).toBeLessThanOrEqual(200);
    expect(body).toContain("characters omitted");
    expect(body).toContain("C:\\Users\\e\\proj\\a.ts");
  });

  it("adds backend droppedChars to the omitted count", async () => {
    const { fb, svc } = setup(mk(["--max-output", "200"]));
    fb.queueRun(ok("y".repeat(1000) + M("/workspace"), 0, { droppedChars: 5000 }));
    const r = await svc.shell({ command: "x" });
    expect(r.text).toContain("characters omitted");
    const n = Number(/\[\.\.\. (\d+) characters omitted/.exec(r.text)![1]);
    expect(n).toBeGreaterThanOrEqual(5000 + 800);
  });

  it("rewriteOutputPaths false leaves output but cwd is host form", async () => {
    const { fb, svc } = setup(mk(["--no-rewrite-output-paths"]));
    fb.queueRun(ok("at /workspace/a\n" + M("/workspace")));
    const r = await svc.shell({ command: "x" });
    expect(r.text).toContain("at /workspace/a");
    expect(r.text).toContain("cwd: C:\\Users\\e\\proj\n");
  });

  it("maps backend errors", async () => {
    const { fb, svc } = setup();
    fb.queueRun(new BackendError("not_running", "stopped"));
    let r = await svc.shell({ command: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("was not started");
    expect(r.text).toContain("sb");
    expect(r.text).toContain("msb start sb");
    fb.queueRun(new BackendError("not_found", "nope"));
    r = await svc.shell({ command: "x" });
    expect(r.text).toContain("was not started");
    expect(r.text).toContain("not found");
    fb.queueRun(new BackendError("outcome_unknown", "conn lost"));
    r = await svc.shell({ command: "x" });
    expect(r.text).toContain("outcome is unknown");
    expect(r.text).toContain("do not retry");
    fb.queueRun(new Error("weird"));
    r = await svc.shell({ command: "x" });
    expect(r.text).toContain("outcome is unknown");
    fb.queueRun(new BackendError("unreachable", "no daemon"));
    r = await svc.shell({ command: "x" });
    expect(r.text).toBe(
      'Command was not started: sandbox "sb" is unreachable: no daemon. If it is stopped, start it with: msb start sb',
    );
    fb.queueRun(new BackendError("not_started", "bash: not found"));
    r = await svc.shell({ command: "x" });
    expect(r.text).toBe("Command was not started: bash: not found");
  });

  it("concurrent calls: last finisher wins cwd, both built from the same cwd", async () => {
    const { fb, svc } = setup();
    const gate: Record<string, () => void> = {};
    const hold = (name: string, out: string) => (): Promise<RunResult> =>
      new Promise((res) => { gate[name] = () => res(ok(out)); });
    fb.queueRun(hold("a", M("/workspace/a")));
    fb.queueRun(hold("b", M("/workspace/b")));
    const pa = svc.shell({ command: "cd a" });
    const pb = svc.shell({ command: "cd b" });
    await Promise.resolve();
    expect(fb.runs).toHaveLength(2);
    for (const r of fb.runs) expect(r.script).toContain("cd -- '/workspace'");
    gate.b!();
    await pb;
    gate.a!();
    await pa;
    expect(svc.cwd).toBe("/workspace/a");
  });

  it("propagates abort to the backend signal", async () => {
    const { fb, svc } = setup();
    fb.delayMs = 50;
    const ac = new AbortController();
    const p = svc.shell({ command: "sleep 9" }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await p;
    expect(fb.runs[0]!.signal!.aborted).toBe(true);
  });

  it("sends progress while running, only with onProgress", async () => {
    const { fb, svc } = setup(mk(), { progressIntervalMs: 10 });
    fb.delayMs = 35;
    const seen: number[] = [];
    await svc.shell({ command: "x" }, { onProgress: (s) => seen.push(s) });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    const spy = setup(mk(), { progressIntervalMs: 10 });
    const orig = globalThis.setInterval;
    let called = 0;
    globalThis.setInterval = ((...a: unknown[]) => { called++; return (orig as any)(...a); }) as any;
    try { await spy.svc.shell({ command: "x" }); } finally { globalThis.setInterval = orig; }
    expect(called).toBe(0);
  });
});

describe("ShellService.shell background", () => {
  it("starts a job without touching cwd", async () => {
    const { fb, svc } = setup();
    fb.nextJobId = "j7";
    const r = await svc.shell({ command: "npm start", run_in_background: true, timeout_ms: 5 });
    expect(fb.runs).toHaveLength(0);
    expect(fb.started).toHaveLength(1);
    expect(fb.started[0]).toContain("cd -- '/workspace'");
    expect(fb.started[0]).not.toContain("__SHELLMCP_CWD_");
    expect(r.isError).toBe(false);
    expect(r.text).toContain("started background job j7");
    expect(r.text).toContain("shell_output");
    expect(svc.cwd).toBe("/workspace");
  });
});
