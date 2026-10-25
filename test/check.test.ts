import { describe, expect, it } from "vitest";
import { runCheck, type CheckDeps } from "../src/check.js";
import { BackendError } from "../src/backend/types.js";
import type { Config } from "../src/config.js";
import type { RuntimeCheck } from "../src/runtime.js";
import { FakeBackend } from "./fakeBackend.js";

const cfg = (over: Partial<Config> = {}): Config => ({
  sandbox: "dev", hostRoot: "/home/me/proj", guestRoot: "/workspace", defaultTimeoutMs: 120000,
  maxTimeoutMs: 600000, maxOutput: 30000, rewriteOutputPaths: true, shell: "bash", platform: "linux", ...over,
});
const out = (output: string) => ({ output, exitCode: 0, timedOut: false, droppedChars: 0 });
const okRuntime: RuntimeCheck = { ok: true, origin: "packaged", msbPath: "/x/msb", version: "0.7.11" };

function setup(o: { fb?: FakeBackend; sdk?: () => Promise<unknown>; runtime?: RuntimeCheck; host?: string[]; config?: Config } = {}) {
  const fb = o.fb ?? new FakeBackend();
  const lines: string[] = [];
  const deps: CheckDeps = {
    loadSdk: o.sdk ?? (async () => ({})),
    backend: fb,
    runtime: async () => o.runtime ?? okRuntime,
    readdir: async () => o.host ?? ["a", "b"],
  };
  const run = async () => ({ code: await runCheck(o.config ?? cfg(), deps, (l) => lines.push(l)), lines });
  return { fb, run };
}
const line = (lines: string[], step: string) => lines.find((l) => l.includes(` ${step}:`)) ?? "";
const onlyAllowedCalls = (fb: FakeBackend) => {
  expect(fb.started).toEqual([]);
  for (const r of fb.runs) expect(["uname -s", "ls -A1 -- '/workspace'"]).toContain(r.script);
};

describe("runCheck", () => {
  it("passes when every step is ok", async () => {
    const { fb, run } = setup();
    fb.queueRun(out("Linux\n")).queueRun(out("a\nb\n"));
    const { code, lines } = await run();
    expect(code).toBe(0);
    expect(lines.every((l) => /^(ok|FAIL|skipped)/.test(l))).toBe(true);
    expect(lines.filter((l) => l.startsWith("ok"))).toHaveLength(6);
    expect(fb.runs.map((r) => r.script)).toEqual(["uname -s", "ls -A1 -- '/workspace'"]);
    expect(fb.runs[0].timeoutMs).toBe(30000);
    onlyAllowedCalls(fb);
  });

  it("fails the native step with the hint and skips the rest", async () => {
    const { fb, run } = setup({ sdk: async () => { throw new Error("no binding"); } });
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "native module")).toMatch(/^FAIL/);
    expect(line(lines, "native module")).toContain("--omit=optional");
    for (const s of ["runtime", "sandbox", "shell", "mount"]) expect(line(lines, s)).toMatch(/^skipped/);
    expect(fb.runs).toEqual([]);
  });

  it("fails the runtime step but still runs the later ones", async () => {
    const { fb, run } = setup({ runtime: { ok: false, message: "msb 0.7.0 does not match SDK 0.7.11" } });
    fb.queueRun(out("Linux\n")).queueRun(out("a\nb\n"));
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "runtime")).toMatch(/^FAIL/);
    for (const s of ["sandbox", "shell", "mount"]) expect(line(lines, s)).toMatch(/^ok/);
  });

  it("fails the sandbox step on not_running with the start hint", async () => {
    const { fb, run } = setup();
    fb.queueRun(new BackendError("not_running", "x"));
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "sandbox")).toMatch(/^FAIL/);
    expect(line(lines, "sandbox")).toContain("msb start dev");
    expect(line(lines, "shell")).toMatch(/^skipped/);
    expect(line(lines, "mount")).toMatch(/^skipped/);
    onlyAllowedCalls(fb);
  });

  it("fails the shell step on not_started", async () => {
    const { fb, run } = setup();
    fb.queueRun(new BackendError("not_started", "bash: not found"));
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "sandbox")).toMatch(/^ok/);
    expect(line(lines, "shell")).toMatch(/^FAIL/);
    expect(line(lines, "shell")).toContain("--shell");
    expect(line(lines, "mount")).toMatch(/^skipped/);
  });

  it("fails the shell step when uname prints Darwin", async () => {
    const { fb, run } = setup();
    fb.queueRun(out("Darwin\n"));
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "shell")).toMatch(/^FAIL/);
    expect(line(lines, "mount")).toMatch(/^skipped/);
  });

  it("lists at most 5 missing names per side", async () => {
    const host = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "same"];
    const { fb, run } = setup({ host });
    fb.queueRun(out("Linux\n")).queueRun(out("g1\ng2\nsame\n"));
    const { code, lines } = await run();
    expect(code).toBe(1);
    const m = line(lines, "mount");
    expect(m).toMatch(/^FAIL/);
    expect(m).toContain("h1, h2, h3, h4, h5");
    expect(m).not.toContain("h6");
    expect(m).toContain("g1, g2");
    expect(m).toContain("rerun");
  });

  it("compares names case-insensitively on win32 only", async () => {
    const w = setup({ config: cfg({ platform: "win32" }), host: ["README.md"] });
    w.fb.queueRun(out("Linux\n")).queueRun(out("readme.md\n"));
    expect((await w.run()).code).toBe(0);
    const l = setup({ host: ["README.md"] });
    l.fb.queueRun(out("Linux\n")).queueRun(out("readme.md\n"));
    expect((await l.run()).code).toBe(1);
  });

  it("passes an empty host root with a note", async () => {
    const { fb, run } = setup({ host: [] });
    fb.queueRun(out("Linux\n")).queueRun(out(""));
    const { code, lines } = await run();
    expect(code).toBe(0);
    expect(line(lines, "mount")).toMatch(/^ok.*empty/);
  });
});
