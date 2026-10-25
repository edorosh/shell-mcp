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
