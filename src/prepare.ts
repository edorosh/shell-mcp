import type { Provisioner } from "./backend/provision.js";

/**
 * `--prepare` (design section 5): provisions in the foreground, writing each stage as it comes.
 * Returns the exit code: 0 once the sandbox runs, 1 on a mismatch without --recreate or any failure.
 */
export async function runPrepare(
  p: Pick<Provisioner, "ensure">,
  write: (line: string) => void,
  sandbox: string,
): Promise<0 | 1> {
  try {
    await p.ensure(write);
    write(`ready: sandbox "${sandbox}" is running`);
    return 0;
  } catch (e) {
    write(`FAIL ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
