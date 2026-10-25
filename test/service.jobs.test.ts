import { describe, expect, it } from "vitest";
import { BackendError } from "../src/backend/types.js";
import { type Config, parseConfig } from "../src/config.js";
import { ShellService } from "../src/service.js";
import { FakeBackend } from "./fakeBackend.js";

const mk = (extra: string[] = []): Config =>
  parseConfig(
    ["--sandbox", "sb", "--host-root", "C:\\Users\\e\\proj", "--guest-root", "/workspace", ...extra],
    {},
    { platform: "win32", exists: () => true },
  );
const setup = (cfg = mk(), id = "job1") => {
  const fb = new FakeBackend();
  const svc = new ShellService(cfg, fb, { nonce: "n", now: undefined });
  svc.jobs.add(id, "sleep 100");
  return { fb, svc };
};

describe("unknown job ids", () => {
  it("output and kill reject without calling the backend", async () => {
    const { fb, svc } = setup();
    for (const r of [await svc.output({ job_id: "nope" }), await svc.kill({ job_id: "nope" })]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("unknown job");
    }
    expect(fb.readCalls).toHaveLength(0);
    expect(fb.killCalls).toHaveLength(0);
  });
});

describe("output", () => {
  it("threads the cursor and rewrites paths", async () => {
    const { fb, svc } = setup();
    fb.readQueue.push({ text: "see /workspace/a.txt\n", cursor: "c1" }, { text: "more\n", cursor: "c2" });
    const r1 = await svc.output({ job_id: "job1" });
    expect(r1.isError).toBe(false);
    expect(r1.text.startsWith("status: running")).toBe(true);
    expect(r1.text).toContain("C:\\Users\\e\\proj\\a.txt");
    await svc.output({ job_id: "job1" });
    expect(fb.readCalls.map((c) => c.cursor)).toEqual([undefined, "c1"]);
  });

  it("pages output larger than max-output without losing anything", async () => {
    const { fb, svc } = setup(mk(["--max-output", "100"]));
    const big = Array.from({ length: 250 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    fb.readQueue.push({ text: big, cursor: "c1" });
    const bodies: string[] = [];
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await svc.output({ job_id: "job1" });
      texts.push(r.text);
      bodies.push(r.text.split("\n---\n")[1]!.split("\n[")[0]!);
    }
    expect(bodies.every((b) => b.length <= 100)).toBe(true);
    expect(bodies.join("")).toBe(big);
    expect(texts[0]).toContain("more output pending; call shell_output again");
    expect(texts[1]).toContain("more output pending; call shell_output again");
    expect(texts[2]).not.toContain("more output pending");
    expect(fb.readCalls).toHaveLength(1);
  });

  it("keeps the cursor across an empty read that omits it", async () => {
    const { fb, svc } = setup();
    fb.readQueue.push({ text: "a", cursor: "c1" }, { text: "" }, { text: "b", cursor: "c3" });
    for (let i = 0; i < 3; i++) await svc.output({ job_id: "job1" });
    expect(fb.readCalls.map((c) => c.cursor)).toEqual([undefined, "c1", "c1"]);
  });

  it("pages astral text with max-output 1 to completion", async () => {
    const { fb, svc } = setup(mk(["--max-output", "1"]));
    const big = "😀😀x😀";
    fb.readQueue.push({ text: big, cursor: "c1" });
    let got = "";
    for (let i = 0; i < 6; i++) {
      const r = await svc.output({ job_id: "job1" });
      got += r.text.split("\n---\n")[1]!.split("\n[")[0]!;
    }
    expect(got).toBe(big);
  });

  it("reports a gap", async () => {
    const { fb, svc } = setup();
    fb.readQueue.push({ text: "x", cursor: "c", gap: true });
    expect((await svc.output({ job_id: "job1" })).text).toContain("[some output was discarded by the sandbox]");
  });

  it("maps statuses", async () => {
    const { fb, svc } = setup();
    fb.jobStatuses.set("job1", { state: "exited", exitCode: 0 });
    expect((await svc.output({ job_id: "job1" })).text).toContain("status: exited (exit code 0)");
    fb.jobStatuses.set("job1", { state: "lost" });
    expect((await svc.output({ job_id: "job1" })).text).toContain("status: lost");
    fb.jobStatuses.set("job1", { state: "exited", error: "No such file" });
    expect((await svc.output({ job_id: "job1" })).text).toContain("status: exited (failed to start: No such file)");
    fb.jobStatuses.set("job1", { state: "exited", exitCode: 137 });
    svc.jobs.get("job1")!.killedByUs = true;
    expect((await svc.output({ job_id: "job1" })).text).toContain("status: killed");
  });
});

describe("kill", () => {
  it("kills a running job and confirms", async () => {
    const { fb, svc } = setup();
    const r = await svc.kill({ job_id: "job1" });
    expect(fb.killCalls).toEqual([{ id: "job1", waitMs: 3000 }]);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("killed (exit confirmed)");
    expect(svc.jobs.get("job1")!.killedByUs).toBe(true);
    fb.jobStatuses.set("job1", { state: "exited", exitCode: 137 });
    expect((await svc.output({ job_id: "job1" })).text).toContain("status: killed");
  });

  it("reports unconfirmed exit", async () => {
    const { fb, svc } = setup();
    fb.killResult = { confirmed: false, status: { state: "running" } };
    expect((await svc.kill({ job_id: "job1" })).text).toContain("kill requested; exit not yet confirmed");
  });

  it("already-exited job: no kill call, final status reported", async () => {
    const { fb, svc } = setup();
    fb.jobStatuses.set("job1", { state: "exited", exitCode: 5 });
    const r = await svc.kill({ job_id: "job1" });
    expect(fb.killCalls).toHaveLength(0);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("exited (exit code 5)");
    expect(svc.jobs.get("job1")!.killedByUs).toBe(false);
  });

  it("race: job exited naturally between status and kill", async () => {
    const { fb, svc } = setup();
    fb.killResult = { confirmed: true, status: { state: "exited", exitCode: 0 } };
    const r = await svc.kill({ job_id: "job1" });
    expect(r.text).toContain("exited (exit code 0)");
    expect(r.text).not.toContain("killed");
    expect(svc.jobs.get("job1")!.killedByUs).toBe(false);
  });
});

describe("list", () => {
  it("empty", async () => {
    const svc = new ShellService(mk(), new FakeBackend(), { nonce: "n" });
    expect(await svc.list()).toEqual({ text: "No background jobs started in this session.", isError: false });
  });

  it("one line per registry job", async () => {
    const fb = new FakeBackend();
    const svc = new ShellService(mk(), fb, { nonce: "n", now: () => new Date("2026-01-02T03:04:05.000Z") });
    svc.jobs.add("job1", "sleep 100");
    svc.jobs.add("job2", "make…");
    fb.jobStatuses.set("job2", { state: "exited", exitCode: 0 });
    const lines = (await svc.list()).text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("job1  running  2026-01-02T03:04:05.000Z  sleep 100");
    expect(lines[1]).toBe("job2  exited (exit code 0)  2026-01-02T03:04:05.000Z  make…");
  });
});

describe("job tool errors", () => {
  it("do not use the shell tool's started/not-started wording", async () => {
    const { fb, svc } = setup();
    fb.jobError = new BackendError("not_running", "stopped");
    for (const r of [await svc.output({ job_id: "job1" }), await svc.kill({ job_id: "job1" }), await svc.list()]) {
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("Command");
      expect(r.text).toContain('sandbox "sb" is not running. Start it with: msb start sb');
    }
    fb.jobError = new BackendError("unreachable", "no daemon");
    const u = await svc.list();
    expect(u.text).toBe('Could not list jobs: sandbox "sb" is unreachable: no daemon. If it is stopped, start it with: msb start sb');
    fb.jobError = new BackendError("outcome_unknown", "stream reset");
    expect((await svc.output({ job_id: "job1" })).text).toBe(
      "Could not read job output: stream reset. Check the sandbox state and try again.",
    );
    const k = await svc.kill({ job_id: "job1" });
    expect(k.text).toContain("Kill request outcome is unknown: stream reset");
    expect(k.text).not.toContain("Command");
  });
});
