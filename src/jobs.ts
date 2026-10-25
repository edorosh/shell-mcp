export interface JobRecord {
  id: string;
  command: string;
  startedAt: Date;
  cursor?: string;
  pending: string;
  killedByUs: boolean;
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(id: string, command: string): JobRecord {
    const rec: JobRecord = { id, command, startedAt: this.now(), pending: "", killedByUs: false };
    this.jobs.set(id, rec);
    return rec;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()];
  }
}

/** First line of a command, with "…" when anything was cut. */
export function shortenCommand(cmd: string, max = 80): string {
  const nl = cmd.indexOf("\n");
  const first = nl === -1 ? cmd : cmd.slice(0, nl);
  if (nl === -1 && first.length <= max) return first;
  if (first.length <= max) return first + "…";
  return first.slice(0, max) + "…";
}
