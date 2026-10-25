// Reproduces "sandbox stopped while a server process holds a connection" (acceptance criterion 10).
// Usage (PowerShell, from the repo root): node spike\stop-check.mjs <sandbox-name>
// It STOPS and then STARTS the named sandbox via `msb`. Use the throwaway spike sandbox.
import { execSync } from "node:child_process";

const name = process.argv[2];
if (!name) throw new Error("usage: node spike/stop-check.mjs <sandbox-name>");
const m = await import("microsandbox"); // resolved from spike/node_modules or the repo's node_modules

const show = (label, e) =>
  console.log(label, "| class:", e?.constructor?.name, "| code:", e?.code, "| message:", e?.message);
const step = async (label, fn) => {
  try {
    const v = await fn();
    console.log(label, "ok", v === undefined ? "" : JSON.stringify(v));
  } catch (e) {
    show(label + " FAILED", e);
  }
};

const h1 = await m.Sandbox.get(name);
const sb1 = await h1.connectWithTimeout(10_000);
await step("1 first shell (sandbox running)", async () => (await sb1.shell("echo hi")).stdout);

execSync(`msb stop ${name}`, { stdio: "inherit" });

let sb2;
await step("2 Sandbox.get after stop", async () => {
  const h2 = await m.Sandbox.get(name);
  console.log("   status after stop:", h2.status);
  sb2 = await h2.connectWithTimeout(10_000);
  return "connected";
});
if (sb2) await step("3 shell on the NEW connection", async () => (await sb2.shell("echo hi")).stdout);
await step("4 shell on the OLD connection", async () => (await sb1.shell("echo hi")).stdout);
await step("5 execStream on the old connection", async () => {
  const h = await sb1.execStreamWith("bash", (b) => b.args(["-c", "echo hi"]).stdinNull());
  const ev = await h.recv();
  return ev && ev.kind;
});

execSync(`msb start ${name}`, { stdio: "inherit" });
