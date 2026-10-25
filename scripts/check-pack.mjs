// Pre-publish check: the tarball holds exactly the right files and the
// installed bin starts through npm's shim. Plain Node, no dependencies.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isWin = process.platform === "win32";
const repo = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`ok ${msg}`);
}
function check(cond, msg) {
  if (!cond) fail(msg);
  ok(msg);
}

// npm and npx are .cmd files on Windows, so they need a shell there.
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
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

const tmp = mkdtempSync(join(tmpdir(), "shell-mcp-pack-"));
try {
  const packDir = join(tmp, "pack");
  const projDir = join(tmp, "proj");
  mkdirSync(packDir);
  mkdirSync(projDir);

  const packed = runOk("npm", ["pack", "--json", "--pack-destination", packDir], repo);
  let info;
  try {
    info = JSON.parse(packed.stdout)[0];
  } catch {
    fail(`npm pack --json gave unparseable output:\n${packed.stdout}`);
  }
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

  const version = runOk("npx", ["--no-install", "shell-mcp", "--version"], projDir);
  check(version.stdout.includes(pkg.version), `npx shell-mcp --version prints ${pkg.version}`);
  const help = run("npx", ["--no-install", "shell-mcp", "--help"], projDir);
  check(help.status === 0, "npx shell-mcp --help exits 0");

  if (isWin) {
    const cmd = run("cmd", ["/c", "node_modules\\.bin\\shell-mcp.cmd", "--version"], projDir);
    check(cmd.status === 0 && cmd.stdout.includes(pkg.version), "cmd /c shell-mcp.cmd --version works");
  } else {
    ok("cmd /c shell-mcp.cmd --version skipped (not Windows)");
  }

  const bare = run("npx", ["--no-install", "shell-mcp"], projDir);
  check(bare.status === 1, `no-flag run exits 1 (got ${bare.status})`);
  check(bare.stdout === "", "no-flag run writes nothing to stdout");
  check(/sandbox is required/i.test(bare.stderr), "no-flag run explains on stderr that a sandbox is required");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
