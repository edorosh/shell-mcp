import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export interface Config {
  sandbox: string;
  hostRoot: string;
  guestRoot: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutput: number;
  rewriteOutputPaths: boolean;
  shell: string;
  platform: NodeJS.Platform;
}

export class ConfigError extends Error {}

/** Parse "120s", "5m", "1500ms" or a bare number (seconds) into milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s.trim());
  if (!m) throw new ConfigError(`invalid duration: ${JSON.stringify(s)}`);
  const unit = m[2] ?? "s";
  const ms = Number(m[1]) * (unit === "ms" ? 1 : unit === "s" ? 1000 : 60000);
  if (!(ms > 0)) throw new ConfigError(`duration must be positive: ${JSON.stringify(s)}`);
  return ms;
}

function parseIntSetting(name: string, v: string): number {
  if (!/^\d+$/.test(v) || Number(v) <= 0) throw new ConfigError(`${name} must be a positive integer: ${JSON.stringify(v)}`);
  return Number(v);
}

function duration(name: string, v: string): number {
  try {
    return parseDuration(v);
  } catch (e) {
    throw new ConfigError(`${name}: ${(e as Error).message}`);
  }
}

export function parseConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {},
): Config {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowNegative: true,
      options: {
        sandbox: { type: "string" },
        "host-root": { type: "string" },
        "guest-root": { type: "string" },
        "default-timeout": { type: "string" },
        "max-timeout": { type: "string" },
        "max-output": { type: "string" },
        "rewrite-output-paths": { type: "boolean" },
        shell: { type: "string" },
      },
    }));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const pick = (flag: string, envName: string): string | undefined =>
    (values as Record<string, string | undefined>)[flag] ?? env[envName];

  const sandbox = pick("sandbox", "SHELL_MCP_SANDBOX");
  if (!sandbox) throw new ConfigError("sandbox is required (--sandbox or SHELL_MCP_SANDBOX)");

  const p = platform === "win32" ? path.win32 : path.posix;
  const rawHost = pick("host-root", "SHELL_MCP_HOST_ROOT");
  if (!rawHost) throw new ConfigError("host-root is required (--host-root or SHELL_MCP_HOST_ROOT)");
  if (!p.isAbsolute(rawHost)) throw new ConfigError(`host-root must be an absolute path: ${rawHost}`);
  let hostRoot = p.normalize(rawHost);
  if (hostRoot !== p.parse(hostRoot).root) hostRoot = hostRoot.replace(/[\\/]+$/, "");
  if (!exists(hostRoot)) throw new ConfigError(`host-root does not exist: ${hostRoot}`);

  const rawGuest = pick("guest-root", "SHELL_MCP_GUEST_ROOT");
  if (!rawGuest) throw new ConfigError("guest-root is required (--guest-root or SHELL_MCP_GUEST_ROOT)");
  if (!path.posix.isAbsolute(rawGuest)) throw new ConfigError(`guest-root must be an absolute POSIX path: ${rawGuest}`);
  const guestRoot = rawGuest.length > 1 ? rawGuest.replace(/\/+$/, "") || "/" : rawGuest;

  const dt = pick("default-timeout", "SHELL_MCP_DEFAULT_TIMEOUT");
  const mt = pick("max-timeout", "SHELL_MCP_MAX_TIMEOUT");
  const mo = pick("max-output", "SHELL_MCP_MAX_OUTPUT");
  const defaultTimeoutMs = duration("default-timeout", dt ?? "120s");
  const maxTimeoutMs = duration("max-timeout", mt ?? "600s");
  if (defaultTimeoutMs > maxTimeoutMs) throw new ConfigError("default-timeout must not exceed max-timeout");
  const maxOutput = mo === undefined ? 30000 : parseIntSetting("max-output", mo);

  const flagRewrite = (values as Record<string, boolean | undefined>)["rewrite-output-paths"];
  const rewriteOutputPaths = flagRewrite ?? env.SHELL_MCP_REWRITE_OUTPUT_PATHS !== "0";

  return {
    sandbox, hostRoot, guestRoot, defaultTimeoutMs, maxTimeoutMs, maxOutput,
    rewriteOutputPaths, shell: pick("shell", "SHELL_MCP_SHELL") ?? "bash", platform,
  };
}
