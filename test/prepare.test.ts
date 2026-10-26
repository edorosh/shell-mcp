import { describe, expect, it } from "vitest";
import { BackendError } from "../src/backend/types.js";
import { runPrepare } from "../src/prepare.js";

const run = async (ensure: (on?: (l: string) => void) => Promise<unknown>) => {
  const lines: string[] = [];
  const code = await runPrepare({ ensure } as never, (l) => lines.push(l), "s");
  return { code, lines };
};

describe("runPrepare", () => {
  it("writes each stage, then the ready line, and returns 0", async () => {
    const { code, lines } = await run(async (on) => {
      on?.("checking");
      on?.("pulling ubuntu:24.04, 50%");
    });
    expect(code).toBe(0);
    expect(lines).toEqual(["checking", "pulling ubuntu:24.04, 50%", 'ready: sandbox "s" is running']);
  });

  it("reports a config mismatch as FAIL and returns 1", async () => {
    const { code, lines } = await run(async () => {
      throw new BackendError("config_mismatch", "sandbox s differs");
    });
    expect(code).toBe(1);
    expect(lines).toEqual(["FAIL sandbox s differs"]);
  });

  it("returns 1 with the message for any other error", async () => {
    const { code, lines } = await run(async () => {
      throw new Error("pull failed");
    });
    expect(code).toBe(1);
    expect(lines).toEqual(["FAIL pull failed"]);
  });
});
