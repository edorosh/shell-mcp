import { describe, expect, it } from "vitest";
import { BackendError } from "../src/backend/types.js";
import {
  MicrosandboxBackend,
  type SdkExecEvent,
  type SdkJob,
  type SdkJobInfo,
  type SdkLogEntry,
  type SdkModule,
  type SdkSandbox,
} from "../src/backend/microsandbox.js";

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => new Uint8Array(b);

class SdkErr extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

interface ExecScript {
  events: (SdkExecEvent | SdkErr | "hang")[];
}

function info(over: Partial<SdkJobInfo> = {}): SdkJobInfo {
  return { state: "running", exitCode: null, error: null, failure: null, ...over };
}

class FakeJob implements SdkJob {
  logsCalls: ({ fromCursor?: string } | undefined)[] = [];
  killed = 0;
  logPages: (SdkLogEntry[] | SdkErr)[] = [];
  infos: SdkJobInfo[] = [info()];
  killError?: SdkErr;
  constructor(readonly id: string) {}
  async inspect() {
    return this.infos.length > 1 ? this.infos.shift()! : this.infos[0]!;
  }
  async kill() {
    this.killed++;
    if (this.killError) throw this.killError;
  }
  async logs(opts?: { fromCursor?: string }) {
    this.logsCalls.push(opts);
    const p = this.logPages.shift() ?? [];
    if (p instanceof SdkErr) throw p;
    return p;
  }
}

class FakeSandbox implements SdkSandbox {
  execs: { cmd: string; args?: string[]; timeout?: number; stdinNull: boolean }[] = [];
  detached: { cmd: string; args?: string[]; stdinNull: boolean }[] = [];
  script: ExecScript = { events: [{ kind: "exited", code: 0 }] };
  execError?: SdkErr;
  jobs = new Map<string, FakeJob>();
  killedExec = 0;
  onRecv?: () => void;

  private builder() {
    const rec: { args?: string[]; timeout?: number; stdinNull: boolean } = { stdinNull: false };
    const b = {
      args(a: string[]) { rec.args = a; return b; },
      timeout(ms: number) { rec.timeout = ms; return b; },
      stdinNull() { rec.stdinNull = true; return b; },
    };
    return { b, rec };
  }

  async execStreamWith(cmd: string, configure: (b: never) => unknown) {
    const { b, rec } = this.builder();
    configure(b as never);
    this.execs.push({ cmd, ...rec });
    if (this.execError) throw this.execError;
    const events = [...this.script.events];
    return {
      recv: async () => {
        this.onRecv?.();
        const e = events.shift();
        if (e === undefined) return null;
        if (e === "hang") return new Promise<never>(() => {});
        if (e instanceof SdkErr) throw e;
        return e;
      },
      kill: async () => { this.killedExec++; },
    };
  }

  async execDetachedWith(cmd: string, configure: (b: never) => unknown) {
    const { b, rec } = this.builder();
    configure(b as never);
    this.detached.push({ cmd, args: rec.args, stdinNull: rec.stdinNull });
    if (this.execError) throw this.execError;
    const j = new FakeJob(`job_${this.detached.length}`);
    this.jobs.set(j.id, j);
    return j;
  }

  async getJob(id: string) {
    const j = this.jobs.get(id);
    if (!j) throw new SdkErr("job_not_found");
    return j;
  }
}

function setup(opts: { status?: string; getError?: SdkErr; connectError?: SdkErr; maxOutput?: number; clock?: number[]; graceMs?: number } = {}) {
  const sb = new FakeSandbox();
  const calls = { get: 0, connect: 0, load: 0 };
  const sdk: SdkModule = {
    Sandbox: {
      get: async (name: string) => {
        calls.get++;
        expect(name).toBe("proj");
        if (opts.getError) throw opts.getError;
        return {
          status: opts.status ?? "running",
          connectWithTimeout: async (ms: number) => {
            calls.connect++;
            expect(ms).toBe(10_000);
            if (opts.connectError) throw opts.connectError;
            return sb;
          },
        };
      },
    },
  };
  const clock = opts.clock ? [...opts.clock] : undefined;
  const be = new MicrosandboxBackend("proj", "bash", opts.maxOutput ?? 1000, {
    loadSdk: async () => {
      calls.load++;
      return sdk;
    },
    now: clock ? () => (clock.length > 1 ? clock.shift()! : clock[0]!) : undefined,
    graceMs: opts.graceMs,
  });
  return { be, sb, calls };
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BackendError);
    return (e as BackendError).kind;
  }
  return "resolved";
}

describe("MicrosandboxBackend connection", () => {
  it("does not load the SDK or contact the sandbox at construction", () => {
    const { calls } = setup();
    expect(calls).toEqual({ get: 0, connect: 0, load: 0 });
  });

  it("connects lazily once and caches the connection", async () => {
    const { be, calls } = setup();
    await be.run("true", { timeoutMs: 1000 });
    await be.run("true", { timeoutMs: 1000 });
    expect(calls.get).toBe(1);
    expect(calls.connect).toBe(1);
  });

  it("maps sandboxNotFound to not_found", async () => {
    const { be } = setup({ getError: new SdkErr("sandboxNotFound") });
    expect(await kindOf(be.run("x", { timeoutMs: 1 }))).toBe("not_found");
  });

  it("maps a non-running status to not_running without connecting", async () => {
    const { be, calls } = setup({ status: "stopped" });
    expect(await kindOf(be.run("x", { timeoutMs: 1 }))).toBe("not_running");
    expect(calls.connect).toBe(0);
  });

  it("maps a connect failure to unreachable and retries on the next call", async () => {
    const { be, calls } = setup({ connectError: new SdkErr("io", "socket refused") });
    expect(await kindOf(be.run("x", { timeoutMs: 1 }))).toBe("unreachable");
    expect(await kindOf(be.run("x", { timeoutMs: 1 }))).toBe("unreachable");
    expect(calls.connect).toBe(2);
  });

  it("maps an SDK load failure to unreachable", async () => {
    const be = new MicrosandboxBackend("proj", "bash", 1000, {
      loadSdk: async () => {
        throw new Error("native binding missing");
      },
    });
    expect(await kindOf(be.run("x", { timeoutMs: 1 }))).toBe("unreachable");
  });
});

describe("MicrosandboxBackend.run", () => {
  it("passes shell, -c script, timeout and null stdin", async () => {
    const { be, sb } = setup();
    await be.run("echo hi", { timeoutMs: 5000 });
    expect(sb.execs[0]).toEqual({ cmd: "bash", args: ["-c", "echo hi"], timeout: 5000, stdinNull: true });
  });

  it("interleaves streams in arrival order and returns the exit code", async () => {
    const { be, sb } = setup();
    sb.script.events = [
      { kind: "started", pid: 7 },
      { kind: "stdout", data: enc("a\n") },
      { kind: "stderr", data: enc("b\n") },
      { kind: "stdout", data: enc("c\n") },
      { kind: "exited", code: 3 },
    ];
    expect(await be.run("x", { timeoutMs: 1000 })).toEqual({
      output: "a\nb\nc\n",
      exitCode: 3,
      timedOut: false,
      droppedChars: 0,
    });
  });

  it("decodes a multibyte char split across stdout chunks with stderr in between", async () => {
    const { be, sb } = setup();
    // "é" = c3 a9 on stdout, "€" = e2 82 ac on stderr, both split, interleaved.
    sb.script.events = [
      { kind: "stdout", data: bytes(0x41, 0xc3) },
      { kind: "stderr", data: bytes(0x42, 0xe2, 0x82) },
      { kind: "stdout", data: bytes(0xa9, 0x43) },
      { kind: "stderr", data: bytes(0xac) },
      { kind: "exited", code: 0 },
    ];
    const r = await be.run("x", { timeoutMs: 1000 });
    expect(r.output).toBe("ABéC€");
  });

  it("flushes an incomplete trailing sequence at end of stream", async () => {
    const { be, sb } = setup();
    sb.script.events = [{ kind: "stdout", data: bytes(0x61, 0xc3) }, { kind: "exited", code: 0 }];
    expect((await be.run("x", { timeoutMs: 1000 })).output).toBe("a�");
  });

  it("keeps a 2x head and 2x rolling tail and counts dropped chars", async () => {
    const { be, sb } = setup({ maxOutput: 5 });
    // 26 chars total; head 10, tail 10, 6 dropped from the middle.
    sb.script.events = [
      { kind: "stdout", data: enc("abcdefgh") },
      { kind: "stderr", data: enc("ijklmnop") },
      { kind: "stdout", data: enc("qrstuvwxyz") },
      { kind: "exited", code: 0 },
    ];
    const r = await be.run("x", { timeoutMs: 1000 });
    expect(r.output).toBe("abcdefghij" + "qrstuvwxyz");
    expect(r.droppedChars).toBe(6);
  });

  it("reports a timeout when the stream ends at or after the deadline", async () => {
    const { be, sb } = setup({ clock: [0, 2000] });
    sb.script.events = [{ kind: "stdout", data: enc("partial") }, { kind: "exited", code: 137 }];
    const r = await be.run("x", { timeoutMs: 1000 });
    expect(r).toEqual({ output: "partial", exitCode: null, timedOut: true, droppedChars: 0 });
  });

  it("treats an ExecTimeoutError during recv as a timeout and keeps output", async () => {
    const { be, sb } = setup();
    sb.script.events = [{ kind: "stdout", data: enc("so far") }, new SdkErr("execTimeout")];
    const r = await be.run("x", { timeoutMs: 1000 });
    expect(r).toMatchObject({ output: "so far", exitCode: null, timedOut: true });
  });

  it("maps an exec error before a handle to not_started", async () => {
    const { be, sb } = setup();
    sb.execError = new SdkErr("invalidConfig");
    expect(await kindOf(be.run("x", { timeoutMs: 1000 }))).toBe("not_started");
  });

  it("maps a connection-class exec error before a handle to unreachable and reconnects", async () => {
    const { be, sb, calls } = setup();
    sb.execError = new SdkErr("io");
    expect(await kindOf(be.run("x", { timeoutMs: 1000 }))).toBe("unreachable");
    sb.execError = undefined;
    await be.run("x", { timeoutMs: 1000 });
    expect(calls.connect).toBe(2);
  });

  it("maps an error after the handle exists to outcome_unknown and drops the connection", async () => {
    const { be, sb, calls } = setup();
    sb.script.events = [{ kind: "stdout", data: enc("x") }, new SdkErr("protocol")];
    expect(await kindOf(be.run("x", { timeoutMs: 1000 }))).toBe("outcome_unknown");
    sb.script.events = [{ kind: "exited", code: 0 }];
    await be.run("x", { timeoutMs: 1000 });
    expect(calls.connect).toBe(2);
  });

  it("maps a stream that ends without an exit event to outcome_unknown", async () => {
    const { be, sb } = setup();
    sb.script.events = [{ kind: "stdout", data: enc("x") }];
    expect(await kindOf(be.run("x", { timeoutMs: 1000 }))).toBe("outcome_unknown");
  });

  it("kills the exec when the signal aborts", async () => {
    const { be, sb } = setup();
    const ac = new AbortController();
    sb.script.events = [{ kind: "stdout", data: enc("x") }, { kind: "exited", code: 137 }];
    sb.onRecv = () => ac.abort();
    const r = await be.run("x", { timeoutMs: 1000, signal: ac.signal });
    expect(sb.killedExec).toBeGreaterThanOrEqual(1);
    expect(r.output).toBe("x");
  });
});

describe("MicrosandboxBackend.run backstop", () => {
  it("gives up and kills when the stream outlives the deadline plus grace", async () => {
    const { be, sb } = setup({ graceMs: 20 });
    sb.script.events = [{ kind: "stdout", data: enc("stuck") }, "hang"];
    const r = await be.run("x", { timeoutMs: 10 });
    expect(r).toEqual({ output: "stuck", exitCode: null, timedOut: true, droppedChars: 0 });
    expect(sb.killedExec).toBeGreaterThanOrEqual(1);
  });

  it("gives up after grace when an aborted run never ends", async () => {
    const { be, sb } = setup({ graceMs: 20 });
    const ac = new AbortController();
    ac.abort();
    sb.script.events = ["hang"];
    const r = await be.run("x", { timeoutMs: 60_000, signal: ac.signal });
    expect(r).toMatchObject({ exitCode: null, timedOut: false });
    expect(sb.killedExec).toBeGreaterThanOrEqual(1);
  });
});

describe("MicrosandboxBackend jobs", () => {
  it("starts a detached job with shell -c and null stdin", async () => {
    const { be, sb } = setup();
    expect(await be.startJob("sleep 5")).toEqual({ id: "job_1" });
    expect(sb.detached[0]).toEqual({ cmd: "bash", args: ["-c", "sleep 5"], stdinNull: true });
  });

  it("maps launch_unconfirmed to outcome_unknown and other start errors to not_started", async () => {
    const { be, sb } = setup();
    sb.execError = new SdkErr("launch_unconfirmed");
    expect(await kindOf(be.startJob("x"))).toBe("outcome_unknown");
    sb.execError = new SdkErr("resource_limit");
    expect(await kindOf(be.startJob("x"))).toBe("not_started");
  });

  it("reads logs from the cursor, decodes per source and returns the last cursor", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    const job = sb.jobs.get(id)!;
    job.logPages = [
      [
        { source: "stdout", data: Buffer.from([0x61, 0xc3]), cursor: `${id}:1` },
        { source: "stderr", data: Buffer.from([0x62, 0xe2, 0x82]), cursor: `${id}:2` },
        { source: "stdout", data: Buffer.from([0xa9]), cursor: `${id}:3` },
      ],
      [{ source: "stderr", data: Buffer.from([0xac, 0x0a]), cursor: `${id}:4` }],
    ];
    expect(await be.readJob(id)).toEqual({ text: "abé", cursor: `${id}:3`, gap: false });
    expect(await be.readJob(id, `${id}:3`)).toEqual({ text: "€\n", cursor: `${id}:4`, gap: false });
    expect(job.logsCalls).toEqual([{}, { fromCursor: `${id}:3` }]);
  });

  it("returns the cursor when entries were consumed even if no text decoded yet", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    sb.jobs.get(id)!.logPages = [[{ source: "stdout", data: Buffer.from([0xc3]), cursor: `${id}:1` }]];
    expect(await be.readJob(id)).toEqual({ text: "", cursor: `${id}:1`, gap: false });
  });

  it("flushes pending bytes once the job has finished and the log is drained", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    const job = sb.jobs.get(id)!;
    job.logPages = [[{ source: "stdout", data: Buffer.from([0x61, 0xc3]), cursor: `${id}:1` }], []];
    job.infos = [info({ state: "exited", exitCode: 0 })];
    expect(await be.readJob(id)).toEqual({ text: "a", cursor: `${id}:1`, gap: false });
    expect(await be.readJob(id, `${id}:1`)).toEqual({ text: "�", cursor: `${id}:1`, gap: false });
  });

  it("an empty read on a running job omits text and leaves the cursor unchanged", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    sb.jobs.get(id)!.logPages = [[]];
    const r = await be.readJob(id, `${id}:9`);
    expect(r.text).toBe("");
    expect(r.gap).toBe(false);
    expect(r.cursor === undefined || r.cursor === `${id}:9`).toBe(true);
  });

  it("reports a gap when the cursor has expired and rereads retained output", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    const job = sb.jobs.get(id)!;
    job.logPages = [new SdkErr("output_gap"), [{ source: "stdout", data: Buffer.from("late"), cursor: `${id}:50` }]];
    expect(await be.readJob(id, `${id}:3`)).toEqual({ text: "late", cursor: `${id}:50`, gap: true });
    expect(job.logsCalls).toEqual([{ fromCursor: `${id}:3` }, {}]);
  });

  it("maps SDK job states", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    const job = sb.jobs.get(id)!;
    const cases: [SdkJobInfo, unknown][] = [
      [info({ state: "starting" }), { state: "running" }],
      [info({ state: "running" }), { state: "running" }],
      [info({ state: "exited", exitCode: 2 }), { state: "exited", exitCode: 2 }],
      [info({ state: "failed", error: "no such file" }), { state: "exited", error: "no such file" }],
      [info({ state: "failed", failure: { message: "spawn failed" } }), { state: "exited", error: "spawn failed" }],
      [info({ state: "lost" }), { state: "lost" }],
      [info({ state: "weird" }), { state: "unknown" }],
    ];
    for (const [i, want] of cases) {
      job.infos = [i];
      expect(await be.jobStatus(id)).toEqual(want);
    }
  });

  it("jobStatus of an expired job is unknown", async () => {
    const { be } = setup();
    expect(await be.jobStatus("job_gone")).toEqual({ state: "unknown" });
  });

  it("killJob confirms once inspect shows the job finished", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    const job = sb.jobs.get(id)!;
    job.infos = [info({ state: "running" }), info({ state: "exited", exitCode: 137 })];
    expect(await be.killJob(id, 1000)).toEqual({ confirmed: true, status: { state: "exited", exitCode: 137 } });
    expect(job.killed).toBe(1);
  });

  it("killJob is unconfirmed when the job is still running after waitMs", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    sb.jobs.get(id)!.infos = [info({ state: "running" })];
    expect(await be.killJob(id, 50)).toEqual({ confirmed: false, status: { state: "running" } });
  });

  it("killJob on an already-finished job returns the real status", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    const job = sb.jobs.get(id)!;
    job.killError = new SdkErr("job_not_running");
    job.infos = [info({ state: "exited", exitCode: 0 })];
    expect(await be.killJob(id, 1000)).toEqual({ confirmed: true, status: { state: "exited", exitCode: 0 } });
  });

  it("maps connection-class job errors to unreachable", async () => {
    const { be, sb } = setup();
    const { id } = await be.startJob("x");
    sb.jobs.get(id)!.logPages = [new SdkErr("sandbox_error")];
    expect(await kindOf(be.readJob(id))).toBe("unreachable");
  });
});
