import { type Backend, BackendError } from "./backend/types.js";
import type { Config } from "./config.js";
import type { RuntimeCheck } from "./runtime.js";
import { backendErrorText } from "./service.js";
import { shQuote } from "./wrap.js";

export interface CheckDeps {
  loadSdk(): Promise<unknown>;
  backend: Backend;
  runtime(): Promise<RuntimeCheck>;
  readdir(p: string): Promise<string[]>;
}

const CHECK_TIMEOUT_MS = 30_000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function diff(a: string[], b: string[], fold: (s: string) => string): string[] {
  const other = new Set(b.map(fold));
  return a.filter((n) => !other.has(fold(n)));
}

const names = (xs: string[]) => {
  const shown = xs.slice(0, 5).join(", ");
  return xs.length > 5 ? `${shown} (+${xs.length - 5} more)` : shown;
};

/**
 * Read-only diagnostics, one line per step (design section 4). Config is validated by parseCli
 * before this runs. Only `uname -s` and `ls -A1` reach the sandbox; nothing is written anywhere.
 */
export async function runCheck(config: Config, deps: CheckDeps, write: (line: string) => void): Promise<0 | 1> {
  let failed = false;
  const ok = (step: string, detail: string) => write(`ok      ${step}: ${detail}`);
  const fail = (step: string, detail: string) => {
    failed = true;
    write(`FAIL    ${step}: ${detail}`);
  };
  const skipped = (step: string, why: string) => write(`skipped ${step}: ${why}`);

  ok("config", `sandbox "${config.sandbox}", host root ${config.hostRoot}, guest root ${config.guestRoot}`);

  // 2. native module
  try {
    await deps.loadSdk();
    ok("native module", "microsandbox loaded");
  } catch (e) {
    fail("native module", `${msg(e)}; reinstall shell-mcp without --omit=optional, on the same OS and CPU`);
    for (const s of ["runtime", "sandbox", "shell", "mount"]) skipped(s, "native module failed");
    return 1;
  }

  // 3. runtime; a mismatch does not stop later steps
  try {
    const r = await deps.runtime();
    if (r.ok) ok("runtime", `msb ${r.version} from ${r.origin} (${r.msbPath})${r.note ? `; ${r.note}` : ""}`);
    else fail("runtime", r.message);
  } catch (e) {
    fail("runtime", msg(e));
  }

  // 4 and 5: one `uname -s` run
  let uname: Awaited<ReturnType<Backend["run"]>> | undefined;
  try {
    uname = await deps.backend.run("uname -s", { timeoutMs: CHECK_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof BackendError && e.kind === "not_started") {
      ok("sandbox", `"${config.sandbox}" is running`);
      fail("shell", `${e.message}; is ${config.shell} installed in the image? or set --shell`);
      skipped("mount", "shell failed");
      return 1;
    }
    const err = e instanceof BackendError ? e : new BackendError("outcome_unknown", msg(e));
    fail("sandbox", backendErrorText(err, config.sandbox));
    skipped("shell", "sandbox failed");
    skipped("mount", "sandbox failed");
    return 1;
  }
  if (uname.timedOut) {
    fail("sandbox", `"${config.sandbox}" did not answer within 30s; check the sandbox state`);
    skipped("shell", "sandbox failed");
    skipped("mount", "sandbox failed");
    return 1;
  }
  ok("sandbox", `"${config.sandbox}" is running`);
  const kernel = uname.output.trim();
  if (uname.exitCode !== 0 || kernel !== "Linux") {
    fail("shell", `uname -s gave ${JSON.stringify(kernel)} with exit code ${uname.exitCode ?? "unknown"}, expected Linux with exit 0; is ${config.shell} installed in the image? or set --shell`);
    skipped("mount", "shell failed");
    return 1;
  }
  ok("shell", `${config.shell} runs, uname -s is Linux`);

  // 6. mount
  const fold = config.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
  try {
    const ls = await deps.backend.run(`ls -A1 -- ${shQuote(config.guestRoot)}`, { timeoutMs: CHECK_TIMEOUT_MS });
    if (ls.timedOut || ls.exitCode !== 0) {
      fail("mount", `listing ${config.guestRoot} in the sandbox failed (${ls.timedOut ? "timed out" : `exit code ${ls.exitCode ?? "unknown"}`}); is the host root mounted at the guest root?`);
    } else {
      const guest = ls.output.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l !== "");
      const host = await deps.readdir(config.hostRoot);
      if (host.length === 0) {
        ok("mount", `host root is empty, so the mount cannot be verified; add a file and rerun for a real check`);
      } else {
        const missingInGuest = diff(host, guest, fold);
        const missingOnHost = diff(guest, host, fold);
        if (missingInGuest.length === 0 && missingOnHost.length === 0) {
          ok("mount", `${config.hostRoot} matches ${config.guestRoot} (${host.length} entries)`);
        } else {
          const parts: string[] = [];
          if (missingInGuest.length) parts.push(`missing in sandbox: ${names(missingInGuest)}`);
          if (missingOnHost.length) parts.push(`missing on host: ${names(missingOnHost)}`);
          fail("mount", `${parts.join("; ")}; check the mount of ${config.hostRoot} at ${config.guestRoot} (a file created between the two reads can cause this, so rerun)`);
        }
      }
    }
  } catch (e) {
    const err = e instanceof BackendError ? e : undefined;
    fail("mount", err ? backendErrorText(err, config.sandbox) : msg(e));
  }
  return failed ? 1 : 0;
}
