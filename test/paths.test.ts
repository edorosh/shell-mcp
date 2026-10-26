import { describe, expect, it } from "vitest";
import { PathMapper } from "../src/paths.js";

const win = new PathMapper([{ host: "C:\\Users\\e\\proj", guest: "/workspace" }], "win32");
const lin = new PathMapper([{ host: "/home/e/proj", guest: "/workspace" }], "linux");

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
  it("rejects backslash traversal and drive segments on win32", () => {
    expect(win.toHost("/workspace/..\\..\\Windows")).toBeNull();
    expect(win.toHost("/workspace/C:")).toBeNull();
    expect(win.toHost("/workspace/a\\b")).toBeNull();
  });
  it("uses one form for a lowercase forward-slash host root", () => {
    const m = new PathMapper([{ host: "c:/Users/e/proj", guest: "/workspace" }], "win32");
    expect(m.toHost("/workspace")).toBe("c:\\Users\\e\\proj");
    expect(m.toHost("/workspace/x")).toBe("c:\\Users\\e\\proj\\x");
  });
  it.each(["C:\\", "C:/"])("keeps a drive root %s absolute", (root) => {
    const m = new PathMapper([{ host: root, guest: "/workspace" }], "win32");
    expect(m.toHost("/workspace")).toBe("C:\\");
    expect(m.toHost("/workspace/x")).toBe("C:\\x");
  });
  it("handles guest root /", () => {
    const m = new PathMapper([{ host: "C:\\p", guest: "/" }], "win32");
    expect(m.toHost("/")).toBe("C:\\p");
    expect(m.toHost("/a/b")).toBe("C:\\p\\a\\b");
    // Documented limit: with guest root "/" the lookahead only matches a bare "/".
    expect(m.rewriteOutput("x /a/b y")).toBe("x /a/b y");
    expect(m.rewriteOutput("cwd=/")).toBe("cwd=C:\\p");
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

describe("several mounts", () => {
  it("maps through the longest matching guest prefix", () => {
    const m = new PathMapper([{ host: "C:\\p", guest: "/workspace" }, { host: "D:\\cache", guest: "/workspace/cache" }], "win32");
    expect(m.toHost("/workspace/cache/a")).toBe("D:\\cache\\a");
    expect(m.toHost("/workspace/src")).toBe("C:\\p\\src");
    expect(m.toHost("/workspacex")).toBeNull();
  });
  it("rewrites every guest root in output", () => {
    const m = new PathMapper([{ host: "/Users/u/p", guest: "/workspace" }, { host: "/Users/u/data", guest: "/data" }], "darwin");
    expect(m.rewriteOutput("/workspace/a and /data/b")).toBe("/Users/u/p/a and /Users/u/data/b");
  });
});
