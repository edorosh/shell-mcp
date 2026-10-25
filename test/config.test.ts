import { describe, expect, it } from "vitest";
import { ConfigError, parseCli, parseConfig, parseDuration } from "../src/config.js";

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
      sandbox: "p", hostRoot: "/h/p", guestRoot: "/workspace",
      defaultTimeoutMs: 120000, maxTimeoutMs: 600000, maxOutput: 30000,
      rewriteOutputPaths: true, shell: "bash", platform: "linux",
    });
  });
  it("falls back to env; flag wins", () => {
    const env = { SHELL_MCP_SANDBOX: "e", SHELL_MCP_HOST_ROOT: "/h/e", SHELL_MCP_GUEST_ROOT: "/g",
      SHELL_MCP_SHELL: "sh", SHELL_MCP_MAX_OUTPUT: "10" };
    const c = parseConfig([], env, yes);
    expect(c).toMatchObject({ sandbox: "e", hostRoot: "/h/e", guestRoot: "/g", shell: "sh", maxOutput: 10 });
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
    expect(parseConfig(a("C:\\Users\\e\\proj\\"), {}, w).hostRoot).toBe("C:\\Users\\e\\proj");
    expect(parseConfig(a("C:/Users/e/proj"), {}, w).hostRoot).toBe("C:\\Users\\e\\proj");
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
