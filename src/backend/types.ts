// droppedChars: characters the backend discarded from the middle to cap memory.
// The service passes it to truncateMiddle so the omitted count is exact.
export interface RunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  droppedChars: number;
  /** timedOut only: the kill was sent but the process exit was never confirmed. */
  exitUnconfirmed?: boolean;
}

export type JobState = "running" | "exited" | "lost" | "unknown";

// error: set when the job failed to launch (SDK state "failed")
export interface JobStatus {
  state: JobState;
  exitCode?: number;
  error?: string;
}

export interface Backend {
  run(script: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<RunResult>;
  startJob(script: string): Promise<{ id: string }>;
  readJob(id: string, cursor?: string): Promise<{ text: string; cursor?: string; gap: boolean }>;
  jobStatus(id: string): Promise<JobStatus>;
  killJob(id: string, waitMs: number): Promise<{ confirmed: boolean; status: JobStatus }>;
}

export type BackendErrorKind =
  | "not_found"
  | "not_running"
  | "unreachable"
  | "not_started"
  | "outcome_unknown"
  | "preparing"
  | "config_mismatch";

export class BackendError extends Error {
  readonly kind: BackendErrorKind;
  constructor(kind: BackendErrorKind, message: string) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
  }
}
