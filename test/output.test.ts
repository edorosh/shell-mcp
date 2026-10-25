import { describe, it, expect } from "vitest";
import { Utf8Accumulator, truncateMiddle } from "../src/output.js";

describe("Utf8Accumulator", () => {
  it("joins a multibyte char split across chunks", () => {
    const acc = new Utf8Accumulator();
    acc.push(new Uint8Array([0xc3]));
    acc.push(new Uint8Array([0xa9]));
    expect(acc.text()).toBe("é");
  });
  it("replaces invalid bytes without throwing", () => {
    const acc = new Utf8Accumulator();
    acc.push(new Uint8Array([0xff]));
    expect(acc.text()).toContain("�");
  });
  it("accepts strings", () => {
    const acc = new Utf8Accumulator();
    acc.push("ab");
    acc.push("c");
    expect(acc.text()).toBe("abc");
  });
});

describe("truncateMiddle", () => {
  it("leaves short text unchanged", () => {
    expect(truncateMiddle("x".repeat(100), 200)).toEqual({ text: "x".repeat(100), omitted: 0 });
  });
  it("adds a marker when alreadyOmitted > 0 even if text fits", () => {
    const r = truncateMiddle("hello", 200, 50);
    expect(r.omitted).toBe(50);
    expect(r.text).toContain("[... 50 characters omitted ...]");
    expect(r.text.length).toBeLessThanOrEqual(200);
  });
  it("truncates the middle within the budget, marker counts its own space", () => {
    const r = truncateMiddle("a".repeat(1000) + "b".repeat(1000), 100);
    expect(r.text.length).toBeLessThanOrEqual(100);
    expect(r.text.startsWith("a")).toBe(true);
    expect(r.text.endsWith("b")).toBe(true);
    const m = r.text.match(/\[\.\.\. (\d+) characters omitted \.\.\.\]/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(r.omitted);
    expect(r.omitted).toBe(2000 - (r.text.length - m![0].length));
    expect(r.text.length).toBe(100);
  });
  it("adds alreadyOmitted to the count when cutting", () => {
    const r = truncateMiddle("x".repeat(1000), 100, 500);
    expect(r.text).toContain(`[... ${r.omitted} characters omitted ...]`);
    expect(r.omitted).toBeGreaterThan(1400);
    expect(r.text.length).toBeLessThanOrEqual(100);
  });
});
