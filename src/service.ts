import { type Backend, BackendError, type JobStatus } from "./backend/types.js";
import type { Config } from "./config.js";
import { type JobRecord, JobRegistry, shortenCommand } from "./jobs.js";
import { truncateMiddle } from "./output.js";
import { PathMapper } from "./paths.js";
import { extractCwd, newNonce, wrapBackground, wrapForeground } from "./wrap.js";

export interface ToolResult { text: string; isError: boolean }
export interface CallContext { signal?: AbortSignal; onProgress?: (elapsedSec: number) => void }

export class ShellService {
  readonly jobs: JobRegistry;
  protected readonly paths: PathMapper;
  protected readonly nonce: string;
  protected readonly progressIntervalMs: number;
  private guestCwd: string;

  constructor(
    protected readonly cfg: Config,
    protected readonly backend: Backend,
    deps: { nonce?: string; progressIntervalMs?: number; now?: () => Date } = {},
  ) {
    this.paths = new PathMapper(cfg.hostRoot, cfg.guestRoot, cfg.platform);
    this.nonce = deps.nonce ?? newNonce();
    this.progressIntervalMs = deps.progressIntervalMs ?? 15_000;
    this.jobs = new JobRegistry(deps.now);
    this.guestCwd = cfg.guestRoot;
  }

  get cwd(): string {
    return this.guestCwd;
  }

  async shell(
    args: { command: string; description?: string; timeout_ms?: number; run_in_background?: boolean },
    ctx: CallContext = {},
  ): Promise<ToolResult> {
    if (args.run_in_background) return this.startBackground(args.command);

    let timeoutMs = this.cfg.defaultTimeoutMs;
    if (args.timeout_ms !== undefined) {
      if (!Number.isInteger(args.timeout_ms) || args.timeout_ms <= 0) {
        return { text: "timeout_ms must be a positive integer (milliseconds)", isError: true };
      }
      timeoutMs = Math.min(args.timeout_ms, this.cfg.maxTimeoutMs);
    }

    const startCwd = this.guestCwd;
    const script = wrapForeground(args.command, startCwd, this.cfg.guestRoot, this.nonce);
    const started = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (ctx.onProgress) {
      const cb = ctx.onProgress;
      timer = setInterval(() => cb((Date.now() - started) / 1000), this.progressIntervalMs);
    }
    try {
      const res = await this.backend.run(script, { timeoutMs, signal: ctx.signal });
      const ex = extractCwd(res.output, this.nonce);
      if (ex.cwd !== null) this.guestCwd = ex.cwd;
      let body = ex.output;
      if (this.cfg.rewriteOutputPaths) body = this.paths.rewriteOutput(body);
      const t = truncateMiddle(body, this.cfg.maxOutput, res.droppedChars);
      const head = res.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s (process killed)`
        : `exit code: ${res.exitCode ?? "unknown"}`;
      let text = `${head}\ncwd: ${this.paths.displayCwd(this.guestCwd)}\n`;
      if (ex.reset) text += "note: previous directory no longer existed; ran in workspace root\n";
      if (res.timedOut && res.exitUnconfirmed) text += "note: kill sent, but the process exit was not confirmed\n";
      text += `---\n${t.text}`;
      return { text, isError: false };
    } catch (e) {
      return this.errorResult(e);
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  private async startBackground(command: string): Promise<ToolResult> {
    const script = wrapBackground(command, this.guestCwd, this.cfg.guestRoot);
    try {
      const { id } = await this.backend.startJob(script);
      this.jobs.add(id, shortenCommand(command));
      return {
        text: `started background job ${id}\nUse shell_output with this job id to read its output, shell_kill to stop it.`,
        isError: false,
      };
    } catch (e) {
      return this.errorResult(e);
    }
  }

  async output(args: { job_id: string }): Promise<ToolResult> {
    const rec = this.jobs.get(args.job_id);
    if (!rec) return this.unknownJob(args.job_id);
    // The cursor and the pending buffer are per-job state, so overlapping calls queue up:
    // two concurrent reads from the same cursor would replay output or move the cursor back.
    const run = rec.readLock.then(() => this.readOutput(rec));
    rec.readLock = run.catch(() => undefined);
    return run;
  }

  private async readOutput(rec: JobRecord): Promise<ToolResult> {
    try {
      // Status first, then the log: a job that exits between the two calls still has its last
      // output in this read, so an "exited" status never comes without the tail.
      const status = await this.backend.jobStatus(rec.id);
      let gap = false;
      // Read unless a full page is already pending. Then this page cannot empty pending, and
      // the "more output pending" note keeps the agent polling until the log is read again.
      if (rec.pending.length <= this.cfg.maxOutput) {
        const r = await this.backend.readJob(rec.id, rec.cursor);
        rec.cursor = r.cursor ?? rec.cursor; // an empty read may omit the cursor; never reset it
        gap = r.gap;
        rec.pending += this.cfg.rewriteOutputPaths ? this.paths.rewriteOutput(r.text) : r.text;
      }
      let cut = Math.min(rec.pending.length, this.cfg.maxOutput);
      if (cut < rec.pending.length && cut > 0) {
        const c = rec.pending.charCodeAt(cut - 1);
        if (c >= 0xd800 && c <= 0xdbff) cut = cut > 1 ? cut - 1 : 2; // do not split a pair; always make progress
      }
      const chunk = rec.pending.slice(0, cut);
      rec.pending = rec.pending.slice(cut);
      let text = `status: ${this.statusText(rec, status)}\n`;
      if (gap) text += "[some output was discarded by the sandbox]\n";
      text += `---\n${chunk}`;
      if (rec.pending !== "") text += "\n[more output pending; call shell_output again]";
      return { text, isError: false };
    } catch (e) {
      return this.errorResult(e, "shell_output");
    }
  }

  async kill(args: { job_id: string }): Promise<ToolResult> {
    const rec = this.jobs.get(args.job_id);
    if (!rec) return this.unknownJob(args.job_id);
    try {
      const before = await this.backend.jobStatus(rec.id);
      if (before.state === "exited" || before.state === "lost") {
        return { text: `job ${rec.id} already finished: ${this.statusText(rec, before)}`, isError: false };
      }
      const res = await this.backend.killJob(rec.id, 3000);
      const st = res.status;
      // Heuristic: exit code 0 or a launch error means the job ended on its own. Ambiguous: a job
      // that traps SIGTERM and exits 0 is reported as exited, not killed; a natural non-zero exit
      // inside the window is labelled killed.
      if (res.confirmed && st.state === "exited" && (st.exitCode === 0 || st.error !== undefined)) {
        // The job finished on its own between the status check and the kill.
        return { text: `job ${rec.id} had already finished: ${this.statusText(rec, st)}`, isError: false };
      }
      rec.killedByUs = true;
      return {
        text: res.confirmed
          ? `job ${rec.id} killed (exit confirmed)`
          : `job ${rec.id}: kill requested; exit not yet confirmed`,
        isError: false,
      };
    } catch (e) {
      return this.errorResult(e, "shell_kill");
    }
  }

  async list(): Promise<ToolResult> {
    const all = this.jobs.list();
    if (all.length === 0) return { text: "No background jobs started in this session.", isError: false };
    try {
      const lines: string[] = [];
      for (const rec of all) {
        const st = await this.backend.jobStatus(rec.id);
        lines.push(`${rec.id}  ${this.statusText(rec, st)}  ${rec.startedAt.toISOString()}  ${rec.command}`);
      }
      return { text: lines.join("\n"), isError: false };
    } catch (e) {
      return this.errorResult(e, "shell_list");
    }
  }

  private unknownJob(id: string): ToolResult {
    return { text: `unknown job: ${id} (only jobs started by this server can be used)`, isError: true };
  }

  private statusText(rec: JobRecord, st: JobStatus): string {
    switch (st.state) {
      case "running":
        return "running";
      case "lost":
        return "lost";
      case "unknown":
        return "unknown";
      default:
        if (st.error !== undefined) return `exited (failed to start: ${st.error})`;
        if (rec.killedByUs) return "killed";
        return `exited (exit code ${st.exitCode ?? "unknown"})`;
    }
  }

  /**
   * The shell tool must say whether the command was started (E3). The job tools never start
   * a command, so they get their own wording.
   */
  protected errorResult(e: unknown, tool: "shell" | "shell_output" | "shell_kill" | "shell_list" = "shell"): ToolResult {
    const name = this.cfg.sandbox;
    const err = e instanceof BackendError ? e : new BackendError("outcome_unknown", e instanceof Error ? e.message : String(e));
    const startHint = `If it is stopped, start it with: msb start ${name}`;
    const sandboxState: Partial<Record<BackendError["kind"], string>> = {
      not_found: `sandbox "${name}" not found. Create it with msb create … --name ${name}.`,
      not_running: `sandbox "${name}" is not running. Start it with: msb start ${name}`,
      unreachable: `sandbox "${name}" is unreachable: ${err.message}. ${startHint}`,
    };
    let text: string;
    if (tool === "shell") {
      if (sandboxState[err.kind]) text = `Command was not started: ${sandboxState[err.kind]}`;
      else if (err.kind === "not_started") text = `Command was not started: ${err.message}`;
      else text = `Command may have started but its outcome is unknown: ${err.message}. Check the sandbox state; do not retry side-effecting commands blindly.`;
    } else {
      const what = { shell_output: "Could not read job output", shell_kill: "Job was not killed", shell_list: "Could not list jobs" }[tool];
      if (sandboxState[err.kind]) text = `${what}: ${sandboxState[err.kind]}`;
      else if (tool === "shell_kill") {
        text = `Kill request outcome is unknown: ${err.message}. Check the job with shell_output or shell_list before retrying.`;
      } else text = `${what}: ${err.message}. Check the sandbox state and try again.`;
    }
    return { text, isError: true };
  }
}
