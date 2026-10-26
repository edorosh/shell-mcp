import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export interface Mount {
  /** As the user wrote it (normalized); this is what the agent sees. */
  host: string;
  /** Symlinks resolved (create mode); this is what goes to msb. Equals `host` in attach mode. */
  hostResolved: string;
  guest: string;
  readonly: boolean;
}

export interface MachineSpec {
  image: string;
  allowDomains: string[];
  allowNetwork: boolean;
  cpus?: number;
  memoryMib?: number;
}

export interface Config {
  sandbox: string;
  /** The first mount is the project mount. */
  mounts: Mount[];
  /** Present only in create mode (--image). */
  machine?: MachineSpec;
  recreate: boolean;
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

/** Parse "2048" (MiB) or "2g" / "1.5g" (GiB) into MiB. */
export function parseMemory(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(g)?$/i.exec(s.trim());
  const mib = m ? Math.round(Number(m[1]) * (m[2] ? 1024 : 1)) : 0;
  if (!(mib > 0)) throw new ConfigError(`memory must be a positive size in MiB or with a g suffix (2048, 2g): ${JSON.stringify(s)}`);
  return mib;
}

function hostPathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Normalize an absolute host path: collapse segments, strip a trailing separator (not from a root). */
function normalizeHost(p: typeof path.win32, raw: string): string {
  let host = p.normalize(raw);
  if (host !== p.parse(host).root) host = host.replace(/[\\/]+$/, "");
  return host;
}

/** Parse HOST:GUEST[:ro]. The guest part is everything after the last ":/". */
export function parseMount(s: string, platform: NodeJS.Platform): { host: string; guest: string; readonly: boolean } {
  let rest = s;
  let readonly = false;
  if (/:ro$/.test(rest)) {
    readonly = true;
    rest = rest.slice(0, -3);
  }
  const i = rest.lastIndexOf(":/");
  if (i <= 0) throw new ConfigError(`mount must look like HOST:/guest/path[:ro]: ${JSON.stringify(s)}`);
  const rawHost = rest.slice(0, i);
  const rawGuest = rest.slice(i + 1);
  const p = hostPathFor(platform);
  if (!p.isAbsolute(rawHost)) throw new ConfigError(`mount host path must be absolute: ${JSON.stringify(s)}`);
  const guest = path.posix.normalize(rawGuest).replace(/\/+$/, "");
  if (guest === "") throw new ConfigError(`mount guest path must not be /: ${JSON.stringify(s)}`);
  return { host: normalizeHost(p, rawHost), guest, readonly };
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes)$/i.test(v.trim());

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
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; realpath?: (p: string) => string } = {},
): Config {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const realpath = opts.realpath ?? ((p: string) => realpathSync.native(p));
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
        image: { type: "string" },
        mount: { type: "string", multiple: true },
        "allow-domain": { type: "string", multiple: true },
        "allow-network": { type: "boolean" },
        cpus: { type: "string" },
        memory: { type: "string" },
        recreate: { type: "boolean" },
      },
    }));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const pick = (flag: string, envName: string): string | undefined =>
    (values as Record<string, string | undefined>)[flag] ?? env[envName];

  const sandbox = pick("sandbox", "SHELL_MCP_SANDBOX");
  if (!sandbox) throw new ConfigError("sandbox is required (--sandbox or SHELL_MCP_SANDBOX)");

  const p = hostPathFor(platform);
  const v = values as Record<string, string | string[] | boolean | undefined>;
  const rawImage = pick("image", "SHELL_MCP_IMAGE");
  if (rawImage !== undefined && rawImage.trim() === "") throw new ConfigError("image must not be empty");
  const image = rawImage?.trim();

  const mounts: Mount[] = [];
  let machine: MachineSpec | undefined;
  if (image) {
    if (pick("host-root", "SHELL_MCP_HOST_ROOT") || pick("guest-root", "SHELL_MCP_GUEST_ROOT")) {
      throw new ConfigError("--host-root and --guest-root do not apply with --image; use --mount");
    }
    const specs = (v.mount as string[] | undefined) ??
      (env.SHELL_MCP_MOUNT ?? "").split(";").map((x) => x.trim()).filter((x) => x !== "");
    if (specs.length === 0) throw new ConfigError("--image needs at least one --mount (or SHELL_MCP_MOUNT)");
    const seen = new Set<string>();
    for (const spec of specs) {
      const m = parseMount(spec, platform);
      if (seen.has(m.guest)) throw new ConfigError(`duplicate mount guest path: ${m.guest}`);
      seen.add(m.guest);
      if (!exists(m.host)) throw new ConfigError(`mount host path does not exist: ${m.host}`);
      let hostResolved: string;
      try {
        hostResolved = realpath(m.host);
      } catch (e) {
        throw new ConfigError(`cannot resolve mount host path ${m.host}: ${(e as Error).message}`);
      }
      mounts.push({ host: m.host, hostResolved, guest: m.guest, readonly: m.readonly });
    }
    const domains = ((v["allow-domain"] as string[] | undefined) ??
      (env.SHELL_MCP_ALLOW_DOMAIN ?? "").split(",")).map((x) => x.trim()).filter((x) => x !== "");
    const cpus = pick("cpus", "SHELL_MCP_CPUS");
    const memory = pick("memory", "SHELL_MCP_MEMORY");
    machine = {
      image,
      allowDomains: domains,
      allowNetwork: (v["allow-network"] as boolean | undefined) ?? truthy(env.SHELL_MCP_ALLOW_NETWORK),
      ...(cpus === undefined ? {} : { cpus: parseIntSetting("cpus", cpus) }),
      ...(memory === undefined ? {} : { memoryMib: parseMemory(memory) }),
    };
  } else {
    const createOnly: [string, boolean][] = [
      ["--mount", v.mount !== undefined || !!env.SHELL_MCP_MOUNT],
      ["--allow-domain", v["allow-domain"] !== undefined || !!env.SHELL_MCP_ALLOW_DOMAIN],
      ["--allow-network", v["allow-network"] !== undefined || truthy(env.SHELL_MCP_ALLOW_NETWORK)],
      ["--cpus", pick("cpus", "SHELL_MCP_CPUS") !== undefined],
      ["--memory", pick("memory", "SHELL_MCP_MEMORY") !== undefined],
      ["--recreate", v.recreate === true],
    ];
    const bad = createOnly.find(([, set]) => set);
    if (bad) throw new ConfigError(`${bad[0]} is only with --image`);

    const rawHost = pick("host-root", "SHELL_MCP_HOST_ROOT");
    if (!rawHost) throw new ConfigError("host-root is required (--host-root or SHELL_MCP_HOST_ROOT)");
    if (!p.isAbsolute(rawHost)) throw new ConfigError(`host-root must be an absolute path: ${rawHost}`);
    const hostRoot = normalizeHost(p, rawHost);
    if (!exists(hostRoot)) throw new ConfigError(`host-root does not exist: ${hostRoot}`);

    const rawGuest = pick("guest-root", "SHELL_MCP_GUEST_ROOT");
    if (!rawGuest) throw new ConfigError("guest-root is required (--guest-root or SHELL_MCP_GUEST_ROOT)");
    if (!path.posix.isAbsolute(rawGuest)) throw new ConfigError(`guest-root must be an absolute POSIX path: ${rawGuest}`);
    const guestRoot = rawGuest.length > 1 ? rawGuest.replace(/\/+$/, "") || "/" : rawGuest;
    mounts.push({ host: hostRoot, hostResolved: hostRoot, guest: guestRoot, readonly: false });
  }

  const dt = pick("default-timeout", "SHELL_MCP_DEFAULT_TIMEOUT");
  const mt = pick("max-timeout", "SHELL_MCP_MAX_TIMEOUT");
  const mo = pick("max-output", "SHELL_MCP_MAX_OUTPUT");
  const defaultTimeoutMs = duration("default-timeout", dt ?? "120s");
  const maxTimeoutMs = duration("max-timeout", mt ?? "600s");
  if (defaultTimeoutMs > maxTimeoutMs) throw new ConfigError("default-timeout must not exceed max-timeout");
  const maxOutput = mo === undefined ? 30000 : parseIntSetting("max-output", mo);

  const flagRewrite = (values as Record<string, boolean | undefined>)["rewrite-output-paths"];
  // Only 0 / false / no (any case) disable rewriting via the environment; anything else keeps it on.
  const envRewrite = env.SHELL_MCP_REWRITE_OUTPUT_PATHS;
  const rewriteOutputPaths = flagRewrite ?? !(envRewrite !== undefined && /^(0|false|no)$/i.test(envRewrite.trim()));

  return {
    sandbox, mounts, ...(machine ? { machine } : {}), recreate: v.recreate === true, defaultTimeoutMs, maxTimeoutMs, maxOutput,
    rewriteOutputPaths, shell: pick("shell", "SHELL_MCP_SHELL") ?? "bash", platform,
  };
}

export type Cli =
  | { mode: "help" }
  | { mode: "version" }
  | { mode: "check"; config: Config }
  | { mode: "prepare"; config: Config }
  | { mode: "serve"; config: Config };

/** Pick the mode: --help > --version > --check > --prepare > serve. Help and version ignore everything else. */
export function parseCli(
  argv: string[],
  env: Record<string, string | undefined>,
  opts?: Parameters<typeof parseConfig>[2],
): Cli {
  if (argv.includes("--help")) return { mode: "help" };
  if (argv.includes("--version")) return { mode: "version" };
  const check = argv.includes("--check");
  const prepare = argv.includes("--prepare");
  const config = parseConfig(argv.filter((a) => a !== "--check" && a !== "--prepare"), env, opts);
  if (check && config.recreate) throw new ConfigError("--recreate cannot be used with --check");
  if (check) return { mode: "check", config };
  if (prepare && !config.machine) throw new ConfigError("--prepare needs --image");
  return prepare ? { mode: "prepare", config } : { mode: "serve", config };
}
