import { describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => vi.fn(() => ({
  resolveRuntime: () => ({ msbPath: "/real/msb", libkrunfwPath: "/real/lib", origin: "bundled" }),
  resolveRuntimeVersion: async () => "0.7.11",
})));
vi.mock("microsandbox", factory);

import { checkRuntime, runtimeLogLine, type RuntimeDeps } from "../src/runtime.js";

const deps = (version: string | null | Error, origin = "home"): RuntimeDeps => ({
  resolveRuntime: () => ({ msbPath: "C:\\x\\msb.exe", origin }),
  resolveRuntimeVersion: async () => {
    if (version instanceof Error) throw version;
    return version;
  },
});

describe("checkRuntime", () => {
  it("does not import microsandbox until default deps are used", async () => {
    expect(factory).not.toHaveBeenCalled();
    const r = await checkRuntime("0.7.11");
    expect(factory).toHaveBeenCalled();
    expect(r).toEqual({ ok: true, origin: "bundled", msbPath: "/real/msb", version: "0.7.11" });
  });

  it("passes on a matching version", async () => {
    expect(await checkRuntime("0.7.11", deps("0.7.11"))).toEqual({
      ok: true,
      origin: "home",
      msbPath: "C:\\x\\msb.exe",
      version: "0.7.11",
    });
  });

  it("fails on a mismatch", async () => {
    expect(await checkRuntime("0.7.11", deps("0.7.12"))).toEqual({
      ok: false,
      message:
        "msb 0.7.12 does not match SDK 0.7.11; install msb 0.7.11 or remove the home install so the packaged runtime is used",
      origin: "home",
      msbPath: "C:\\x\\msb.exe",
      version: "0.7.12",
    });
  });

  it("fails with a reinstall hint when no runtime resolves", async () => {
    const d: RuntimeDeps = {
      resolveRuntime: () => {
        throw new Error("no msb");
      },
      resolveRuntimeVersion: async () => "0.7.11",
    };
    expect(await checkRuntime("0.7.11", d)).toEqual({
      ok: false,
      message: "no msb; reinstall shell-mcp without --omit=optional on this OS and CPU",
    });
  });

  it("treats a rejected version read like a resolve failure", async () => {
    const r = await checkRuntime("0.7.11", deps(new Error("bad exe")));
    expect(r).toEqual({
      ok: false,
      message: "bad exe; reinstall shell-mcp without --omit=optional on this OS and CPU",
      origin: "home",
      msbPath: "C:\\x\\msb.exe",
    });
  });

  it("passes with a note when the version is unknown", async () => {
    expect(await checkRuntime("0.7.11", deps(null))).toEqual({
      ok: true,
      origin: "home",
      msbPath: "C:\\x\\msb.exe",
      version: "unknown",
      note: "msb does not report its version; cannot compare with SDK 0.7.11",
    });
  });
});

describe("runtimeLogLine", () => {
  it("formats a pass", () => {
    expect(runtimeLogLine({ ok: true, origin: "home", msbPath: "C:\\x\\msb.exe", version: "0.7.11" })).toBe(
      "runtime msb 0.7.11 from home (C:\\x\\msb.exe)",
    );
  });
  it("appends a note", () => {
    expect(runtimeLogLine({ ok: true, origin: "home", msbPath: "/m", version: "unknown", note: "n" })).toBe(
      "runtime msb unknown from home (/m); n",
    );
  });
  it("keeps origin and path on a mismatch", () => {
    expect(runtimeLogLine({ ok: false, message: "boom", origin: "home", msbPath: "/m", version: "0.7.9" })).toBe(
      "runtime msb 0.7.9 from home (/m); warning: boom; run shell-mcp --check",
    );
  });
  it("formats a resolve failure", () => {
    expect(runtimeLogLine({ ok: false, message: "boom" })).toBe("warning: boom; run shell-mcp --check");
  });
});
