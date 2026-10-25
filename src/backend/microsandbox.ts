/*
 * Backend over the microsandbox SDK (microsandbox@0.7.11, pinned exactly).
 *
 * Behavior below was derived from the SDK source, not from a live run (no Task 1 spike yet).
 * Assumptions to verify in the Task 1 spike:
 *  - A timed-out execStream is SIGKILLed by the SDK and ends with a raw "exited" event whose code is
 *    -1 (agentd exit_code() for a non-normal exit), not an ExecTimeoutError (only wait()/collect()).
 *    We do not rely on that alone: half a second past the deadline we kill the exec ourselves,
 *    wait a short grace for "exited", and report a timeout with the captured output either way.
 *  - No stdout/stderr events arrive after "exited"; we stop reading there.
 *  - A spawn failure (native "failed" event) normalizes to undefined and the stream ends without
 *    "exited"; we report not_started if nothing showed the process started (no "started" or
 *    output), else outcome_unknown. stdin_error (also undefined) is non-terminal.
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
  /** undefined: an event kind the SDK did not normalize (native "failed"/"stdin_error"). */
  recv(): Promise<SdkExecEvent | null | undefined>;
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
  /** After our own kill (deadline or abort), how long to wait for "exited" before giving up. */
  graceMs?: number;
  /** How long past the deadline to wait for the SDK's own timeout before killing ourselves. */
  killDelayMs?: number;
}

const codeOf = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
};
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const NOT_FOUND = new Set(["sandboxNotFound"]);
const NOT_RUNNING = new Set(["sandboxNotRunning", "sandbox_not_running"]);
const CONNECTION = new Set(["io", "http", "cloudHttp", "protocol", "runtime", "sandbox_error", "sandboxReplaced"]);

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

type Stop = "deadline" | "abort";

export class MicrosandboxBackend implements Backend {
  private conn?: Promise<SdkSandbox>;
  private sdk?: SdkModule;
  private readonly jobDecoders = new Map<string, Map<string, Utf8Accumulator>>();
  private readonly loadSdk: () => Promise<SdkModule>;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly killDelayMs: number;

  constructor(
    private readonly sandboxName: string,
    private readonly shell: string,
    private readonly maxOutput: number,
    deps: MicrosandboxDeps = {},
  ) {
    // Lazy: loading the native module is deferred until the first tool call.
    this.loadSdk = deps.loadSdk ?? (() => import("microsandbox"));
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? 2_500;
    this.killDelayMs = deps.killDelayMs ?? 500;
  }

  async run(script: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
    const { timeoutMs, signal } = opts;
    const cancelled = () => new BackendError("not_started", "cancelled before start");
    if (signal?.aborted) throw cancelled();
    const { sb, cached } = await this.connectTracked();
    if (signal?.aborted) throw cancelled();
    const start = this.now();
    let handle: SdkExecHandle;
    try {
      handle = await sb.execStreamWith(this.shell, (b) => b.args(["-c", script]).timeout(timeoutMs).stdinNull());
    } catch (e) {
      throw await this.failChecked(e, "before", cached);
    }

    const out = new CappedText(2 * this.maxOutput, 2 * this.maxOutput);
    const acc = { stdout: new Utf8Accumulator(), stderr: new Utf8Accumulator() };
    let exitCode: number | null = null;
    let exited = false;
    let execTimeout = false;
    let unknownEvent = false;
    let sawActivity = false; // "started" or output: a process exists
    let weKilled = false; // our deadline kill fired

    // A stop request wakes the pending recv; each iteration's promise is fresh, so nothing accumulates.
    let stopped: Stop | undefined;
    let wake: ((s: Stop) => void) | undefined;
    const requestStop = (s: Stop) => {
      stopped ??= s;
      wake?.(s);
    };
    const kill = () => void handle.kill().catch(() => {});
    // Our own deadline: kill shortly after the SDK's timeout should have, then give it a grace.
    const timers = [
      setTimeout(() => {
        weKilled = true;
        kill();
        timers.push(setTimeout(() => requestStop("deadline"), this.graceMs));
      }, timeoutMs + this.killDelayMs),
    ];
    const onAbort = () => {
      kill();
      timers.push(setTimeout(() => requestStop("abort"), this.graceMs));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!stopped) {
        const ev = await new Promise<SdkExecEvent | null | undefined | Stop>((resolve, reject) => {
          wake = resolve;
          handle.recv().then(resolve, reject);
        });
        wake = undefined;
        if (ev === null) break;
        if (typeof ev === "string") break;
        if (ev?.kind === "started") {
          sawActivity = true;
        } else if (ev?.kind === "stdout" || ev?.kind === "stderr") {
          sawActivity = true;
          acc[ev.kind].push(ev.data);
          out.append(acc[ev.kind].drain());
        } else if (ev?.kind === "exited") {
          exitCode = ev.code;
          exited = true;
          break;
        } else {
          // The TS SDK normalizes native "failed"/"stdin_error" events to undefined (no payload
          // survives), so all we can record is that one occurred; keep reading.
          unknownEvent = true;
        }
      }
    } catch (e) {
      if (codeOf(e) === "execTimeout") execTimeout = true;
      else throw await this.failChecked(e, "after", cached);
    } finally {
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
    if (stopped) kill();

    out.append(acc.stdout.finish());
    out.append(acc.stderr.finish());
    const deadlinePassed = weKilled || this.now() - start >= timeoutMs;
    const result = (exit: number | null, timedOut: boolean): RunResult => ({
      output: out.text(), exitCode: exit, timedOut, droppedChars: out.dropped,
    });

    // execTimeout: the SDK confirmed the exit after its deadline kill.
    if (execTimeout) return result(null, true);
    if (exited) {
      // agentd reports -1 for a signal death; the SDK's deadline kill is SIGKILL. After our own
      // kill, any non-zero exit is the kill; an exit 0 means it finished on its own just in time.
      const killedByDeadline = deadlinePassed && (exitCode === -1 || (weKilled && exitCode !== 0));
      return killedByDeadline ? result(null, true) : result(exitCode, false);
    }
    // We killed at the deadline and no exit came within the grace: still a timeout (S5), with
    // the output captured so far, flagged so the agent knows the exit was not confirmed.
    if (stopped === "deadline") return { ...result(null, true), exitUnconfirmed: true };
    if (deadlinePassed) {
      throw new BackendError("outcome_unknown", `the ${timeoutMs} ms deadline passed but the process exit was not confirmed`);
    }
    if (signal?.aborted) return result(null, false);
    if (unknownEvent && !sawActivity) throw new BackendError("not_started", "the command failed to start");
    throw new BackendError("outcome_unknown", "the command's output stream ended without an exit status");
  }

  async startJob(script: string): Promise<{ id: string }> {
    const { sb, cached } = await this.connectTracked();
    try {
      const job = await sb.execDetachedWith(this.shell, (b) => b.args(["-c", script]).stdinNull());
      return { id: job.id };
    } catch (e) {
      if (codeOf(e) === "launch_unconfirmed") {
        const jobId = (e as { jobId?: string }).jobId;
        throw new BackendError("outcome_unknown", jobId ? `${msgOf(e)} (job ${jobId})` : msgOf(e));
      }
      throw await this.failChecked(e, "before", cached);
    }
  }

  async readJob(id: string, cursor?: string): Promise<{ text: string; cursor?: string; gap: boolean }> {
    const { sb, cached } = await this.connectTracked();
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
      throw await this.failChecked(e, "query", cached);
    }
  }

  async jobStatus(id: string): Promise<JobStatus> {
    const { sb, cached } = await this.connectTracked();
    try {
      return mapState(await (await sb.getJob(id)).inspect());
    } catch (e) {
      if (codeOf(e) === "job_not_found") return { state: "unknown" };
      throw await this.failChecked(e, "query", cached);
    }
  }

  async killJob(id: string, waitMs: number): Promise<{ confirmed: boolean; status: JobStatus }> {
    const { sb, cached } = await this.connectTracked();
    try {
      const job = await sb.getJob(id);
      try {
        await job.kill();
      } catch (e) {
        if (codeOf(e) !== "job_not_running") throw e;
        // The job finished before the kill landed: report its real status.
        const status = mapState(await job.inspect());
        return { confirmed: status.state !== "running", status };
      }
      const deadline = this.now() + waitMs;
      for (;;) {
        const status = mapState(await job.inspect());
        if (status.state !== "running") return { confirmed: true, status };
        const left = deadline - this.now();
        if (left <= 0) return { confirmed: false, status };
        await new Promise((r) => setTimeout(r, Math.min(100, left)));
      }
    } catch (e) {
      throw await this.failChecked(e, "query", cached);
    }
  }

  private flushJob(id: string): string {
    const decs = this.jobDecoders.get(id);
    this.jobDecoders.delete(id);
    let s = "";
    for (const acc of decs?.values() ?? []) s += acc.finish();
    return s;
  }

  /** cached: the connection existed before this call, so it may be stale. */
  private async connectTracked(): Promise<{ sb: SdkSandbox; cached: boolean }> {
    const cached = this.conn !== undefined;
    return { sb: await this.connect(), cached };
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
      sdk = this.sdk ?? (this.sdk = await this.loadSdk());
    } catch (e) {
      throw new BackendError("unreachable", `microsandbox SDK failed to load: ${msgOf(e)}`);
    }
    let handle;
    try {
      handle = await sdk.Sandbox.get(this.sandboxName);
    } catch (e) {
      throw this.cannotReach(e);
    }
    if (handle.status !== "running") {
      throw new BackendError("not_running", `sandbox "${this.sandboxName}" is ${handle.status}`);
    }
    try {
      return await handle.connectWithTimeout(10_000);
    } catch (e) {
      throw this.cannotReach(e);
    }
  }

  /**
   * Any failure while looking up or connecting to the sandbox means we could not reach it: the
   * SDK's error for a stopped sandbox ("[AgentClient] agent client error: connect \\.\pipe\msb-agent-…")
   * carries no code we can match, so only not_found and not_running keep their own kind and the rest
   * become `unreachable`, whose message names the sandbox and how to start it.
   */
  private cannotReach(e: unknown): BackendError {
    const be = this.fail(e, "before");
    return be.kind === "not_found" || be.kind === "not_running" ? be : new BackendError("unreachable", be.message);
  }

  /**
   * fail(), plus: a connection-class error on a cached connection may mean the sandbox was
   * stopped or removed since we connected. Re-check it so the agent gets the not_running /
   * not_found message (with the msb hint) instead of a bare "unreachable". A process may
   * already exist in the "after" phase, so that stays outcome_unknown with the hint appended.
   */
  private async failChecked(e: unknown, phase: "before" | "after" | "query", cached: boolean): Promise<BackendError> {
    const err = this.fail(e, phase);
    const code = codeOf(e);
    const connectionClass = !(e instanceof BackendError) && (code === undefined || CONNECTION.has(code));
    if (!cached || !connectionClass) return err;
    const probed = await this.probe();
    if (!probed) return err;
    if (phase === "after") {
      return new BackendError("outcome_unknown", `${err.message} (${probed.message}; start it with: msb start ${this.sandboxName})`);
    }
    return probed;
  }

  /** The sandbox's current state when it is not usable; undefined when running or unknown. */
  private async probe(): Promise<BackendError | undefined> {
    try {
      const sdk = this.sdk ?? (this.sdk = await this.loadSdk());
      const handle = await sdk.Sandbox.get(this.sandboxName);
      if (handle.status === "running") return undefined;
      return new BackendError("not_running", `sandbox "${this.sandboxName}" is ${handle.status}`);
    } catch (e) {
      const code = codeOf(e);
      if (code !== undefined && NOT_FOUND.has(code)) return new BackendError("not_found", msgOf(e));
      return undefined;
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
