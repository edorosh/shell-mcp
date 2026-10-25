/*
 * Backend over the microsandbox SDK (microsandbox@0.7.11, pinned exactly).
 *
 * Behavior below was derived from the SDK source, not from a live run (no Task 1 spike yet).
 * Assumptions to verify in the Task 1 spike:
 *  - A timed-out execStream is SIGKILLed by the SDK and ends with a raw "exited" event, not an
 *    ExecTimeoutError (only wait()/collect() raise that). We detect the timeout with our own clock.
 *  - No stdout/stderr events arrive after "exited"; we stop reading there.
 *  - A spawn failure ("failed" event) normalizes to an unknown event and the stream ends without
 *    "exited"; we report that as outcome_unknown.
 *  - Sandbox.get() rejects with code "sandboxNotFound"; SandboxHandle.status is "running" when usable.
 *  - Job codes: "job_not_found", "job_not_running" (kill after exit), "launch_unconfirmed",
 *    "output_gap" (logs({fromCursor}) after the cursor's records expired), "sandbox_not_running".
 *  - logs({fromCursor}) returns entries strictly after the cursor, sources "stdout"/"stderr".
 *  - Timeout and kill take the whole process group with them (agentd setsid + kill(-pid)).
 */
import { Utf8Accumulator } from "../output.js";
import { type Backend, BackendError, type JobStatus, type RunResult } from "./types.js";

// The slice of the SDK this backend uses; the real module satisfies it structurally.
export interface SdkExecBuilder {
  args(args: string[]): SdkExecBuilder;
  timeout(ms: number): SdkExecBuilder;
  stdinNull(): SdkExecBuilder;
}
export type SdkExecEvent =
  | { kind: "started"; pid: number }
  | { kind: "stdout" | "stderr"; data: Uint8Array }
  | { kind: "exited"; code: number };
export interface SdkExecHandle {
  recv(): Promise<SdkExecEvent | null>;
  kill(): Promise<void>;
}
export interface SdkJobInfo {
  state: string;
  exitCode: number | null;
  error: string | null;
  failure: { message: string } | null;
}
export interface SdkLogEntry {
  source: string;
  data: Uint8Array;
  cursor: string;
}
export interface SdkJob {
  id: string;
  inspect(): Promise<SdkJobInfo>;
  kill(): Promise<void>;
  logs(options?: { fromCursor?: string }): Promise<SdkLogEntry[]>;
}
export interface SdkSandbox {
  execStreamWith(cmd: string, configure: (b: SdkExecBuilder) => SdkExecBuilder): Promise<SdkExecHandle>;
  execDetachedWith(cmd: string, configure: (b: SdkExecBuilder) => SdkExecBuilder): Promise<SdkJob>;
  getJob(id: string): Promise<SdkJob>;
}
export interface SdkModule {
  Sandbox: { get(name: string): Promise<{ status: string; connectWithTimeout(ms: number): Promise<SdkSandbox> }> };
}

export interface MicrosandboxDeps {
  loadSdk?: () => Promise<SdkModule>;
  now?: () => number;
  /** How long past the deadline (or an abort) to wait for the stream to end before giving up. */
  graceMs?: number;
}

const codeOf = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
};
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const NOT_FOUND = new Set(["sandboxNotFound"]);
const NOT_RUNNING = new Set(["sandboxNotRunning", "sandbox_not_running"]);
const CONNECTION = new Set(["io", "http", "cloudHttp", "protocol", "runtime", "sandbox_error"]);

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Head of headMax chars plus a rolling tail of tailMax chars; counts chars dropped between them. */
class CappedText {
  private head = "";
  private tail = "";
  private headDone = false;
  dropped = 0;
  constructor(private readonly headMax: number, private readonly tailMax: number) {}

  append(s: string): void {
    if (s === "") return;
    if (!this.headDone) {
      let take = Math.min(this.headMax - this.head.length, s.length);
      if (take < s.length) {
        if (take > 0 && isHigh(s.charCodeAt(take - 1))) take--;
        this.headDone = true;
      }
      this.head += s.slice(0, take);
      s = s.slice(take);
      if (s === "") return;
    }
    this.tail += s;
    if (this.tail.length > this.tailMax) {
      let cut = this.tail.length - this.tailMax;
      if (isLow(this.tail.charCodeAt(cut))) cut++;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  text(): string {
    return this.head + this.tail;
  }
}

function mapState(info: SdkJobInfo): JobStatus {
  switch (info.state) {
    case "starting":
    case "running":
      return { state: "running" };
    case "exited":
      return info.exitCode === null ? { state: "exited" } : { state: "exited", exitCode: info.exitCode };
    case "failed":
      return { state: "exited", error: info.failure?.message ?? info.error ?? "command did not start" };
    case "lost":
      return { state: "lost" };
    default:
      return { state: "unknown" };
  }
}

type Stop = { stop: "deadline" | "abort" };

export class MicrosandboxBackend implements Backend {
  private conn?: Promise<SdkSandbox>;
  private readonly jobDecoders = new Map<string, Map<string, Utf8Accumulator>>();
  private readonly loadSdk: () => Promise<SdkModule>;
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(
    private readonly sandboxName: string,
    private readonly shell: string,
    private readonly maxOutput: number,
    deps: MicrosandboxDeps = {},
  ) {
    // Lazy: loading the native module is deferred until the first tool call.
    this.loadSdk = deps.loadSdk ?? (() => import("microsandbox"));
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? 10_000;
  }

  async run(script: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
    const { timeoutMs, signal } = opts;
    const sb = await this.connect();
    const start = this.now();
    let handle: SdkExecHandle;
    try {
      handle = await sb.execStreamWith(this.shell, (b) => b.args(["-c", script]).timeout(timeoutMs).stdinNull());
    } catch (e) {
      throw this.fail(e, "before");
    }

    const out = new CappedText(2 * this.maxOutput, 2 * this.maxOutput);
    const acc = { stdout: new Utf8Accumulator(), stderr: new Utf8Accumulator() };
    let exitCode: number | null = null;
    let exited = false;
    let timedOut = false;
    let stopped: Stop["stop"] | undefined;

    const kill = () => void handle.kill().catch(() => {});
    let giveUp!: (s: Stop) => void;
    const stop = new Promise<Stop>((r) => (giveUp = r));
    const timers = [setTimeout(() => giveUp({ stop: "deadline" }), timeoutMs + this.graceMs)];
    const onAbort = () => {
      kill();
      timers.push(setTimeout(() => giveUp({ stop: "abort" }), this.graceMs));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (;;) {
        const ev = await Promise.race([handle.recv(), stop]);
        if (ev === null) break;
        if ("stop" in ev) {
          stopped = ev.stop;
          kill();
          break;
        }
        if (ev.kind === "stdout" || ev.kind === "stderr") {
          acc[ev.kind].push(ev.data);
          out.append(acc[ev.kind].drain());
        } else if (ev.kind === "exited") {
          exitCode = ev.code;
          exited = true;
          break;
        }
      }
    } catch (e) {
      if (codeOf(e) === "execTimeout") timedOut = true;
      else throw this.fail(e, "after");
    } finally {
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }

    out.append(acc.stdout.finish());
    out.append(acc.stderr.finish());
    if (stopped === "deadline" || this.now() - start >= timeoutMs) timedOut = true;
    if (!exited && !timedOut && !signal?.aborted) {
      throw new BackendError("outcome_unknown", "the command's output stream ended without an exit status");
    }
    return { output: out.text(), exitCode: timedOut ? null : exitCode, timedOut, droppedChars: out.dropped };
  }

  async startJob(script: string): Promise<{ id: string }> {
    const sb = await this.connect();
    try {
      const job = await sb.execDetachedWith(this.shell, (b) => b.args(["-c", script]).stdinNull());
      return { id: job.id };
    } catch (e) {
      if (codeOf(e) === "launch_unconfirmed") {
        const jobId = (e as { jobId?: string }).jobId;
        throw new BackendError("outcome_unknown", jobId ? `${msgOf(e)} (job ${jobId})` : msgOf(e));
      }
      throw this.fail(e, "before");
    }
  }

  async readJob(id: string, cursor?: string): Promise<{ text: string; cursor?: string; gap: boolean }> {
    const sb = await this.connect();
    try {
      const job = await sb.getJob(id);
      let gap = false;
      let text = "";
      let entries: SdkLogEntry[];
      try {
        entries = await job.logs(cursor ? { fromCursor: cursor } : {});
      } catch (e) {
        if (codeOf(e) !== "output_gap") throw e;
        // Records after our cursor expired; restart from what the sandbox still retains.
        gap = true;
        text += this.flushJob(id);
        entries = await job.logs({});
      }

      let last: string | undefined;
      if (entries.length > 0) {
        let decs = this.jobDecoders.get(id);
        if (!decs) this.jobDecoders.set(id, (decs = new Map()));
        for (const entry of entries) {
          let acc = decs.get(entry.source);
          if (!acc) decs.set(entry.source, (acc = new Utf8Accumulator()));
          acc.push(entry.data);
          text += acc.drain();
          last = entry.cursor;
        }
      } else if (this.jobDecoders.has(id) && mapState(await job.inspect()).state !== "running") {
        // Log drained and the job is done: flush any trailing partial character.
        text += this.flushJob(id);
      }

      const next = last ?? (text !== "" ? cursor : undefined);
      return next === undefined ? { text, gap } : { text, cursor: next, gap };
    } catch (e) {
      if (codeOf(e) === "job_not_found") return { text: "", gap: false };
      throw this.fail(e, "query");
    }
  }

  async jobStatus(id: string): Promise<JobStatus> {
    const sb = await this.connect();
    try {
      return mapState(await (await sb.getJob(id)).inspect());
    } catch (e) {
      if (codeOf(e) === "job_not_found") return { state: "unknown" };
      throw this.fail(e, "query");
    }
  }

  async killJob(id: string, waitMs: number): Promise<{ confirmed: boolean; status: JobStatus }> {
    const sb = await this.connect();
    try {
      const job = await sb.getJob(id);
      try {
        await job.kill();
      } catch (e) {
        if (codeOf(e) !== "job_not_running") throw e;
        // The job finished before the kill landed: report its real status.
        return { confirmed: true, status: mapState(await job.inspect()) };
      }
      const deadline = this.now() + waitMs;
      for (;;) {
        const status = mapState(await job.inspect());
        if (status.state === "exited") return { confirmed: true, status };
        const left = deadline - this.now();
        if (left <= 0) return { confirmed: false, status };
        await new Promise((r) => setTimeout(r, Math.min(100, left)));
      }
    } catch (e) {
      throw this.fail(e, "query");
    }
  }

  private flushJob(id: string): string {
    const decs = this.jobDecoders.get(id);
    this.jobDecoders.delete(id);
    let s = "";
    for (const acc of decs?.values() ?? []) s += acc.finish();
    return s;
  }

  private connect(): Promise<SdkSandbox> {
    if (!this.conn) {
      const p = this.open();
      this.conn = p;
      p.catch(() => {
        if (this.conn === p) this.conn = undefined;
      });
    }
    return this.conn;
  }

  private async open(): Promise<SdkSandbox> {
    let sdk: SdkModule;
    try {
      sdk = await this.loadSdk();
    } catch (e) {
      throw new BackendError("unreachable", `microsandbox SDK failed to load: ${msgOf(e)}`);
    }
    let handle;
    try {
      handle = await sdk.Sandbox.get(this.sandboxName);
    } catch (e) {
      throw this.fail(e, "before");
    }
    if (handle.status !== "running") {
      throw new BackendError("not_running", `sandbox "${this.sandboxName}" is ${handle.status}`);
    }
    try {
      return await handle.connectWithTimeout(10_000);
    } catch (e) {
      throw this.fail(e, "before");
    }
  }

  /**
   * Normalize an SDK error. before: no process exists yet (fallback not_started);
   * after: a process may exist (always outcome_unknown); query: job reads/kills.
   * Connection-class errors drop the cached connection so the next call reconnects.
   */
  private fail(e: unknown, phase: "before" | "after" | "query"): BackendError {
    if (e instanceof BackendError) return e;
    const code = codeOf(e);
    const msg = msgOf(e);
    const notFound = code !== undefined && NOT_FOUND.has(code);
    const notRunning = code !== undefined && NOT_RUNNING.has(code);
    const connection = code === undefined || CONNECTION.has(code) || notFound || notRunning;
    if (connection) this.conn = undefined;
    if (phase === "after") return new BackendError("outcome_unknown", msg);
    if (notFound) return new BackendError("not_found", msg);
    if (notRunning) return new BackendError("not_running", msg);
    if (connection) return new BackendError("unreachable", msg);
    return new BackendError(phase === "before" ? "not_started" : "outcome_unknown", msg);
  }
}
