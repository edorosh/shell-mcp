import { type Backend, BackendError, type JobStatus, type RunResult } from "../src/backend/types.js";

export interface RunCall { script: string; timeoutMs: number; signal?: AbortSignal }

/** Scripted Backend: tests queue RunResults (or errors) and inspect recorded calls. */
export class FakeBackend implements Backend {
  runs: RunCall[] = [];
  started: string[] = [];
  delayMs = 0;
  private queue: Array<RunResult | BackendError | Error | ((c: RunCall) => RunResult | Promise<RunResult>)> = [];
  nextJobId = "job1";
  jobStatuses = new Map<string, JobStatus>();
  startError?: Error;

  queueRun(r: RunResult | Error | ((c: RunCall) => RunResult | Promise<RunResult>)): this {
    this.queue.push(r);
    return this;
  }

  async run(script: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
    const call: RunCall = { script, timeoutMs: opts.timeoutMs, signal: opts.signal };
    this.runs.push(call);
    const next = this.queue.shift();
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new BackendError("outcome_unknown", "aborted"));
        }, { once: true });
      });
    }
    if (next === undefined) return { output: "", exitCode: 0, timedOut: false, droppedChars: 0 };
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(call);
    return next;
  }

  async startJob(script: string): Promise<{ id: string }> {
    if (this.startError) throw this.startError;
    this.started.push(script);
    return { id: this.nextJobId };
  }
  async readJob(): Promise<{ text: string; cursor?: string; gap: boolean }> {
    return { text: "", gap: false };
  }
  async jobStatus(id: string): Promise<JobStatus> {
    return this.jobStatuses.get(id) ?? { state: "running" };
  }
  async killJob(id: string): Promise<{ confirmed: boolean; status: JobStatus }> {
    return { confirmed: true, status: { state: "exited", exitCode: 137 } };
  }
}
