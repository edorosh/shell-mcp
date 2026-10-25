import { describe, expect, it } from "vitest";
import { changelogSection, checkRelease } from "../scripts/check-release.mjs";

const changelog = "## [Unreleased]\n\n## [1.0.0] - 2026-11-01\n\nFirst.\n\n## [0.9.0]\n\nOld.\n";

describe("checkRelease", () => {
  it("accepts a matching tag with a dated changelog section", () => {
    expect(checkRelease("v1.0.0", "1.0.0", "## [1.0.0] - 2026-11-01")).toBeNull();
  });

  it("accepts a changelog section without a date", () => {
    expect(checkRelease("v1.0.0", "1.0.0", "## [1.0.0]\n")).toBeNull();
  });

  it("names both versions when the tag differs from package.json", () => {
    const error = checkRelease("v1.0.1", "1.0.0", "## [1.0.0] - 2026-11-01");
    expect(error).toContain("1.0.1");
    expect(error).toContain("1.0.0");
  });

  it("fails when the changelog has no section for the version", () => {
    expect(checkRelease("v1.0.0", "1.0.0", "## [Unreleased]")).toMatch(/changelog/i);
  });

  it("is not fooled by near-matching headings", () => {
    expect(checkRelease("v1.0.0", "1.0.0", "## [1.0.0x]\n## [11.0.0]\n## [1.0.0.1]")).toMatch(/changelog/i);
  });

  it("fails a tag without the v prefix", () => {
    expect(checkRelease("1.0.0", "1.0.0", "## [1.0.0]")).toMatch(/v1\.0\.0/);
  });
});

describe("changelogSection", () => {
  it("returns the body up to the next version heading", () => {
    expect(changelogSection(changelog, "1.0.0")).toBe("First.");
  });

  it("returns null when the version has no section", () => {
    expect(changelogSection(changelog, "2.0.0")).toBeNull();
  });
});
