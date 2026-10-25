// microsandbox SDK spike. Usage: node sdk-check.mjs <sandbox-name>
// Prints one labeled JSON line per check. Every check is wrapped so one failure
// does not stop the rest. Paste the complete output back.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const name = process.argv[2];
if (!name) {
  console.error("usage: node sdk-check.mjs <sandbox-name>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (d) => (d == null ? d : Buffer.from(d).toString("utf8"));
const show = (label, value) =>
  console.log(`### ${label}: ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2)}`);
const errInfo = (e) => ({
  class: e?.constructor?.name,
  name: e?.name,
  code: e?.code,
  jobId: e?.jobId,
  message: e?.message,
});
async function check(label, fn) {
  try {
    await fn();
  } catch (e) {
    show(`${label} UNCAUGHT`, errInfo(e));
  }
}
const evShape = (ev) =>
  ev == null
    ? { event: ev }
    : { kind: ev.kind, typeofData: typeof ev.data, isBuffer: Buffer.isBuffer(ev.data), isU8: ev.data instanceof Uint8Array,
        text: ev.data != null && typeof ev.data === "object" ? dec(ev.data) : undefined, code: ev.code, pid: ev.pid, keys: Object.keys(ev) };
function pgrep(pattern) {
  // Bracketed patterns are passed by the caller so the pgrep itself never matches.
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  } catch (e) {
    return null;
  }
}

let sdk;
let sdkVersion;
await check("0 load", async () => {
  sdk = await import("microsandbox");
  try {
    const req = createRequire(import.meta.url);
    sdkVersion = req("microsandbox/package.json").version;
  } catch {
    try {
      sdkVersion = JSON.parse((await import("node:fs")).readFileSync(new URL("./node_modules/microsandbox/package.json", import.meta.url), "utf8")).version;
    } catch (e) { sdkVersion = `unknown (${e.message})`; }
  }
  show("0 load", { ok: true, platform: process.platform, arch: process.arch, node: process.version, sdkVersion, exports: Object.keys(sdk).length });
});
if (!sdk) process.exit(1);
const { Sandbox } = sdk;

// pgrep inside the guest, via sb.shell
let sb;
const guestPgrep = async (pattern) => {
  const r = await sb.shell(`pgrep -f '${pattern}'; echo rc=$?`);
  return { stdout: r.stdout?.() ?? r.stdout, code: r.code ?? r.exitCode };
};

// 1. get + connect
let handle;
await check("1 get", async () => {
  handle = await Sandbox.get(name);
  show("1 get", { status: handle.status, keys: Object.keys(handle) });
  sb = await handle.connectWithTimeout(10_000);
  show("1 connectWithTimeout", { ok: true, className: sb?.constructor?.name });
});
if (!sb) {
  console.log("cannot connect; remaining checks need a running sandbox (6 still runs)");
}

// 2. shell uname
if (sb) await check("2 shell", async () => {
  const r = await sb.shell("uname -a");
  show("2 shell", { keys: Object.keys(r), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(r)),
    stdout: typeof r.stdout === "function" ? r.stdout() : r.stdout, code: r.code ?? r.exitCode, success: r.success });
});

// 3. execStream with timeout: partial output + process-group kill (S5)
const consume = async (handle, label, extra = {}) => {
  const events = [];
  let thrown;
  const t0 = Date.now();
  try {
    for (;;) {
      const ev = await handle.recv();
      events.push({ atMs: Date.now() - t0, ...evShape(ev) });
      if (ev == null) break;
    }
  } catch (e) { thrown = errInfo(e); }
  const exitedIdx = events.findIndex((e) => e.kind === "exited");
  const afterExited = exitedIdx >= 0 ? events.slice(exitedIdx + 1).filter((e) => e.event === undefined && (e.kind === "stdout" || e.kind === "stderr")) : [];
  show(label, {
    events, thrown, totalMs: Date.now() - t0,
    endedWithExited: exitedIdx >= 0,
    // Assumption 1: timed-out stream ends with `exited`, no ExecTimeoutError from recv, no output after exited.
    outputAfterExited: afterExited.length,
    nullOrUndefinedEvents: events.filter((e) => e.event === null || e.event === undefined).length,
    ...extra,
  });
};

if (sb) await check("3 timeout stream", async () => {
  const h = await sb.execStreamWith("bash", (b) => b.args(["-c", "echo a; echo b >&2; sleep 5; echo never"]).timeout(1000).stdinNull());
  await consume(h, "3 timeout stream events");
  await sleep(300);
  show("3 pgrep sleep 5 (host-side pgrep; may be unavailable on Windows)", { result: pgrep("sleep [5]") });
  show("3 pgrep sleep 5 (guest) -- must show rc=1 and no pid line", await guestPgrep("sleep [5]"));
});

// 3b. timed-out exec where sleep is a CHILD of the shell, exit code of the killed shell, and ExecTimeoutError via collect()
if (sb) await check("3b timeout exit code", async () => {
  const h = await sb.execStreamWith("bash", (b) => b.args(["-c", "sleep 30; echo never"]).timeout(1000).stdinNull());
  await consume(h, "3b timeout (sleep child) events");
  await sleep(300);
  show("3b guest pgrep sleep 3[0]  (must be rc=1)", await guestPgrep("sleep 3[0]"));
  // assumption: exit code is -1 on deadline kill. Check via collect() as well.
  try {
    const h2 = await sb.execStreamWith("bash", (b) => b.args(["-c", "sleep 30"]).timeout(1000).stdinNull());
    const c = await h2.collect();
    show("3b collect() did NOT reject", { keys: Object.keys(c), code: c.code ?? c.exitCode });
  } catch (e) {
    show("3b collect() rejected (expected ExecTimeoutError)", errInfo(e));
  }
});

// 3c. natural exit code, and spawn failure (assumption 2)
if (sb) await check("3c exit code", async () => {
  const h = await sb.execStreamWith("bash", (b) => b.args(["-c", "exit 3"]).timeout(5000).stdinNull());
  await consume(h, "3c exit 3 events");
});
if (sb) await check("3d bad shell", async () => {
  try {
    const h = await sb.execStreamWith("/no/such/shell", (b) => b.args(["-c", "echo hi"]).timeout(5000).stdinNull());
    await consume(h, "3d spawn failure events (what does a bad --shell produce?)");
  } catch (e) {
    show("3d spawn failure threw at execStreamWith", errInfo(e));
  }
});

// 4. detached job + logs
if (sb) await check("4 detached logs", async () => {
  const job = await sb.execDetachedWith("bash", (b) => b.args(["-c", "for i in 1 2 3; do echo t$i; sleep 1; done; echo err >&2"]).stdinNull());
  show("4 job", { id: job.id, className: job.constructor?.name });
  await sleep(1500);
  const l1 = await job.logs();
  show("4 logs() first", { count: l1.length, entries: l1.map((e) => ({ ...e, data: dec(e.data), isBuffer: Buffer.isBuffer(e.data), keys: Object.keys(e) })) });
  await sleep(2000);
  const last = l1.at(-1)?.cursor;
  const l2 = await job.logs({ fromCursor: last });
  // assumption 5: fromCursor is exclusive; sources are stdout/stderr
  show("4 logs({fromCursor}) -- exclusive? first entry must differ from the cursor", {
    cursor: last, count: l2.length, firstCursorEqualsGiven: l2[0]?.cursor === last,
    entries: l2.map((e) => ({ source: e.source, text: dec(e.data), cursor: e.cursor })),
  });
  const all = await job.logs();
  show("4 logs() all", { sources: [...new Set(all.map((e) => e.source))], texts: all.map((e) => dec(e.data)) });
  show("4 gap observability", {
    note: "JobLogEntry has no gap field; gaps only appear as {type:'gap'} from attach()/recv(). Keys seen on entries:",
    entryKeys: all[0] ? Object.keys(all[0]) : null,
  });
  // bogus cursor behaviour (assumption: output_gap error?)
  for (const c of ["0", "999999999", "garbage"]) {
    try {
      const r = await job.logs({ fromCursor: c });
      show(`4 logs({fromCursor:${JSON.stringify(c)}})`, { count: r.length, first: r[0] && { source: r[0].source, text: dec(r[0].data), cursor: r[0].cursor } });
    } catch (e) { show(`4 logs({fromCursor:${JSON.stringify(c)}}) threw`, errInfo(e)); }
  }
});

// 5. job kill: child dies, JobError codes
if (sb) await check("5 job kill", async () => {
  const job = await sb.execDetachedWith("bash", (b) => b.args(["-c", "sleep 100; true"]).stdinNull());
  await sleep(500);
  const before = await job.inspect();
  show("5 inspect before kill", before);
  await job.kill();
  let waited;
  try { waited = await job.wait(); } catch (e) { waited = { threw: errInfo(e) }; }
  show("5 wait() after kill", waited);
  show("5 inspect after kill", await job.inspect());
  await sleep(300);
  show("5 guest pgrep sleep 10[0]  (must be rc=1)", await guestPgrep("sleep 10[0]"));
  try { await job.kill(); show("5 second kill: did not throw", {}); }
  catch (e) { show("5 second kill on exited job (expect job_not_running)", errInfo(e)); }
  // unknown job id
  try { await sb.getJob("no-such-job-id"); show("5 getJob(missing): did not throw", {}); }
  catch (e) { show("5 getJob(missing) (expect job_not_found)", errInfo(e)); }
  // job that exits on its own: state and exit code
  const j2 = await sb.execDetachedWith("bash", (b) => b.args(["-c", "exit 7"]).stdinNull());
  await sleep(1000);
  show("5 natural exit 7 inspect", await j2.inspect());
});

// 5a. launch failure + states
if (sb) await check("5a states", async () => {
  const states = new Set();
  try {
    const job = await sb.execDetached("no-such-binary");
    for (let i = 0; i < 10; i++) {
      const info = await job.inspect();
      states.add(info.state);
      if (i === 0 || info.state === "failed" || info.state === "exited") show("5a inspect (no-such-binary)", info);
      if (info.state !== "starting" && info.state !== "running") break;
      await sleep(200);
    }
  } catch (e) { show("5a execDetached(no-such-binary) threw", errInfo(e)); }
  const ok = await sb.execDetachedWith("bash", (b) => b.args(["-c", "sleep 2"]).stdinNull());
  for (let i = 0; i < 15; i++) {
    const info = await ok.inspect();
    states.add(info.state);
    if (info.state === "exited" || info.state === "failed" || info.state === "lost") break;
    await sleep(200);
  }
  show("5a JobState values seen", [...states]);
});

// 6. error classes
await check("6 missing", async () => {
  try { const h = await Sandbox.get("does-not-exist"); show("6 get(does-not-exist) did not throw", { status: h.status }); }
  catch (e) { show("6 get(does-not-exist) (expect code sandboxNotFound)", errInfo(e)); }
});
await check("6 stopped", async () => {
  // Needs a stopped sandbox name in SPIKE_STOPPED (create one and `msb stop` it first), optional.
  const stopped = process.env.SPIKE_STOPPED;
  if (!stopped) { show("6 stopped sandbox", "skipped: set $env:SPIKE_STOPPED to a stopped sandbox name to probe"); return; }
  try {
    const h = await Sandbox.get(stopped);
    show("6 get(stopped).status", { status: h.status });
    try { await h.connectWithTimeout(3000); show("6 connectWithTimeout(stopped) did not throw", {}); }
    catch (e) { show("6 connectWithTimeout(stopped) error (connection-class? not-running?)", errInfo(e)); }
  } catch (e) { show("6 get(stopped) threw", errInfo(e)); }
});
// connectWithTimeout failure/timeout codes with a tiny timeout
if (handle) await check("6 tiny timeout", async () => {
  try { await handle.connectWithTimeout(1); show("6 connectWithTimeout(1) succeeded (fast path)", {}); }
  catch (e) { show("6 connectWithTimeout(1) error", errInfo(e)); }
});

// 7. versions
show("7 versions", { sdk: sdkVersion, node: process.version, platform: process.platform, msb: "run `msb --version` by hand and paste it" });
try {
  show("7 msb --version (auto)", execFileSync("msb", ["--version"], { encoding: "utf8" }).trim());
} catch (e) { show("7 msb --version (auto) failed", e.message); }
process.exit(0);
