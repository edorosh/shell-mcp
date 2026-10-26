// v3 spike: the microsandbox SDK create API. Usage:
//   node spike/v3-create.mjs create <name> <hostDir>
//   node spike/v3-create.mjs config <name>
//   node spike/v3-create.mjs build <name> <hostDir>
//   node spike/v3-create.mjs net <name>
//   node spike/v3-create.mjs stop|start|remove <name>
// Prints `### label: json` lines. Run from a clone with `npm ci` done (SDK from node_modules).
// `create` exits WITHOUT stopping or disposing the sandbox on purpose: that is what it tests.
import { readFileSync } from "node:fs";

const [cmd, name, hostDir] = process.argv.slice(2);
const usage = "usage: node spike/v3-create.mjs <create|config|build|net|stop|start|remove> <name> [hostDir]";
if (!cmd || !name || ((cmd === "create" || cmd === "build") && !hostDir)) {
  console.error(usage);
  process.exit(2);
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
if (!sdk) process.exit(1);
const { Sandbox, Rule, Destination } = sdk;

const policy = {
  defaultEgress: "deny",
  defaultIngress: "deny",
  rules: [Rule.allowDns(), Rule.allowEgress(Destination.domain("example.com"))],
};
// The brief said policyJson(JSON.stringify(policy)), but the typed Rule/Destination values use
// {kind:"domain"} and the native policyJson parser rejects that (it wants {domain:"..."}).
// So create uses .policy(policy) (typed objects). `build` also tries policyJson to record the result.
const makeBuilder = (viaJson = false) =>
  Sandbox.builder(name)
    .image("ubuntu:24.04")
    .pullPolicy("if-missing")
    .volume("/workspace", (m) => m.bind(hostDir))
    .network((n) => (viaJson ? n.policyJson(JSON.stringify(policy)) : n.policy(policy)))
    .cpus(1)
    .memory(1024)
    .detached(true);

const commands = {
  async create() {
    show("create policy", policy);
    const t0 = Date.now();
    const pc = await makeBuilder().createWithPullProgress();
    show("create started", { ms: Date.now() - t0 });
    try {
      for await (const ev of pc) console.log(`### progress ${new Date().toISOString()} +${Date.now() - t0}ms: ${JSON.stringify(ev)}`);
    } catch (e) {
      show("create progress loop threw", errInfo(e));
    }
    const sb = await pc.awaitSandbox();
    show("create done", { ms: Date.now() - t0, name: sb.name, ownsLifecycle: sb.ownsLifecycle, className: sb.constructor?.name });
    show("create exiting", "process.exit(0) now, without stop/dispose/detach; run `msb ls` next");
    process.exit(0);
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
    show("build policy", policy);
    show("build .build() with .policy(policy)", await makeBuilder().build());
    await check("build policyJson", async () => {
      show("build .build() with .policyJson(JSON.stringify(policy))", await makeBuilder(true).build());
    });
  },
  async net() {
    const h = await Sandbox.get(name);
    show("net status", h.status);
    const sb = await h.connectWithTimeout(10_000);
    const probes = [["example.com", 443], ["www.iana.org", 443], ["192.168.1.1", 80]];
    for (const [host, port] of probes) {
      await check(`net ${host}:${port}`, async () => {
        const t0 = Date.now();
        const script = `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port}'`;
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
    process.exit(0);
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
  process.exit(2);
}
await check(cmd, commands[cmd]);
process.exit(0);
