export interface RuntimeDeps {
  resolveRuntime(): { msbPath: string; origin: string };
  resolveRuntimeVersion(p: string): Promise<string | null>;
}

export type RuntimeCheck =
  | { ok: true; origin: string; msbPath: string; version: string; note?: string }
  | { ok: false; message: string; origin?: string; msbPath?: string; version?: string };

// Loaded lazily so importing this module never touches the native SDK.
async function defaultDeps(): Promise<RuntimeDeps> {
  const sdk = await import("microsandbox");
  return { resolveRuntime: () => sdk.resolveRuntime(), resolveRuntimeVersion: (p) => sdk.resolveRuntimeVersion(p) };
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Explains a native-module or runtime failure; an x64 Mac has no microsandbox build. */
export function nativeHint(platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): string {
  return platform === "darwin" && arch === "x64"
    ? "macOS needs Apple Silicon and an arm64 Node (this Node is x64: an Intel Mac, or Node running under Rosetta)"
    : "reinstall shell-mcp without --omit=optional on this OS and CPU";
}

/** Compares the msb the SDK will use against the SDK version it is pinned to. */
export async function checkRuntime(
  sdkVersion: string,
  deps?: RuntimeDeps,
  host: { platform: NodeJS.Platform; arch: NodeJS.Architecture } = { platform: process.platform, arch: process.arch },
): Promise<RuntimeCheck> {
  const hint = (e: unknown) => `${text(e)}; ${nativeHint(host.platform, host.arch)}`;
  let d: RuntimeDeps;
  let resolved: { msbPath: string; origin: string };
  try {
    d = deps ?? (await defaultDeps());
    resolved = d.resolveRuntime();
  } catch (e) {
    return { ok: false, message: hint(e) };
  }
  const { msbPath, origin } = resolved;
  let version: string | null;
  try {
    version = await d.resolveRuntimeVersion(msbPath);
  } catch (e) {
    return { ok: false, message: hint(e), origin, msbPath };
  }
  if (version === null) {
    return {
      ok: true,
      origin,
      msbPath,
      version: "unknown",
      note: `msb does not report its version; cannot compare with SDK ${sdkVersion}`,
    };
  }
  if (version !== sdkVersion) {
    return {
      ok: false,
      message: `msb ${version} does not match SDK ${sdkVersion}; install msb ${sdkVersion} or remove the home install so the packaged runtime is used`,
      origin,
      msbPath,
      version,
    };
  }
  return { ok: true, origin, msbPath, version };
}

export function runtimeLogLine(r: RuntimeCheck): string {
  if (!r.ok) {
    const warning = `warning: ${r.message}; run shell-mcp --check`;
    return r.version && r.origin && r.msbPath ? `runtime msb ${r.version} from ${r.origin} (${r.msbPath}); ${warning}` : warning;
  }
  const line = `runtime msb ${r.version} from ${r.origin} (${r.msbPath})`;
  return r.note ? `${line}; ${r.note}` : line;
}
