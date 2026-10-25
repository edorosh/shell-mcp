import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCwd, newNonce, shQuote, wrapBackground, wrapForeground } from "../src/wrap.js";

describe("shQuote / newNonce / pure extractCwd", () => {
  it("quotes single quotes POSIX-style", () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shQuote("plain")).toBe("'plain'");
  });
  it("makes 16 hex char nonces", () => {
    expect(newNonce()).toMatch(/^[0-9a-f]{16}$/);
    expect(newNonce()).not.toBe(newNonce());
  });
  it("finds a marker that is not at the end (stream interleave)", () => {
    const r = extractCwd("a\n\n__SHELLMCP_CWD_n__/w/src\nb\n", "n");
    expect(r).toEqual({ output: "a\nb\n", cwd: "/w/src", reset: false });
  });
  it("uses the last marker and strips all", () => {
    const r = extractCwd("\n__SHELLMCP_CWD_n__/a\nx\n\n__SHELLMCP_CWD_n__/b\n", "n");
    expect(r.cwd).toBe("/b");
    expect(r.output).toBe("x\n");
  });
  it("ignores markers that do not start a line", () => {
    const r = extractCwd(`a __SHELLMCP_RESET_n__\nb "__SHELLMCP_CWD_n__" "$PWD"\n`, "n");
    expect(r).toEqual({ output: `a __SHELLMCP_RESET_n__\nb "__SHELLMCP_CWD_n__" "$PWD"\n`, cwd: null, reset: false });
  });
  it("strips a reset marker that follows output without a trailing newline", () => {
    // stdout ("no newline") can reach the merged stream before the reset marker the wrapper
    // printed first; the marker carries its own leading newline, like the cwd marker.
    expect(extractCwd("no newline\n__SHELLMCP_RESET_n__\n", "n")).toEqual({ output: "no newline", cwd: null, reset: true });
    expect(extractCwd("y\n\n__SHELLMCP_RESET_n__\nz", "n")).toEqual({ output: "y\nz", cwd: null, reset: true });
  });
  it("strips a reset line at the start", () => {
    expect(extractCwd("__SHELLMCP_RESET_n__\nx\n", "n")).toEqual({ output: "x\n", cwd: null, reset: true });
  });
  it("reports no marker as null", () => {
    expect(extractCwd("hi\n", "n")).toEqual({ output: "hi\n", cwd: null, reset: false });
  });
});

describe.skipIf(process.platform === "win32")("wrapped scripts under bash", () => {
  let tmp: string;
  const nonce = "0123456789abcdef";
  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "wrap-")));
    mkdirSync(join(tmp, "sub"));
    mkdirSync(join(tmp, "a'b"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // Run the script in its own `bash -c`, with stderr merged into stdout.
  const merged = (script: string) =>
    spawnSync("bash", ["-c", 'exec bash -c "$0" 2>&1', script], { encoding: "utf8" });
  const fg = (command: string, cwd: string) => {
    const q = merged(wrapForeground(command, cwd, tmp, nonce));
    return { status: q.status, ...extractCwd(q.stdout, nonce) };
  };

  it("pwd reports and strips the marker", () => {
    const r = fg("pwd", join(tmp, "sub"));
    expect(r.output).toBe(`${join(tmp, "sub")}\n`);
    expect(r.cwd).toBe(join(tmp, "sub"));
    expect(r.reset).toBe(false);
  });
  it("cd tracks", () => {
    const r = fg("cd sub && echo hi", tmp);
    expect(r.output).toBe("hi\n");
    expect(r.cwd).toBe(join(tmp, "sub"));
  });
  it("exit 7 mid-script keeps status and cwd", () => {
    const r = fg("cd sub; exit 7; echo no", tmp);
    expect(r.status).toBe(7);
    expect(r.cwd).toBe(join(tmp, "sub"));
    expect(r.output).toBe("");
  });
  it("handles quotes and trailing comments", () => {
    const r = fg("echo 'it''s'; # trailing comment", tmp);
    expect(r.output).toBe("its\n");
    expect(r.cwd).toBe(tmp);
  });
  it("handles a quote in cwd", () => {
    const r = fg("pwd", join(tmp, "a'b"));
    expect(r.output).toBe(`${join(tmp, "a'b")}\n`);
    expect(r.cwd).toBe(join(tmp, "a'b"));
  });
  it("unterminated here-doc does not eat the trap", () => {
    const r = fg("cat <<EOF\nabc", tmp);
    expect(r.cwd).toBe(tmp);
  });
  it("subshell cd does not leak", () => {
    expect(fg("(cd sub)", tmp).cwd).toBe(tmp);
  });
  it("exec yields no marker", () => {
    const r = fg("exec true", tmp);
    expect(r.cwd).toBeNull();
    expect(r.reset).toBe(false);
  });
  it("missing cwd resets", () => {
    const r = fg("pwd", join(tmp, "gone"));
    expect(r.reset).toBe(true);
    expect(r.cwd).toBe(tmp);
    expect(r.output).toBe(`${tmp}\n`);
    expect(r.output).not.toContain("SHELLMCP");
  });
  it("missing cwd with output lacking a trailing newline, stdout delivered before stderr", () => {
    // Worst-case arrival order: the command's stdout reaches the merged stream before the
    // reset and cwd markers the wrapper wrote to stderr.
    const q = spawnSync("bash", ["-c", wrapForeground("printf 'no newline'", join(tmp, "gone"), tmp, nonce)], { encoding: "utf8" });
    const r = extractCwd(q.stdout + q.stderr, nonce);
    expect(r).toEqual({ output: "no newline", cwd: tmp, reset: true });
  });
  it("forged marker with another nonce is kept", () => {
    const r = fg("echo __SHELLMCP_CWD_0000000000000000__/etc", join(tmp, "sub"));
    expect(r.output).toBe("__SHELLMCP_CWD_0000000000000000__/etc\n");
    expect(r.cwd).toBe(join(tmp, "sub"));
  });
  it("the script never contains a contiguous marker", () => {
    const s = wrapForeground("true", join(tmp, "gone"), tmp, nonce);
    expect(s).not.toContain(`__SHELLMCP_CWD_${nonce}__`);
    expect(s).not.toContain(`__SHELLMCP_RESET_${nonce}__`);
  });
  it("printing the running script does not forge a reset or move the cwd", () => {
    const r = fg('echo "$BASH_EXECUTION_STRING"', join(tmp, "sub"));
    expect(r.reset).toBe(false);
    expect(r.cwd).toBe(join(tmp, "sub"));
    expect(r.output).toContain("trap ");
    expect(r.output).toContain("__SHELLMCP_");
  });
  it.skipIf(process.platform !== "linux")("cat /proc/$$/cmdline does not forge a reset or move the cwd", () => {
    const r = fg("cat /proc/$$/cmdline; echo", join(tmp, "sub"));
    expect(r.reset).toBe(false);
    expect(r.cwd).toBe(join(tmp, "sub"));
    expect(r.output).toContain("trap ");
  });
  it("a forged real-nonce marker in the middle of a line is not taken", () => {
    const r = fg(`echo "x __SHELLMCP_CWD_${nonce}__/etc"`, join(tmp, "sub"));
    expect(r.cwd).toBe(join(tmp, "sub"));
    expect(r.output).toBe(`x __SHELLMCP_CWD_${nonce}__/etc\n`);
  });
  it("background: missing cwd prints a note", () => {
    const script = wrapBackground("pwd", join(tmp, "gone"), tmp);
    const q = merged(script);
    expect(q.stdout).toBe(`[shell-mcp: ${join(tmp, "gone")} no longer exists; started in ${tmp}]\n${tmp}\n`);
  });
  it("background: existing cwd has no note and no marker", () => {
    const q = spawnSync("bash", ["-c", wrapBackground("pwd", join(tmp, "sub"), tmp)], { encoding: "utf8" });
    expect(q.stdout).toBe(`${join(tmp, "sub")}\n`);
  });
});
