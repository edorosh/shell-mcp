import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { describeTools } from "../src/descriptions.js";

const cfg = parseConfig(
  ["--sandbox", "sb", "--host-root", "C:\\Users\\e\\proj", "--guest-root", "/workspace"],
  {},
  { platform: "win32", exists: () => true },
);

describe("describeTools", () => {
  const d = describeTools(cfg).shell;
  it.each([
    "Linux sandbox", "C:\\Users\\e\\proj", "/workspace", "bash", "120", "600",
    "run_in_background", "environment", "Interactive programs", "file tools with host paths", "parallel calls",
  ])("shell description mentions %s", (s) => {
    expect(d).toContain(s);
  });
  it("describes the other tools", () => {
    const t = describeTools(cfg);
    expect(t.shell_output).toBeTruthy();
    expect(t.shell_kill).toBeTruthy();
    expect(t.shell_list).toBeTruthy();
  });
});

describe("describeTools with several mounts", () => {
  const multi = parseConfig(
    ["--sandbox", "sb", "--image", "i", "--mount", "/h/p:/workspace:ro", "--mount", "/h/q:/data"],
    {},
    { platform: "linux", exists: () => true, realpath: (p) => p },
  );
  const d = describeTools(multi).shell;
  it("marks a read-only project mount and lists the other mounts", () => {
    expect(d).toContain("/h/p is mounted in the sandbox at /workspace (read-only)");
    expect(d).toContain("Also mounted: /h/q at /data.");
  });
  it("adds nothing for a single mount", () => {
    expect(describeTools(cfg).shell).not.toContain("Also mounted");
  });
});

describe("single-mount description keeps the 1.1.0 wording", () => {
  it("matches exactly", () => {
    const c = parseConfig(
      ["--sandbox", "sb", "--host-root", "/h/p", "--guest-root", "/workspace"],
      {},
      { platform: "linux", exists: () => true },
    );
    expect(describeTools(c).shell).toBe(
      "Run a shell command (bash) inside an isolated Linux sandbox, not on the host machine. " +
      "The host directory /h/p is mounted in the sandbox at /workspace; the command starts in /workspace " +
      "and only files under that directory are shared with the host. " +
      "The working directory persists between calls, but environment variables and shell state (aliases, functions) do not. " +
      "Do not rely on cd across parallel calls: each starts in the directory current when it starts, and the last to finish sets it. " +
      "Default timeout is 120 seconds, maximum 600 seconds (timeout_ms). " +
      "Use run_in_background for servers and other long-running processes; it returns a job id to use with shell_output, shell_kill and shell_list. " +
      "Interactive programs (editors, pagers, prompts waiting for input) are not supported. " +
      "Paths in output under /workspace are shown as host paths under /h/p. " +
      "To read or edit files, use your file tools with host paths (/h/p) rather than shell commands.",
    );
  });
});
