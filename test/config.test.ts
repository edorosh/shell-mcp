import { describe, expect, it } from "vitest";
import { ConfigError, parseCli, parseConfig, parseDuration, parseMemory, parseMount } from "../src/config.js";

const yes = { platform: "linux" as const, exists: () => true };
const base = ["--sandbox", "p", "--host-root", "/h/p", "--guest-root", "/workspace/"];

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("120s")).toBe(120000);
    expect(parseDuration("5m")).toBe(300000);
    expect(parseDuration("1500ms")).toBe(1500);
    expect(parseDuration("90")).toBe(90000);
  });
  it("rejects bad values", () => {
    for (const s of ["abc", "0s", "-1s"]) expect(() => parseDuration(s)).toThrow(ConfigError);
  });
});

describe("parseConfig", () => {
  it("parses flags with defaults", () => {
    expect(parseConfig(base, {}, yes)).toEqual({
      sandbox: "p", mounts: [{ host: "/h/p", hostResolved: "/h/p", guest: "/workspace", readonly: false }], recreate: false,
      defaultTimeoutMs: 120000, maxTimeoutMs: 600000, maxOutput: 30000,
      rewriteOutputPaths: true, shell: "bash", platform: "linux",
    });
  });
  it("falls back to env; flag wins", () => {
    const env = { SHELL_MCP_SANDBOX: "e", SHELL_MCP_HOST_ROOT: "/h/e", SHELL_MCP_GUEST_ROOT: "/g",
      SHELL_MCP_SHELL: "sh", SHELL_MCP_MAX_OUTPUT: "10" };
    const c = parseConfig([], env, yes);
    expect(c).toMatchObject({ sandbox: "e", mounts: [{ host: "/h/e", guest: "/g" }], shell: "sh", maxOutput: 10 });
    expect(parseConfig(["--sandbox", "f"], env, yes).sandbox).toBe("f");
  });
  it("disables path rewriting", () => {
    expect(parseConfig([...base, "--no-rewrite-output-paths"], {}, yes).rewriteOutputPaths).toBe(false);
    expect(parseConfig(base, { SHELL_MCP_REWRITE_OUTPUT_PATHS: "0" }, yes).rewriteOutputPaths).toBe(false);
    for (const v of ["false", "FALSE", "no", "No", " 0 "]) {
      expect(parseConfig(base, { SHELL_MCP_REWRITE_OUTPUT_PATHS: v }, yes).rewriteOutputPaths).toBe(false);
    }
    for (const v of ["1", "true", "yes", "", "off"]) {
      expect(parseConfig(base, { SHELL_MCP_REWRITE_OUTPUT_PATHS: v }, yes).rewriteOutputPaths).toBe(true);
    }
    expect(parseConfig([...base, "--rewrite-output-paths"], { SHELL_MCP_REWRITE_OUTPUT_PATHS: "0" }, yes).rewriteOutputPaths).toBe(true);
  });
  it("normalizes windows host roots", () => {
    const w = { platform: "win32" as const, exists: () => true };
    const a = (r: string) => ["--sandbox", "p", "--host-root", r, "--guest-root", "/w"];
    expect(parseConfig(a("C:\\Users\\e\\proj\\"), {}, w).mounts[0].host).toBe("C:\\Users\\e\\proj");
    expect(parseConfig(a("C:/Users/e/proj"), {}, w).mounts[0].host).toBe("C:\\Users\\e\\proj");
  });
  it("names the setting in errors", () => {
    const no = { platform: "linux" as const, exists: () => false };
    expect(() => parseConfig(["--host-root", "/h", "--guest-root", "/w"], {}, yes)).toThrow(/sandbox/);
    expect(() => parseConfig(["--sandbox", "p", "--host-root", "proj", "--guest-root", "/w"], {}, yes)).toThrow(/host-root/);
    expect(() => parseConfig(base, {}, no)).toThrow(/host-root/);
    expect(() => parseConfig(["--sandbox", "p", "--host-root", "/h", "--guest-root", "workspace"], {}, yes)).toThrow(/guest-root/);
    expect(() => parseConfig([...base, "--default-timeout", "11m"], {}, yes)).toThrow(/default-timeout/);
    expect(() => parseConfig(base, {}, yes)).not.toThrow();
  });
});

describe("parseCli", () => {
  it("selects version and help without validating anything else", () => {
    expect(parseCli(["--version"], {})).toEqual({ mode: "version" });
    expect(parseCli(["--help"], {})).toEqual({ mode: "help" });
    expect(parseCli(["--version", "--host-root", "relative"], {})).toEqual({ mode: "version" });
    expect(parseCli(["--version", "--bogus"], {})).toEqual({ mode: "version" });
  });
  it("gives --help precedence over --version", () => {
    expect(parseCli(["--help", "--version"], {})).toEqual({ mode: "help" });
    expect(parseCli(["--version", "--help"], {})).toEqual({ mode: "help" });
  });
  it("selects check with the parsed config", () => {
    expect(parseCli(["--check", ...base], {}, yes)).toEqual({ mode: "check", config: parseConfig(base, {}, yes) });
  });
  it("defaults to serve", () => {
    expect(parseCli(base, {}, yes)).toEqual({ mode: "serve", config: parseConfig(base, {}, yes) });
  });
  it("still validates config in check and serve modes", () => {
    expect(() => parseCli(["--check"], {})).toThrow(ConfigError);
    expect(() => parseCli(["--bogus", ...base], {}, yes)).toThrow(ConfigError);
  });
});

describe("parseMemory", () => {
  it("parses MiB and g suffix", () => {
    expect(parseMemory("2048")).toBe(2048);
    expect(parseMemory("2g")).toBe(2048);
    expect(parseMemory("1.5g")).toBe(1536);
  });
  it("rejects bad values", () => {
    for (const s of ["0", "x", "-1", "0g"]) expect(() => parseMemory(s)).toThrow(ConfigError);
  });
});

describe("parseMount", () => {
  it("parses a Windows mount with spaces and :ro", () => {
    expect(parseMount("C:\\Users\\u\\dev\\my proj:/workspace:ro", "win32"))
      .toEqual({ host: "C:\\Users\\u\\dev\\my proj", guest: "/workspace", readonly: true });
  });
  it("splits on the last :/", () => {
    expect(parseMount("/Users/u/a:/b:/workspace", "darwin")).toEqual({ host: "/Users/u/a:/b", guest: "/workspace", readonly: false });
  });
  it("strips a trailing slash from the guest", () => {
    expect(parseMount("/h/p:/workspace/", "linux").guest).toBe("/workspace");
  });
  it.each(["C:\\p", "C:\\p:/", "C:\\p:relative", "rel:/workspace"])("rejects mount %s", (s) => {
    expect(() => parseMount(s, "win32")).toThrow(ConfigError);
  });
});

describe("create mode", () => {
  const create = { platform: "linux" as const, exists: () => true, realpath: (p: string) => p };
  const img = ["--sandbox", "s", "--image", "i", "--mount", "/h/p:/workspace"];
  it("--image switches on create mode with resolved host paths", () => {
    const c = parseConfig(["--sandbox", "s", "--image", "ubuntu:24.04", "--mount", "/Users/u/dev/p:/workspace",
      "--allow-domain", "registry.npmjs.org", "--allow-domain", "*.github.com", "--cpus", "2", "--memory", "2g"], {},
      { platform: "darwin", exists: () => true, realpath: () => "/Volumes/d/dev/p" });
    expect(c.mounts).toEqual([{ host: "/Users/u/dev/p", hostResolved: "/Volumes/d/dev/p", guest: "/workspace", readonly: false }]);
    expect(c.machine).toEqual({ image: "ubuntu:24.04", allowDomains: ["registry.npmjs.org", "*.github.com"], allowNetwork: false, cpus: 2, memoryMib: 2048 });
  });
  it("reads SHELL_MCP_MOUNT and skips empty entries", () => {
    const c = parseConfig(["--sandbox", "s", "--image", "i"], { SHELL_MCP_MOUNT: "/a:/x;;/b:/y;" }, create);
    expect(c.mounts.map((m) => m.guest)).toEqual(["/x", "/y"]);
  });
  it("repeatable flags replace their env var", () => {
    const env = { SHELL_MCP_MOUNT: "/a:/x", SHELL_MCP_ALLOW_DOMAIN: "a.com, b.com,", SHELL_MCP_ALLOW_NETWORK: "YES" };
    expect(parseConfig(["--sandbox", "s", "--image", "i"], env, create)).toMatchObject({
      mounts: [{ guest: "/x" }], machine: { allowDomains: ["a.com", "b.com"], allowNetwork: true },
    });
    const c = parseConfig([...img, "--allow-domain", "c.com"], env, create);
    expect(c.mounts.map((m) => m.guest)).toEqual(["/workspace"]);
    expect(c.machine?.allowDomains).toEqual(["c.com"]);
  });
  it("does not call realpath in attach mode", () => {
    const realpath = () => { throw new Error("no"); };
    expect(parseConfig(base, {}, { ...yes, realpath }).mounts[0].hostResolved).toBe("/h/p");
  });
  it("marks read-only mounts", () => {
    expect(parseConfig(["--sandbox", "s", "--image", "i", "--mount", "/h/p:/workspace:ro"], {}, create).mounts[0].readonly).toBe(true);
  });
  it.each([
    ["--host-root with --image", [...img, "--host-root", "/h"]],
    ["--mount without --image", ["--sandbox", "s", "--host-root", "/h", "--guest-root", "/w", "--mount", "/a:/b"]],
    ["--image without a mount", ["--sandbox", "s", "--image", "i"]],
    ["duplicate guest paths", [...img, "--mount", "/h/q:/workspace"]],
    ["guest /", ["--sandbox", "s", "--image", "i", "--mount", "/h/p:/"]],
    ["--memory 0", [...img, "--memory", "0"]],
    ["--cpus x", [...img, "--cpus", "x"]],
    ["--recreate without --image", ["--sandbox", "s", "--host-root", "/h", "--guest-root", "/w", "--recreate"]],
  ])("rejects %s", (_n, argv) => {
    expect(() => parseConfig(argv, {}, create)).toThrow(ConfigError);
  });
  it("rejects a missing mount host path", () => {
    expect(() => parseConfig(img, {}, { ...create, exists: () => false })).toThrow(/does not exist/);
  });
  it("rejects --recreate with --check", () => {
    expect(() => parseCli(["--check", ...img, "--recreate"], {}, create)).toThrow(ConfigError);
  });
  it("selects prepare, below help, version and check", () => {
    const cli = parseCli(["--prepare", ...img, "--recreate"], {}, create);
    expect(cli.mode).toBe("prepare");
    expect(cli).toMatchObject({ config: { recreate: true } });
    expect(parseCli(["--prepare", "--help"], {})).toEqual({ mode: "help" });
    expect(parseCli(["--prepare", "--version"], {})).toEqual({ mode: "version" });
    expect(parseCli(["--prepare", "--check", ...img], {}, create).mode).toBe("check");
  });
});
