import os from "node:os";
import { describe, expect, it } from "vitest";
import type { MachineSpec, Mount } from "../src/config.js";
import { BackendError } from "../src/backend/types.js";
import type { SdkSandbox } from "../src/backend/microsandbox.js";
import {
  Provisioner,
  compareOwned,
  networkPolicy,
  ownedFromSdkConfig,
  wantedOwned,
  type OwnedConfig,
  type ProvisionSdk,
} from "../src/backend/provision.js";

class SdkErr extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

const spec = (over: Partial<MachineSpec> = {}): MachineSpec => ({
  image: "ubuntu:24.04",
  allowDomains: [],
  allowNetwork: false,
  ...over,
});
const mount = (guest: string, hostResolved: string, readonly = false): Mount => ({
  host: hostResolved.replace("/real/", "/link/"),
  hostResolved,
  guest,
  readonly,
});
const MOUNTS = [mount("/workspace", "/real/proj"), mount("/ref", "/real/ref", true)];

type AnyPolicy = { defaultEgress: string; defaultIngress: string; rules: { destination: Record<string, string> }[] };

/** Typed Rule/Destination -> the SDK's wire form, as `.build()` and `config()` hold it. */
function wirePolicy(p: AnyPolicy): unknown {
  return {
    ...p,
    rules: p.rules.map((r) => {
      const { kind, ...rest } = r.destination;
      const value = kind === "domainSuffix" ? rest.suffix : Object.values(rest)[0];
      return { ...r, destination: kind === "any" ? "any" : { [kind]: value } };
    }),
  };
}

interface Built {
  image?: string;
  mounts: { guest: string; host: string; readonly: boolean }[];
  policy?: AnyPolicy;
  cpus?: number;
  memory?: number;
}

/** The SandboxConfig shape `.build()` returns (microsandbox 0.7.11). */
function sdkConfig(b: Built): unknown {
  return {
    name: "x",
    image: { Oci: { reference: b.image } },
    resources: { cpus: b.cpus ?? 1, memoryMib: b.memory ?? 512 },
    labels: {},
    mounts: [...b.mounts]
      .sort((x, y) => x.guest.localeCompare(y.guest))
      .map((m) => ({ type: "Bind", host: m.host, guest: m.guest, options: { readonly: m.readonly, noexec: false } })),
    network: { enabled: true, policy: b.policy ? wirePolicy(b.policy) : undefined, strict: true },
  };
}

function configFor(s: MachineSpec, mounts: Mount[]): unknown {
  return sdkConfig({
    image: s.image,
    mounts: mounts.map((m) => ({ guest: m.guest, host: m.hostResolved, readonly: m.readonly })),
    policy: networkPolicy(s) as AnyPolicy,
    cpus: s.cpus,
    memory: s.memoryMib,
  });
}

const fakeConn = { tag: "conn" } as unknown as SdkSandbox;

type GetResult = { status: string; config: unknown } | SdkErr;

class FakeSdk {
  log: string[] = [];
  builderCalls: string[] = [];
  gets: GetResult[] = [];
  creates = 0;
  createError?: Error;
  /** Holds create until released (for the concurrency test). */
  createGate?: Promise<void>;
  events: Record<string, unknown>[] = [
    { kind: "resolving", reference: "ubuntu:24.04" },
    { kind: "resolved", reference: "ubuntu:24.04", layerCount: 2, totalDownloadBytes: 200 },
    { kind: "layerDownloadProgress", layerIndex: 0, downloadedBytes: 60, totalBytes: 100 },
    { kind: "layerDownloadProgress", layerIndex: 1, downloadedBytes: 60, totalBytes: 100 },
    { kind: "layerDownloadComplete", layerIndex: 0, downloadedBytes: 100 },
    { kind: "layerDownloadComplete", layerIndex: 1, downloadedBytes: 100 },
    { kind: "complete", reference: "ubuntu:24.04", layerCount: 2 },
  ];

  private nextGet(name: string) {
    this.log.push(`get ${name}`);
    const r = this.gets.length > 1 ? this.gets.shift()! : this.gets[0];
    if (!r) throw new SdkErr("sandboxNotFound");
    if (r instanceof SdkErr) throw r;
    return r;
  }

  module(): ProvisionSdk {
    const self = this;
    const builder = (name: string) => {
      const b: Built = { mounts: [] };
      const rec = (s: string) => self.builderCalls.push(s);
      rec(`builder ${name}`);
      const api = {
        image(r: string) { rec(`image ${r}`); b.image = r; return api; },
        pullPolicy(p: string) { rec(`pullPolicy ${p}`); return api; },
        volume(guest: string, configure: (m: any) => any) {
          const m = { host: "", ro: false, bind(h: string) { m.host = h; return m; }, readonly() { m.ro = true; return m; } };
          configure(m);
          rec(`volume ${guest} bind ${m.host}${m.ro ? " readonly" : ""}`);
          b.mounts.push({ guest, host: m.host, readonly: m.ro });
          return api;
        },
        network(configure: (n: any) => any) {
          const n = { policy(p: AnyPolicy) { rec(`policy ${JSON.stringify(p)}`); b.policy = p; return n; } };
          configure(n);
          return api;
        },
        cpus(c: number) { rec(`cpus ${c}`); b.cpus = c; return api; },
        memory(m: number) { rec(`memory ${m}`); b.memory = m; return api; },
        detached(d: boolean) { rec(`detached ${d}`); return api; },
        async build() { return sdkConfig(b); },
        async createWithPullProgress() {
          self.creates++;
          self.log.push(`create ${name}`);
          const events = self.events;
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e;
            },
            async awaitSandbox() {
              if (self.createGate) await self.createGate;
              if (self.createError) throw self.createError;
              return fakeConn;
            },
          };
        },
      };
      return api;
    };
    return {
      Sandbox: {
        builder,
        get: async (name: string) => {
          const r = self.nextGet(name);
          return {
            status: r.status,
            config: () => r.config,
            stop: async () => { self.log.push(`stop ${name}`); },
            connectWithTimeout: async () => { self.log.push(`connect ${name}`); return fakeConn; },
          };
        },
        startDetached: async (name: string) => { self.log.push(`startDetached ${name}`); return {}; },
        remove: async (name: string) => { self.log.push(`remove ${name}`); },
      },
    } as unknown as ProvisionSdk;
  }
}

function setup(over: { spec?: MachineSpec; mounts?: Mount[]; recreate?: boolean; platform?: NodeJS.Platform } = {}) {
  const sdk = new FakeSdk();
  const p = new Provisioner("myproj", over.spec ?? spec(), over.mounts ?? MOUNTS, { recreate: over.recreate ?? false }, {
    loadSdk: async () => sdk.module(),
    platform: over.platform ?? "linux",
  });
  return { sdk, p };
}

const MUTATING = /^(create|startDetached|remove|stop) /;

describe("networkPolicy", () => {
  it("denies everything by default", () => {
    expect(networkPolicy(spec())).toEqual({ defaultEgress: "deny", defaultIngress: "deny", rules: [] });
  });

  it("allows DNS and each domain", () => {
    const p = networkPolicy(spec({ allowDomains: ["registry.npmjs.org", "*.github.com"] })) as AnyPolicy;
    expect(p.defaultEgress).toBe("deny");
    expect(p.defaultIngress).toBe("deny");
    expect(p.rules).toEqual([
      { direction: "egress", destination: { kind: "group", group: "host" }, protocols: ["udp", "tcp"], ports: [{ start: 53, end: 53 }], action: "allow" },
      { direction: "egress", destination: { kind: "domain", domain: "registry.npmjs.org" }, protocols: [], ports: [], action: "allow" },
      { direction: "egress", destination: { kind: "domainSuffix", suffix: "github.com" }, protocols: [], ports: [], action: "allow" },
    ]);
  });

  it("allows the public group, not private ranges, with --allow-network", () => {
    const p = networkPolicy(spec({ allowNetwork: true })) as AnyPolicy;
    expect(p.rules).toEqual([
      { direction: "egress", destination: { kind: "group", group: "host" }, protocols: ["udp", "tcp"], ports: [{ start: 53, end: 53 }], action: "allow" },
      { direction: "egress", destination: { kind: "group", group: "public" }, protocols: [], ports: [], action: "allow" },
    ]);
    expect(JSON.stringify(p)).not.toContain("private");
  });
});

describe("networkPolicy and wantedOwned against the real SDK (no VM)", () => {
  it("matches the SDK's Rule/Destination factories", async () => {
    const { Rule, Destination } = await import("microsandbox");
    expect(networkPolicy(spec({ allowDomains: ["a.example", "*.b.example"], allowNetwork: true }))).toEqual({
      defaultEgress: "deny",
      defaultIngress: "deny",
      rules: [
        Rule.allowDns(),
        Rule.allowEgress(Destination.domain("a.example")),
        Rule.allowEgress(Destination.domainSuffix("b.example")),
        Rule.allowEgress(Destination.group("public")),
      ],
    });
  });

  it("reads image, mounts, policy, cpus and memory back from .build()", async () => {
    const sdk = (await import("microsandbox")) as unknown as ProvisionSdk;
    const dir = os.tmpdir();
    const mounts: Mount[] = [
      { host: dir, hostResolved: dir, guest: "/workspace", readonly: false },
      { host: dir, hostResolved: dir, guest: "/a-ref", readonly: true },
    ];
    const s = spec({ allowDomains: ["*.github.com"], cpus: 2, memoryMib: 2048 });
    const want = await wantedOwned(sdk, "shell-mcp-unit", s, mounts);
    expect(want.image).toBe("ubuntu:24.04");
    expect(want.mounts).toEqual([
      { guest: "/a-ref", host: dir, readonly: true },
      { guest: "/workspace", host: dir, readonly: false },
    ]);
    expect(want.cpus).toBe(2);
    expect(want.memoryMib).toBe(2048);
    expect(want.network).toContain('"domainSuffix":"github.com"');
    expect(want.network).toContain('"defaultEgress":"deny"');

    const plain = await wantedOwned(sdk, "shell-mcp-unit", spec(), mounts);
    expect(plain.cpus).toBeUndefined();
    expect(plain.memoryMib).toBeUndefined();
  });
});

describe("ownedFromSdkConfig", () => {
  it("tolerates missing fields", () => {
    expect(ownedFromSdkConfig(undefined)).toEqual({ image: "", mounts: [], network: "null" });
    expect(ownedFromSdkConfig({ image: "ubuntu:24.04", mounts: [{ guest: "/w" }] })).toEqual({
      image: "ubuntu:24.04",
      mounts: [{ guest: "/w", host: "", readonly: false }],
      network: "null",
    });
  });

  it("canonicalizes the policy regardless of key order", () => {
    const a = ownedFromSdkConfig({ network: { policy: { defaultEgress: "deny", defaultIngress: "deny", rules: [] } } });
    const b = ownedFromSdkConfig({ network: { policy: { rules: [], defaultIngress: "deny", defaultEgress: "deny" } } });
    expect(a.network).toBe(b.network);
  });
});

describe("compareOwned", () => {
  const base = (host: string): OwnedConfig => ({ image: "i", mounts: [{ guest: "/w", host, readonly: false }], network: "{}" });

  it("compares host paths case-insensitively on win32 only", () => {
    expect(compareOwned(base("c:\\users\\u\\p"), base("C:\\Users\\u\\p"), "win32")).toEqual([]);
    expect(compareOwned(base("/users/u/p"), base("/Users/u/p"), "darwin")).toEqual(["mount /w host /users/u/p → /Users/u/p"]);
  });

  it("lists each owned difference", () => {
    const have: OwnedConfig = {
      image: "ubuntu:22.04",
      mounts: [{ guest: "/old", host: "/o", readonly: false }, { guest: "/w", host: "/p", readonly: false }],
      network: "a",
      cpus: 1,
      memoryMib: 512,
    };
    const want: OwnedConfig = {
      image: "ubuntu:24.04",
      mounts: [{ guest: "/cache", host: "/c", readonly: false }, { guest: "/w", host: "/p", readonly: true }],
      network: "b",
      cpus: 2,
      memoryMib: 1024,
    };
    expect(compareOwned(have, want, "linux")).toEqual([
      "image ubuntu:22.04 → ubuntu:24.04",
      "mount /cache added",
      "mount /old removed",
      "mount /w read-only on",
      "network policy changed",
      "cpus 1 → 2",
      "memory 512 MiB → 1024 MiB",
    ]);
  });

  it("ignores cpus and memory the flags leave unset", () => {
    const have: OwnedConfig = { image: "i", mounts: [], network: "n", cpus: 4, memoryMib: 4096 };
    expect(compareOwned(have, { image: "i", mounts: [], network: "n" }, "linux")).toEqual([]);
  });
});

describe("Provisioner", () => {
  it("creates an absent sandbox from the spec and reports stages in order", async () => {
    const s = spec({ allowDomains: ["*.github.com"], cpus: 2, memoryMib: 2048 });
    const { sdk, p } = setup({ spec: s });
    expect(p.progress()).toBe("");
    const stages: string[] = [];
    await expect(p.ensure((l) => stages.push(l))).resolves.toBe(fakeConn);
    expect(sdk.creates).toBe(1);
    const created = sdk.builderCalls.slice(sdk.builderCalls.lastIndexOf("builder myproj"));
    expect(created).toEqual([
      "builder myproj",
      "image ubuntu:24.04",
      "pullPolicy if-missing",
      "volume /workspace bind /real/proj",
      "volume /ref bind /real/ref readonly",
      `policy ${JSON.stringify(networkPolicy(s))}`,
      "cpus 2",
      "memory 2048",
      "detached true",
    ]);
    expect(stages).toEqual(["checking", "pulling ubuntu:24.04", "pulling ubuntu:24.04, 0%", "pulling ubuntu:24.04, 30%", "pulling ubuntu:24.04, 60%", "pulling ubuntu:24.04, 80%", "pulling ubuntu:24.04, 100%", "creating"]);
    expect(p.progress()).toBe("creating");
  });

  it("leaves cpus and memory to the SDK when unset", async () => {
    const { sdk, p } = setup();
    await p.ensure();
    expect(sdk.builderCalls.some((c) => /^(cpus|memory) /.test(c))).toBe(false);
  });

  it("reuses a matching running sandbox", async () => {
    const { sdk, p } = setup();
    sdk.gets = [{ status: "running", config: configFor(spec(), MOUNTS) }];
    const stages: string[] = [];
    await expect(p.ensure((l) => stages.push(l))).resolves.toBe(fakeConn);
    expect(sdk.log).toEqual(["get myproj", "connect myproj"]);
    expect(stages).toEqual(["checking", "connecting"]);
  });

  for (const status of ["stopped", "crashed", "created"]) {
    it(`starts a matching ${status} sandbox`, async () => {
      const { sdk, p } = setup();
      sdk.gets = [{ status, config: configFor(spec(), MOUNTS) }, { status: "running", config: configFor(spec(), MOUNTS) }];
      const stages: string[] = [];
      await expect(p.ensure((l) => stages.push(l))).resolves.toBe(fakeConn);
      expect(sdk.log).toEqual(["get myproj", "startDetached myproj", "get myproj", "connect myproj"]);
      expect(stages).toEqual(["checking", "starting", "connecting"]);
    });
  }

  it("refuses a sandbox with different settings without --recreate", async () => {
    const { sdk, p } = setup({ mounts: [...MOUNTS, mount("/cache", "/real/cache")] });
    sdk.gets = [{ status: "running", config: configFor(spec({ image: "ubuntu:22.04" }), MOUNTS) }];
    const err = await p.ensure().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).kind).toBe("config_mismatch");
    const msg = (err as BackendError).message;
    expect(msg).toContain('sandbox "myproj" was created with different settings: ');
    expect(msg).toContain("image ubuntu:22.04 → ubuntu:24.04");
    expect(msg).toContain("mount /cache added");
    expect(msg).toContain("--recreate");
    expect(sdk.log.filter((l) => MUTATING.test(l))).toEqual([]);
  });

  it("recreates a mismatched running sandbox with --recreate", async () => {
    const { sdk, p } = setup({ recreate: true });
    sdk.gets = [{ status: "running", config: configFor(spec({ image: "ubuntu:22.04" }), MOUNTS) }];
    const stages: string[] = [];
    await expect(p.ensure((l) => stages.push(l))).resolves.toBe(fakeConn);
    expect(sdk.log).toEqual(["get myproj", "stop myproj", "remove myproj", "create myproj"]);
    expect(stages[1]).toBe("removing");
    expect(stages.at(-1)).toBe("creating");
  });

  it("does not stop a mismatched stopped sandbox before removing it", async () => {
    const { sdk, p } = setup({ recreate: true });
    sdk.gets = [{ status: "stopped", config: configFor(spec({ allowNetwork: true }), MOUNTS) }];
    await p.ensure();
    expect(sdk.log).toEqual(["get myproj", "remove myproj", "create myproj"]);
  });

  it("runs one attempt for concurrent callers", async () => {
    const { sdk, p } = setup();
    let release!: () => void;
    sdk.createGate = new Promise((r) => (release = r));
    const a = p.ensure();
    const b = p.ensure();
    release();
    await expect(Promise.all([a, b])).resolves.toEqual([fakeConn, fakeConn]);
    expect(sdk.creates).toBe(1);
  });

  it("starts a new attempt after a failed one", async () => {
    const { sdk, p } = setup();
    sdk.createError = new Error("pull failed: manifest unknown");
    await expect(p.ensure()).rejects.toThrow("manifest unknown");
    sdk.createError = undefined;
    await expect(p.ensure()).resolves.toBe(fakeConn);
    expect(sdk.creates).toBe(2);
  });

  it("rethrows lookup errors other than not found", async () => {
    const { sdk, p } = setup();
    sdk.gets = [new SdkErr("runtime", "msb is not installed")];
    await expect(p.ensure()).rejects.toThrow("msb is not installed");
    expect(sdk.creates).toBe(0);
  });

  describe("inspect", () => {
    it("reports an absent sandbox", async () => {
      const { sdk, p } = setup();
      await expect(p.inspect()).resolves.toEqual({ state: "absent" });
      expect(sdk.creates).toBe(0);
    });

    it("reports differences", async () => {
      const { sdk, p } = setup({ recreate: true });
      sdk.gets = [{ status: "running", config: configFor(spec({ image: "ubuntu:22.04" }), MOUNTS) }];
      await expect(p.inspect()).resolves.toEqual({ state: "mismatch", diffs: ["image ubuntu:22.04 → ubuntu:24.04"] });
      expect(sdk.log.filter((l) => MUTATING.test(l))).toEqual([]);
    });

    it("reports the status of a matching sandbox", async () => {
      const { sdk, p } = setup();
      sdk.gets = [{ status: "stopped", config: configFor(spec(), MOUNTS) }];
      await expect(p.inspect()).resolves.toEqual({ state: "ok", status: "stopped" });
      expect(sdk.log.filter((l) => MUTATING.test(l))).toEqual([]);
      expect(sdk.creates).toBe(0);
    });
  });
});
