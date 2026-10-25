import { type Backend, BackendError } from "./backend/types.js";
import type { Config } from "./config.js";
import { JobRegistry, shortenCommand } from "./jobs.js";
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

  protected errorResult(e: unknown): ToolResult {
    const name = this.cfg.sandbox;
    const err = e instanceof BackendError ? e : new BackendError("outcome_unknown", e instanceof Error ? e.message : String(e));
    let text: string;
    switch (err.kind) {
      case "not_found":
        text = `Command was not started: sandbox "${name}" not found. Create it with msb create … --name ${name}.`;
        break;
      case "not_running":
        text = `Command was not started: sandbox "${name}" is not running. Start it with: msb start ${name}`;
        break;
      case "unreachable":
      case "not_started":
        text = `Command was not started: ${err.message}`;
        break;
      default:
        text = `Command may have started but its outcome is unknown: ${err.message}. Check the sandbox state; do not retry side-effecting commands blindly.`;
    }
    return { text, isError: true };
  }
}
