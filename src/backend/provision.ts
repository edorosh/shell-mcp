/*
 * Create mode: provision the sandbox from the machine spec (design spec §3).
 *
 * Looks the sandbox up by name; creates it when absent, starts it when stopped, reuses it when
 * running, and refuses (or with --recreate, removes and recreates) one whose owned settings differ
 * from the flags. Owned settings: image, mounts with their read-only flag, network policy, and
 * cpus/memory when the flags set them. Everything goes through the SDK; no host process (X1).
 */
import type { MachineSpec, Mount } from "../config.js";
import type { SdkSandbox } from "./microsandbox.js";
import { BackendError } from "./types.js";

// The slice of the SDK used here; the real module satisfies it structurally.
export interface ProvisionMountBuilder {
  bind(host: string): ProvisionMountBuilder;
  readonly(): ProvisionMountBuilder;
}
export interface ProvisionNetworkBuilder {
  /** Takes the typed Rule/Destination shape. `policyJson` does not: it wants the wire form (Task 1 spike). */
  policy(policy: object): ProvisionNetworkBuilder;
}
export interface ProvisionPullEvent {
  kind: string;
  layerIndex?: number;
  downloadedBytes?: number;
  totalBytes?: number | null;
  totalDownloadBytes?: number | null;
}
export interface ProvisionPullCreate extends AsyncIterable<ProvisionPullEvent> {
  awaitSandbox(): Promise<SdkSandbox>;
}
export interface ProvisionBuilder {
  image(reference: string): ProvisionBuilder;
  pullPolicy(policy: string): ProvisionBuilder;
  volume(guest: string, configure: (m: ProvisionMountBuilder) => ProvisionMountBuilder): ProvisionBuilder;
  network(configure: (n: ProvisionNetworkBuilder) => ProvisionNetworkBuilder): ProvisionBuilder;
  cpus(n: number): ProvisionBuilder;
  memory(mib: number): ProvisionBuilder;
  detached(enabled: boolean): ProvisionBuilder;
  build(): Promise<unknown>;
  createWithPullProgress(): Promise<ProvisionPullCreate>;
}
export interface ProvisionHandle {
  status: string;
  config(): unknown;
  stop(): Promise<void>;
  connectWithTimeout(ms: number): Promise<SdkSandbox>;
}
export interface ProvisionSdk {
  Sandbox: {
    builder(name: string): ProvisionBuilder;
    get(name: string): Promise<ProvisionHandle>;
    startDetached(name: string): Promise<unknown>;
    remove(name: string): Promise<void>;
  };
}

export interface OwnedConfig {
  image: string;
  /** Sorted by guest. */
  mounts: { guest: string; host: string; readonly: boolean }[];
  /** Canonical JSON of the policy. */
  network: string;
  cpus?: number;
  memoryMib?: number;
}

export type Inspect = { state: "absent" } | { state: "mismatch"; diffs: string[] } | { state: "ok"; status: string };

export interface ProvisionDeps {
  loadSdk(): Promise<ProvisionSdk>;
  platform: NodeJS.Platform;
}

const CONNECT_MS = 10_000;

const allow = (destination: object) => ({ direction: "egress", destination, protocols: [], ports: [], action: "allow" });
// Same values as the SDK's Rule.allowDns() / Rule.allowEgress(Destination.*()) (checked in the tests).
const ALLOW_DNS = {
  direction: "egress",
  destination: { kind: "group", group: "host" },
  protocols: ["udp", "tcp"],
  ports: [{ start: 53, end: 53 }],
  action: "allow",
};

/** Denied by default; DNS plus each --allow-domain, and the public group for --allow-network. Private ranges stay denied. */
export function networkPolicy(spec: MachineSpec): object {
  const rules: object[] = [];
  // Lower-cased, de-duplicated and sorted, so flag order or case never reads as a changed policy.
  const domains = [...new Set(spec.allowDomains.map((d) => d.toLowerCase()))].sort();
  for (const d of domains) {
    rules.push(allow(d.startsWith("*.") ? { kind: "domainSuffix", suffix: d.slice(2) } : { kind: "domain", domain: d }));
  }
  if (spec.allowNetwork) rules.push(allow({ kind: "group", group: "public" }));
  return { defaultEgress: "deny", defaultIngress: "deny", rules: rules.length ? [ALLOW_DNS, ...rules] : [] };
}

function builderFor(sdk: ProvisionSdk, name: string, spec: MachineSpec, mounts: Mount[]): ProvisionBuilder {
  let b = sdk.Sandbox.builder(name).image(spec.image).pullPolicy("if-missing");
  for (const m of mounts) {
    b = b.volume(m.guest, (v) => (m.readonly ? v.bind(m.hostResolved).readonly() : v.bind(m.hostResolved)));
  }
  b = b.network((n) => n.policy(networkPolicy(spec)));
  if (spec.cpus !== undefined) b = b.cpus(spec.cpus);
  if (spec.memoryMib !== undefined) b = b.memory(spec.memoryMib);
  return b.detached(true);
}

/**
 * The owned settings the flags ask for, read back from the builder's `.build()` through the same
 * parser as an existing sandbox's `config()`, so both sides have one shape. cpus/memory are left
 * out when the flags do not set them (`.build()` fills in SDK defaults).
 */
export async function wantedOwned(sdk: ProvisionSdk, name: string, spec: MachineSpec, mounts: Mount[]): Promise<OwnedConfig> {
  const owned = ownedFromSdkConfig(await builderFor(sdk, name, spec, mounts).build());
  if (spec.cpus === undefined) delete owned.cpus;
  if (spec.memoryMib === undefined) delete owned.memoryMib;
  return owned;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined);

function canonical(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x) => {
    if (typeof x === "bigint") return String(x);
    const o = obj(x);
    return o ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) : x;
  });
}

/**
 * Owned settings from a SandboxConfig. Field paths come from `.build()` in microsandbox 0.7.11,
 * pending spike step 2 (which checks that `handle.config()` has the same shape):
 *   image.Oci.reference, mounts[].{guest, host, options.readonly}, network.policy,
 *   resources.{cpus, memoryMib}.
 * Missing fields read as undefined (or empty), never throw.
 */
export function ownedFromSdkConfig(cfg: unknown): OwnedConfig {
  const c = obj(cfg) ?? {};
  const imageObj = obj(c.image);
  const image = str(c.image) ?? str(obj(imageObj?.Oci)?.reference) ?? str(obj(Object.values(imageObj ?? {})[0])?.reference) ?? "";
  const mounts = (Array.isArray(c.mounts) ? c.mounts : [])
    .map(obj)
    .filter((m): m is Record<string, unknown> => m !== undefined && str(m.guest) !== undefined)
    .map((m) => ({
      guest: str(m.guest)!,
      host: str(m.host) ?? "",
      readonly: (obj(m.options)?.readonly ?? m.readonly) === true,
    }))
    .sort((a, b) => (a.guest < b.guest ? -1 : a.guest > b.guest ? 1 : 0));
  const resources = obj(c.resources);
  const owned: OwnedConfig = { image, mounts, network: canonical(obj(c.network)?.policy) };
  const cpus = num(resources?.cpus);
  const memoryMib = num(resources?.memoryMib);
  if (cpus !== undefined) owned.cpus = cpus;
  if (memoryMib !== undefined) owned.memoryMib = memoryMib;
  return owned;
}

/** Allowed domains (suffixes as `*.x`) and whether the public group is open, read from canonical policy JSON. */
function policyAllows(network: string): { domains: Set<string>; open: boolean } | undefined {
  try {
    const p = obj(JSON.parse(network));
    const rules = p?.rules;
    if (!p || !Array.isArray(rules)) return undefined;
    const domains = new Set<string>();
    let open = false;
    for (const r of rules) {
      const d = obj(obj(r)?.destination);
      if (d?.kind === "domain" && typeof d.domain === "string") domains.add(d.domain);
      else if (d?.kind === "domainSuffix" && typeof d.suffix === "string") domains.add(`*.${d.suffix}`);
      else if (d?.kind === "group" && d.group === "public") open = true;
    }
    return { domains, open };
  } catch {
    return undefined;
  }
}

function networkDiffs(have: string, want: string): string[] {
  const h = policyAllows(have);
  const w = policyAllows(want);
  if (!h || !w) return ["network policy changed"];
  const out: string[] = [];
  const added = [...w.domains].filter((d) => !h.domains.has(d)).sort();
  const removed = [...h.domains].filter((d) => !w.domains.has(d)).sort();
  if (added.length) out.push(`allowed domains added: ${added.join(", ")}`);
  if (removed.length) out.push(`allowed domains removed: ${removed.join(", ")}`);
  if (h.open !== w.open) out.push(`--allow-network ${w.open ? "on" : "off"}`);
  return out.length ? out : ["network policy changed"];
}

/** Differences from `have` (the existing sandbox) to `want` (the flags), one line each. */
export function compareOwned(have: OwnedConfig, want: OwnedConfig, platform: NodeJS.Platform): string[] {
  const diffs: string[] = [];
  if (have.image !== want.image) diffs.push(`image ${have.image} → ${want.image}`);
  const sameHost = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const haveBy = new Map(have.mounts.map((m) => [m.guest, m]));
  const wantBy = new Map(want.mounts.map((m) => [m.guest, m]));
  const guests = [...new Set([...haveBy.keys(), ...wantBy.keys()])].sort();
  for (const g of guests) {
    const h = haveBy.get(g);
    const w = wantBy.get(g);
    if (!h) diffs.push(`mount ${g} added`);
    else if (!w) diffs.push(`mount ${g} removed`);
    else {
      if (!sameHost(h.host, w.host)) diffs.push(`mount ${g} host ${h.host} → ${w.host}`);
      if (h.readonly !== w.readonly) diffs.push(`mount ${g} read-only ${w.readonly ? "on" : "off"}`);
    }
  }
  if (have.network !== want.network) diffs.push(...networkDiffs(have.network, want.network));
  const show = (v: number | undefined) => (v === undefined ? "default" : String(v));
  if (want.cpus !== undefined && have.cpus !== want.cpus) diffs.push(`cpus ${show(have.cpus)} → ${want.cpus}`);
  if (want.memoryMib !== undefined && have.memoryMib !== want.memoryMib) {
    diffs.push(`memory ${show(have.memoryMib)} MiB → ${want.memoryMib} MiB`);
  }
  return diffs;
}

const codeOf = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
};

/** Overall download percentage from pull events; undefined until a total is known. */
class PullMeter {
  private total?: number;
  private readonly layerTotals = new Map<number, number>();
  private readonly layerDone = new Map<number, number>();

  update(ev: ProvisionPullEvent): void {
    const i = ev.layerIndex;
    if (ev.kind === "resolved" && ev.totalDownloadBytes) this.total = ev.totalDownloadBytes;
    if (i === undefined) return;
    if (ev.totalBytes && (ev.kind === "layerDownloadProgress")) this.layerTotals.set(i, ev.totalBytes);
    if (ev.kind === "layerDownloadProgress" && ev.downloadedBytes !== undefined) this.layerDone.set(i, ev.downloadedBytes);
    if (ev.kind === "layerDownloadComplete") {
      const done = ev.downloadedBytes ?? this.layerTotals.get(i) ?? 0;
      this.layerDone.set(i, done);
      if (!this.layerTotals.has(i)) this.layerTotals.set(i, done);
    }
  }

  percent(): number | undefined {
    let total = this.total;
    if (!total) {
      total = 0;
      for (const t of this.layerTotals.values()) total += t;
    }
    if (!total) return undefined;
    let done = 0;
    for (const d of this.layerDone.values()) done += d;
    return Math.min(100, Math.floor((done / total) * 100));
  }
}

const PULL_KINDS = /^(resolving|resolved|layer|stitch|complete$)/;

export class Provisioner {
  private attempt?: Promise<SdkSandbox>;
  private stage = "";
  private readonly listeners = new Set<(line: string) => void>();
  private sdk?: ProvisionSdk;

  constructor(
    private readonly name: string,
    private readonly spec: MachineSpec,
    private readonly mounts: Mount[],
    private readonly opts: { recreate: boolean },
    private readonly deps: ProvisionDeps,
  ) {}

  /** Create, start or reuse; one attempt at a time, shared by concurrent callers. */
  ensure(onStage?: (line: string) => void): Promise<SdkSandbox> {
    if (onStage) this.listeners.add(onStage);
    if (!this.attempt) {
      const p = this.run();
      this.attempt = p;
      // Settled attempts are not kept: the next call checks the sandbox again (it may have stopped).
      p.then(
        () => this.settle(p),
        () => this.settle(p),
      );
    }
    const p = this.attempt;
    if (onStage) {
      const off = () => this.listeners.delete(onStage);
      p.then(off, off);
    }
    return p;
  }

  /** Last stage line, e.g. "pulling ubuntu:24.04, 60%"; "" before the first attempt. */
  progress(): string {
    return this.stage;
  }

  /** Read-only, for --check: never creates, starts or removes. */
  async inspect(): Promise<Inspect> {
    const sdk = await this.load();
    const handle = await this.lookup(sdk);
    if (!handle) return { state: "absent" };
    const diffs = await this.diffs(sdk, handle);
    return diffs.length ? { state: "mismatch", diffs } : { state: "ok", status: handle.status };
  }

  private settle(p: Promise<SdkSandbox>): void {
    if (this.attempt === p) this.attempt = undefined;
  }

  private report(line: string): void {
    if (line === this.stage) return;
    this.stage = line;
    for (const l of this.listeners) l(line);
  }

  private async load(): Promise<ProvisionSdk> {
    return this.sdk ?? (this.sdk = await this.deps.loadSdk());
  }

  private async lookup(sdk: ProvisionSdk): Promise<ProvisionHandle | undefined> {
    try {
      return await sdk.Sandbox.get(this.name);
    } catch (e) {
      if (codeOf(e) === "sandboxNotFound") return undefined;
      throw e;
    }
  }

  private async diffs(sdk: ProvisionSdk, handle: ProvisionHandle): Promise<string[]> {
    const want = await wantedOwned(sdk, this.name, this.spec, this.mounts);
    const have = ownedFromSdkConfig(await handle.config());
    return compareOwned(have, want, this.deps.platform);
  }

  private async run(): Promise<SdkSandbox> {
    this.report("checking");
    const sdk = await this.load();
    const handle = await this.lookup(sdk);
    if (!handle) return this.create(sdk);

    const diffs = await this.diffs(sdk, handle);
    if (diffs.length) {
      if (!this.opts.recreate) {
        throw new BackendError(
          "config_mismatch",
          `sandbox "${this.name}" was created with different settings: ${diffs.join(", ")}. ` +
            "Restart with --recreate (deletes everything in the sandbox outside the mounts) or run --prepare --recreate.",
        );
      }
      this.report("removing");
      if (handle.status === "running") await handle.stop();
      await sdk.Sandbox.remove(this.name);
      return this.create(sdk);
    }

    if (handle.status === "stopped" || handle.status === "crashed" || handle.status === "created") {
      this.report("starting");
      await sdk.Sandbox.startDetached(this.name);
      this.report("connecting");
      return (await sdk.Sandbox.get(this.name)).connectWithTimeout(CONNECT_MS);
    }
    if (handle.status !== "running") {
      throw new BackendError("not_running", `sandbox "${this.name}" is ${handle.status}`);
    }
    this.report("connecting");
    return handle.connectWithTimeout(CONNECT_MS);
  }

  private async create(sdk: ProvisionSdk): Promise<SdkSandbox> {
    const creation = await builderFor(sdk, this.name, this.spec, this.mounts).createWithPullProgress();
    const meter = new PullMeter();
    try {
      for await (const ev of creation) {
        if (!PULL_KINDS.test(ev.kind)) {
          this.report("creating");
          continue;
        }
        meter.update(ev);
        const pct = meter.percent();
        this.report(`pulling ${this.spec.image}${pct === undefined ? "" : `, ${pct}%`}`);
      }
    } catch {
      // Progress is best effort; awaitSandbox() carries the real outcome.
    }
    this.report("creating");
    return creation.awaitSandbox();
  }
}
