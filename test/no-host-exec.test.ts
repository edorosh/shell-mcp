import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("no host exec", () => {
  it("src/ never mentions child_process", () => {
    for (const f of tsFiles("src")) {
      expect(readFileSync(f, "utf8"), f).not.toContain("child_process");
    }
  });
});
