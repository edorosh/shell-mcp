// v3 spike: the microsandbox SDK create API. Usage:
//   node spike/v3-create.mjs create <name> <hostDir> [--default-net]   (--default-net: no .network() call)
//   node spike/v3-create.mjs config <name>
//   node spike/v3-create.mjs build <name> <hostDir>
//   node spike/v3-create.mjs net <name> [host:port ...]   (extra targets, e.g. your router's LAN address)
//   node spike/v3-create.mjs stop|start|remove <name>
// Prints `### label: json` lines. Run from a clone with `npm ci` done (SDK from node_modules).
// `create` exits WITHOUT stopping or disposing the sandbox on purpose: that is what it tests.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const defaultNet = args.includes("--default-net");
const [cmd, name, hostDir, ...rest] = args.filter((a) => a !== "--default-net");
// Flush stdout before exiting. process.exit is kept on purpose: create must not dispose the sandbox.
const exit = (code) => process.stdout.write("", () => process.exit(code));
const usage = "usage: node spike/v3-create.mjs <create|config|build|net|stop|start|remove> <name> [hostDir]";
if (!cmd || !name || ((cmd === "create" || cmd === "build") && !hostDir)) {
  console.error(usage);
  exit(2);
}

const show = (label, value) =>
  console.log(`### ${label}: ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2)}`);
const errInfo = (e) => ({ class: e?.constructor?.name, name: e?.name, code: e?.code, message: e?.message });
async function check(label, fn) {
  try {
    await fn();
  } catch (e) {
    show(`${label} UNCAUGHT`, errInfo(e));
  }
}
const timed = async (label, fn) => {
  const t0 = Date.now();
  try {
    const v = await fn();
    show(label, { ok: true, ms: Date.now() - t0, ...(v ? { result: v } : {}) });
  } catch (e) {
    show(label, { ok: false, ms: Date.now() - t0, error: errInfo(e) });
  }
};

let sdk;
await check("0 load", async () => {
  sdk = await import("microsandbox");
  let sdkVersion;
  try {
    sdkVersion = JSON.parse(readFileSync(new URL("../node_modules/microsandbox/package.json", import.meta.url), "utf8")).version;
  } catch (e) {
    sdkVersion = `unknown (${e.message})`;
  }
  show("0 load", { ok: true, platform: process.platform, arch: process.arch, node: process.version, sdkVersion });
});
if (!sdk) exit(1);
const { Sandbox, Rule, Destination } = sdk;

const policy = {
  defaultEgress: "deny",
  defaultIngress: "deny",
  rules: [Rule.allowDns(), Rule.allowEgress(Destination.domain("example.com"))],
};
// The brief said policyJson(JSON.stringify(policy)), but the typed Rule/Destination values use
// {kind:"domain"} and the native policyJson parser rejects that (it wants {domain:"..."}).
// So create uses .policy(policy) (typed objects). `build` also tries policyJson to record the result.
const makeBuilder = (viaJson = false) => {
  const b = Sandbox.builder(name)
    .image("ubuntu:24.04")
    .pullPolicy("if-missing")
    .volume("/workspace", (m) => m.bind(hostDir))
    .cpus(1)
    .memory(1024)
    .detached(true);
  return defaultNet ? b : b.network((n) => (viaJson ? n.policyJson(JSON.stringify(policy)) : n.policy(policy)));
};

const commands = {
  async create() {
    show("create policy", defaultNet ? "none: --default-net, no .network() call" : policy);
    const t0 = Date.now();
    const pc = await makeBuilder().createWithPullProgress();
    show("create started", { ms: Date.now() - t0 });
    try {
      for await (const ev of pc) console.log(`### progress ${new Date().toISOString()} +${Date.now() - t0}ms: ${JSON.stringify(ev)}`);
    } catch (e) {
      show("create progress loop threw", errInfo(e));
    }
    let sb;
    try {
      sb = await pc.awaitSandbox();
    } catch (e) {
      show("create awaitSandbox threw", { ...errInfo(e), ms: Date.now() - t0 });
      exit(1);
      return;
    }
    show("create done", { ms: Date.now() - t0, name: sb.name, ownsLifecycle: sb.ownsLifecycle, className: sb.constructor?.name });
    show("create exiting", "process.exit(0) now (stdout flushed first), without stop/dispose/detach; run `msb ls` next");
    exit(0);
  },
  async config() {
    const h = await Sandbox.get(name);
    show("config status", h.status);
    show("config handle keys", Object.keys(h));
    let parsed;
    try { parsed = JSON.parse(h.configJson); } catch { parsed = "(not JSON)"; }
    show("config configJson (raw string)", h.configJson);
    show("config configJson (parsed)", parsed);
    show("config config()", h.config());
  },
  async build() {
    show("build policy", defaultNet ? "none: --default-net, no .network() call" : policy);
    show(defaultNet ? "build .build() with no .network() call" : "build .build() with .policy(policy)", await makeBuilder().build());
    await check("build policyJson", async () => {
      show("build .build() with .policyJson(JSON.stringify(policy))", await makeBuilder(true).build());
    });
  },
  async net() {
    const t0 = Date.now();
    const h = await Sandbox.get(name);
    const tGet = Date.now() - t0;
    show("net status", h.status);
    const sb = await h.connectWithTimeout(10_000);
    show("net reuse timing", { getMs: tGet, connectMs: Date.now() - t0 - tGet, getPlusConnectMs: Date.now() - t0 });
    // A TCP connect alone can succeed against the sandbox's own network stack, so each probe also
    // sends an HTTP request and reports the reply's first bytes: `reply` non-empty = really reached.
    const extra = [hostDir, ...rest].filter(Boolean).map((t) => [t.slice(0, t.lastIndexOf(":")), Number(t.slice(t.lastIndexOf(":") + 1))]);
    const probes = [["example.com", 80], ["www.iana.org", 80], ["192.168.1.1", 80], ["10.0.0.1", 80], ...extra];
    for (const [host, port] of probes) {
      await check(`net ${host}:${port}`, async () => {
        const t0 = Date.now();
        const req = `HEAD / HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n`;
        const script = `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port} && echo connected && printf "${req}" >&3 && echo "reply: $(head -c 40 <&3 | tr -d "\\r\\n")"'`;
        const eh = await sb.execStreamWith("bash", (b) => b.args(["-c", script]).timeout(15_000).stdinNull());
        const out = await eh.collect();
        show(`net ${host}:${port}`, { code: out.code, success: out.success, stdout: out.stdout(), stderr: out.stderr(), ms: Date.now() - t0 });
      });
    }
  },
  async stop() {
    const h = await Sandbox.get(name);
    show("stop status before", h.status);
    await timed("stop", () => h.stop());
    show("stop status after", (await Sandbox.get(name)).status);
  },
  async start() {
    await timed("start (Sandbox.startDetached)", async () => {
      const sb = await Sandbox.startDetached(name);
      return { name: sb.name, ownsLifecycle: sb.ownsLifecycle };
    });
    show("start status after", (await Sandbox.get(name)).status);
    exit(0);
  },
  async remove() {
    await timed("remove (Sandbox.remove)", () => Sandbox.remove(name));
    try {
      const h = await Sandbox.get(name);
      show("remove: get still finds it", { status: h.status });
    } catch (e) {
      show("remove: get after remove", errInfo(e));
    }
  },
};

if (!commands[cmd]) {
  console.error(usage);
  exit(2);
}
await check(cmd, commands[cmd]);
exit(0);
