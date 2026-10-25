// Pre-publish check: the tarball holds exactly the right files and the
// installed bin starts through npm's shim. Plain Node, no dependencies.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isWin = process.platform === "win32";
const repo = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

class CheckFailed extends Error {}

function fail(msg) {
  throw new CheckFailed(msg);
}

function ok(msg) {
  console.log(`ok ${msg}`);
}
function check(cond, msg) {
  if (!cond) fail(msg);
  ok(msg);
}

// npm and npx are .cmd files on Windows, so they need a shell there. The shell gets one
// quoted command line (Node deprecates passing an args array with shell: true, DEP0190).
function run(cmd, args, cwd) {
  const quote = (a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a);
  const [file, argv] = isWin ? [[cmd, ...args].map(quote).join(" "), []] : [cmd, args];
  const r = spawnSync(file, argv, {
    cwd,
    encoding: "utf8",
    shell: isWin,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
  if (r.error) fail(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  return r;
}
function runOk(cmd, args, cwd) {
  const r = run(cmd, args, cwd);
  if (r.status !== 0) {
    fail(`${cmd} ${args.join(" ")} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

let failure;
const tmp = mkdtempSync(join(tmpdir(), "shell-mcp-pack-"));
try {
  const packDir = join(tmp, "pack");
  const projDir = join(tmp, "proj");
  mkdirSync(packDir);
  mkdirSync(projDir);

  const packed = runOk("npm", ["pack", "--json", "--pack-destination", packDir], repo);
  let info;
  try {
    // npm 10/11 print an array of results; npm 12 prints an object keyed by package name.
    const parsed = JSON.parse(packed.stdout);
    info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  } catch {}
  if (!info?.files) fail(`npm pack --json gave unexpected output:\n${packed.stdout}`);
  const paths = info.files.map((f) => f.path.replaceAll("\\", "/"));

  const required = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "dist/index.js"];
  for (const p of required) check(paths.includes(p), `tarball contains ${p}`);
  const allowed = new Set(["package.json", "README.md", "LICENSE", "CHANGELOG.md"]);
  const extra = paths.filter((p) => !allowed.has(p) && !p.startsWith("dist/"));
  check(extra.length === 0, `tarball has only dist/** and the four top-level files${extra.length ? ` (unexpected: ${extra.join(", ")})` : ""}`);

  runOk("npm", ["init", "-y"], projDir);
  runOk("npm", ["install", "--no-audit", "--no-fund", join(packDir, info.filename)], projDir);

  const installed = join(projDir, "node_modules", ...pkg.name.split("/"));
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  check(manifest.private === undefined, "packed package.json has no private");
  check(manifest.name === "@edorosh/shell-mcp", "packed name is @edorosh/shell-mcp");
  check(/^\d+\.\d+\.\d+$/.test(manifest.dependencies?.microsandbox ?? ""), `microsandbox is an exact version (${manifest.dependencies?.microsandbox})`);
  check(manifest.repository?.url === "git+https://github.com/edorosh/shell-mcp.git", "repository.url is git+https://github.com/edorosh/shell-mcp.git");
  const entry = readFileSync(join(installed, "dist", "index.js"), "utf8");
  check(entry.startsWith("#!/usr/bin/env node"), "dist/index.js starts with the node shebang");

  const sdk = pkg.dependencies.microsandbox;
  const launchers = [
    { name: "npx", cmd: "npx", args: ["--no-install", "shell-mcp"] },
    { name: "cmd shim", cmd: "cmd", args: ["/c", "node_modules\\.bin\\shell-mcp.cmd"], winOnly: true },
  ];
  for (const l of launchers) {
    if (l.winOnly && !isWin) {
      ok(`${l.name}: --version, --help and no-flag skipped (not Windows)`);
      continue;
    }
    const version = run(l.cmd, [...l.args, "--version"], projDir);
    check(version.status === 0, `${l.name}: --version exits 0`);
    check(version.stdout.trim() === `shell-mcp ${pkg.version} (microsandbox SDK ${sdk})`, `${l.name}: --version prints shell-mcp ${pkg.version} (microsandbox SDK ${sdk})`);
    const help = run(l.cmd, [...l.args, "--help"], projDir);
    check(help.status === 0, `${l.name}: --help exits 0`);
    check(help.stdout.includes("--sandbox"), `${l.name}: --help lists --sandbox`);
    const bare = run(l.cmd, l.args, projDir);
    check(bare.status === 1, `${l.name}: no-flag run exits 1 (got ${bare.status})`);
    check(bare.stdout === "", `${l.name}: no-flag run writes nothing to stdout`);
    check(/sandbox is required/i.test(bare.stderr), `${l.name}: no-flag run says on stderr that a sandbox is required`);
  }
} catch (e) {
  if (!(e instanceof CheckFailed)) throw e;
  failure = e;
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
if (failure) {
  console.error(`FAIL ${failure.message}`);
  process.exit(1);
}
