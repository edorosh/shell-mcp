import { describe, expect, it } from "vitest";
import { PathMapper } from "../src/paths.js";

const win = new PathMapper("C:\\Users\\e\\proj", "/workspace", "win32");
const lin = new PathMapper("/home/e/proj", "/workspace", "linux");

describe("toHost", () => {
  it("maps the root and children (win32)", () => {
    expect(win.toHost("/workspace")).toBe("C:\\Users\\e\\proj");
    expect(win.toHost("/workspace/src/a.ts")).toBe("C:\\Users\\e\\proj\\src\\a.ts");
  });
  it("returns null outside the root", () => {
    expect(win.toHost("/workspace2/x")).toBeNull();
    expect(win.toHost("/tmp")).toBeNull();
    expect(win.toHost("/workspace/../tmp")).toBeNull();
  });
  it("maps on linux", () => {
    expect(lin.toHost("/workspace/src")).toBe("/home/e/proj/src");
  });
});

describe("displayCwd", () => {
  it("keeps guest form outside the root, host form inside", () => {
    expect(win.displayCwd("/tmp")).toBe("/tmp");
    expect(win.displayCwd("/workspace/src")).toBe("C:\\Users\\e\\proj\\src");
  });
});

describe("rewriteOutput", () => {
  it.each([
    ["FAIL /workspace/src/a.ts:3:7", "FAIL C:\\Users\\e\\proj\\src\\a.ts:3:7"],
    ["at (/workspace/x.js:1)", "at (C:\\Users\\e\\proj\\x.js:1)"],
    ["'/workspace/a b/c.ts'", "'C:\\Users\\e\\proj\\a b/c.ts'"],
    ["/workspace2/x", "/workspace2/x"],
    ["foo/workspace/x", "foo/workspace/x"],
    ["http://h/workspace/x", "http://h/workspace/x"],
    ["cwd=/workspace", "cwd=C:\\Users\\e\\proj"],
    ["a\n/workspace/b.ts", "a\nC:\\Users\\e\\proj\\b.ts"],
  ])("win32: %s", (input, expected) => {
    expect(win.rewriteOutput(input)).toBe(expected);
  });
  it("linux", () => {
    expect(lin.rewriteOutput("/workspace/a.ts")).toBe("/home/e/proj/a.ts");
  });
});
