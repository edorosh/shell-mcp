import { describe, expect, it } from "vitest";
import { runCheck, type CheckDeps } from "../src/check.js";
import { BackendError } from "../src/backend/types.js";
import type { Config } from "../src/config.js";
import type { RuntimeCheck } from "../src/runtime.js";
import { backendErrorText } from "../src/service.js";
import { FakeBackend } from "./fakeBackend.js";

const cfg = (over: Partial<Config> = {}): Config => ({
  sandbox: "dev", mounts: [{ host: "/home/me/proj", hostResolved: "/home/me/proj", guest: "/workspace", readonly: false }], recreate: false, defaultTimeoutMs: 120000,
  maxTimeoutMs: 600000, maxOutput: 30000, rewriteOutputPaths: true, shell: "bash", platform: "linux", ...over,
});
const out = (output: string) => ({ output, exitCode: 0, timedOut: false, droppedChars: 0 });
const okRuntime: RuntimeCheck = { ok: true, origin: "packaged", msbPath: "/x/msb", version: "0.7.11" };

function setup(o: { fb?: FakeBackend; sdk?: () => Promise<unknown>; runtime?: RuntimeCheck; host?: string[]; config?: Config; arch?: NodeJS.Architecture } = {}) {
  const fb = o.fb ?? new FakeBackend();
  const lines: string[] = [];
  const deps: CheckDeps = {
    loadSdk: o.sdk ?? (async () => ({})),
    backend: fb,
    runtime: async () => o.runtime ?? okRuntime,
    readdir: async () => o.host ?? ["a", "b"],
    arch: o.arch,
  };
  const run = async () => {
    const code = await runCheck(o.config ?? cfg(), deps, (l) => lines.push(l));
    onlyAllowedCalls(fb);
    return { code, lines };
  };
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

  it("fails the native step with the Apple Silicon hint on darwin/x64", async () => {
    const { run } = setup({ sdk: async () => { throw new Error("cannot find module"); }, config: cfg({ platform: "darwin" }), arch: "x64" });
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "native module")).toBe("FAIL    native module: cannot find module; macOS needs Apple Silicon and an arm64 Node (this Node is x64: an Intel Mac, or Node running under Rosetta)");
  });

  it("keeps the reinstall hint on darwin/arm64", async () => {
    const { run } = setup({ sdk: async () => { throw new Error("x"); }, config: cfg({ platform: "darwin" }), arch: "arm64" });
    const { lines } = await run();
    expect(line(lines, "native module")).toContain("--omit=optional");
  });

  it("fails the native step with the hint and skips the rest", async () => {
    const { fb, run } = setup({ sdk: async () => { throw new Error("no binding"); }, arch: "x64" });
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

  it.each(["unreachable", "not_found"] as const)("fails the sandbox step on %s with the shared wording", async (kind) => {
    const { fb, run } = setup();
    const err = new BackendError(kind, "boom");
    fb.queueRun(err);
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "sandbox")).toBe(`FAIL    sandbox: ${backendErrorText(err, "dev")}`);
    expect(line(lines, "shell")).toMatch(/^skipped/);
    expect(line(lines, "mount")).toMatch(/^skipped/);
  });

  it("fails the sandbox step when uname -s times out", async () => {
    const { fb, run } = setup();
    fb.queueRun({ output: "", exitCode: null, timedOut: true, droppedChars: 0 });
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "sandbox")).toMatch(/^FAIL.*30s/);
    expect(line(lines, "shell")).toMatch(/^skipped/);
    expect(line(lines, "mount")).toMatch(/^skipped/);
  });

  it.each([
    ["non-zero exit", { output: "", exitCode: 2, timedOut: false, droppedChars: 0 }, /exit code 2/],
    ["timeout", { output: "", exitCode: null, timedOut: true, droppedChars: 0 }, /timed out/],
  ])("fails the mount step when ls has a %s", async (_n, res, re) => {
    const { fb, run } = setup();
    fb.queueRun(out("Linux\n")).queueRun(res);
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(line(lines, "mount")).toMatch(/^FAIL/);
    expect(line(lines, "mount")).toMatch(re);
  });

  it("fails the mount step when readdir rejects", async () => {
    const fb = new FakeBackend();
    fb.queueRun(out("Linux\n")).queueRun(out("a\n"));
    const lines: string[] = [];
    const code = await runCheck(cfg(), {
      loadSdk: async () => ({}), backend: fb, runtime: async () => okRuntime,
      readdir: async () => { throw new Error("ENOENT: no such directory"); },
    }, (l) => lines.push(l));
    onlyAllowedCalls(fb);
    expect(code).toBe(1);
    expect(line(lines, "mount")).toMatch(/^FAIL.*ENOENT/);
  });
});

describe("runCheck connect guard", () => {
  it("fails the sandbox step when the backend never answers", async () => {
    const fb = new FakeBackend().queueRun(() => new Promise<never>(() => {}));
    const lines: string[] = [];
    const deps: CheckDeps = {
      loadSdk: async () => ({}), backend: fb, runtime: async () => okRuntime, readdir: async () => ["a"], timeoutMs: 20,
    };
    const code = await runCheck(cfg(), deps, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(line(lines, "sandbox")).toMatch(/^FAIL .*no response within 0s/);
    expect(line(lines, "shell")).toMatch(/^skipped/);
    expect(line(lines, "mount")).toMatch(/^skipped/);
    expect(fb.runs).toHaveLength(1);
  });

  it("prints one mount line per mount", async () => {
    const fb = new FakeBackend();
    fb.queueRun(out("Linux\n")).queueRun(out("a\nb\n")).queueRun({ output: "", exitCode: 2, timedOut: false, droppedChars: 0 });
    const lines: string[] = [];
    const config = cfg({ mounts: [
      { host: "/home/me/proj", hostResolved: "/home/me/proj", guest: "/workspace", readonly: false },
      { host: "/home/me/data", hostResolved: "/home/me/data", guest: "/data", readonly: true },
    ] });
    const code = await runCheck(config, {
      loadSdk: async () => ({}), backend: fb, runtime: async () => okRuntime, readdir: async () => ["a", "b"],
    }, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.filter((l) => l.includes(" mount:"))).toHaveLength(2);
    expect(lines.find((l) => l.startsWith("ok") && l.includes(" mount:"))).toContain("/home/me/proj matches /workspace");
    const failed = lines.find((l) => l.startsWith("FAIL") && l.includes(" mount:"));
    expect(failed).toContain("/data");
    expect(failed).toContain("/home/me/data");
    expect(lines[0]).toContain("/home/me/proj -> /workspace, /home/me/data -> /data");
  });
});
