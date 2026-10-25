import { randomBytes } from "node:crypto";

const CWD_PREFIX = "__SHELLMCP_CWD_";
const RESET_PREFIX = "__SHELLMCP_RESET_";

/** POSIX single-quote: ' becomes '\'' */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Foreground wrapper. The user command sits on its own line and is followed by
 * a final newline, so a trailing comment or unterminated here-doc cannot
 * swallow the trap (the trap is installed before the command anyway).
 */
export function wrapForeground(
  command: string,
  cwd: string,
  guestRoot: string,
  nonce: string,
): string {
  const reset = `${RESET_PREFIX}${nonce}__`;
  const marker = `${CWD_PREFIX}${nonce}__`;
  return (
    `cd -- ${shQuote(cwd)} 2>/dev/null || { cd -- ${shQuote(guestRoot)}; printf '%s\\n' ${shQuote(reset)} >&2; }\n` +
    `trap 'printf "\\n%s%s\\n" "${marker}" "$PWD" >&2' EXIT\n` +
    command +
    "\n"
  );
}

/** Background wrapper: no trap, human-readable note when cwd is gone. */
export function wrapBackground(command: string, cwd: string, guestRoot: string): string {
  const note = `[shell-mcp: ${cwd} no longer exists; started in ${guestRoot}]`;
  return (
    `cd -- ${shQuote(cwd)} 2>/dev/null || { cd -- ${shQuote(guestRoot)}; printf '%s\\n' ${shQuote(note)} >&2; }\n` +
    command +
    "\n"
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the last cwd marker anywhere in the output (stderr may arrive before
 * stdout), strips every marker line (plus the newline the trap printed before
 * it) and the reset line. Markers with another nonce are left untouched.
 */
export function extractCwd(
  output: string,
  nonce: string,
): { output: string; cwd: string | null; reset: boolean } {
  const cwdRe = new RegExp(`\\n?${escapeRe(CWD_PREFIX + nonce + "__")}([^\\n]*)\\n?`, "g");
  let cwd: string | null = null;
  let out = output.replace(cwdRe, (_m, p: string) => {
    cwd = p;
    return "";
  });
  const resetRe = new RegExp(`${escapeRe(RESET_PREFIX + nonce + "__")}\\n?`, "g");
  let reset = false;
  out = out.replace(resetRe, () => {
    reset = true;
    return "";
  });
  return { output: out, cwd, reset };
}
