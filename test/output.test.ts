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
  it("text() between halves of a split char does not corrupt it", () => {
    const acc = new Utf8Accumulator();
    acc.push(new Uint8Array([0xc3]));
    expect(acc.text()).toBe("");
    acc.push(new Uint8Array([0xa9]));
    expect(acc.text()).toBe("é");
    acc.push(new Uint8Array([0xe2, 0x82]));
    expect(acc.text()).toBe("é");
    acc.push(new Uint8Array([0xac]));
    expect(acc.text()).toBe("é€");
  });
  it("finish() flushes an incomplete sequence", () => {
    const acc = new Utf8Accumulator();
    acc.push(new Uint8Array([0xc3]));
    expect(acc.finish()).toBe("\uFFFD");
  });
  it("drain() returns and clears decoded text but keeps pending bytes", () => {
    const acc = new Utf8Accumulator();
    acc.push(new Uint8Array([0x61, 0xc3]));
    expect(acc.drain()).toBe("a");
    expect(acc.text()).toBe("");
    acc.push(new Uint8Array([0xa9]));
    expect(acc.drain()).toBe("é");
    acc.push(new Uint8Array([0xe2]));
    expect(acc.drain()).toBe("");
    expect(acc.finish()).toBe("�");
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
  it("never exceeds max, even when max is smaller than the marker", () => {
    for (const max of [0, 1, 5, 20]) {
      const r = truncateMiddle("x".repeat(500), max);
      expect(r.text.length).toBeLessThanOrEqual(max);
      expect(r.omitted).toBe(500);
    }
  });
  it("does not split surrogate pairs", () => {
    const s = "😀".repeat(500);
    for (let max = 40; max < 80; max++) {
      const r = truncateMiddle(s, max);
      expect(r.text.length).toBeLessThanOrEqual(max);
      expect(r.text.isWellFormed()).toBe(true);
      const m = r.text.match(/\[\.\.\. (\d+) characters omitted \.\.\.\]/)!;
      expect(Number(m[1])).toBe(r.omitted);
      expect(r.omitted).toBe(1000 - (r.text.length - m[0].length));
    }
  });
});
