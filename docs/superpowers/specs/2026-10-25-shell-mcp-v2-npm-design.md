# shell-mcp v2 — npm Distribution Design

Date: 2026-10-25 · Milestone: [ROADMAP v2](../../../ROADMAP.md#v2-npm-package-for-easy-install-on-windows)
· Builds on: [v1 design](2026-10-25-shell-mcp-design.md), [product spec](../../product-spec.md)

v1 behavior is unchanged. This document records how shell-mcp is packaged,
published, launched and checked so that a Windows user can go from nothing to
a working client config without cloning or building the repo. Requirement IDs
(C9, I2, ...) refer to the product spec.

## 1. Decisions

| Area | Decision | Who decided |
|------|----------|-------------|
| Package name | `@edorosh/shell-mcp`, public, under the user's own npm scope. The unscoped `shell-mcp` belongs to an unrelated package, so `npx shell-mcp` must never appear anywhere | User (roadmap) |
| Bin name | `shell-mcp` (unchanged), pointing at `dist/index.js` | Claude's call |
| First version | `1.0.0`. The tool interface and flags shipped in v1 are what users depend on; semver from here. The milestone name (v2) and the package version are unrelated | Claude's call |
| Launch form | `npx -y @edorosh/shell-mcp@<exact version> ...` in every example. Global install (`npm i -g`) is the documented alternative | User (roadmap), version pin is Claude's call |
| Version pinning in client configs | Examples pin an exact version, never `@latest` or a range. The SDK and the `msb` runtime must match (v1 design §2 risk 2), so an unattended upgrade can break a working setup. A pinned spec is also served from the npx cache without a registry round trip, which keeps client startup fast and works offline | Claude's call |
| `microsandbox` SDK | Stays an exact pin (no `^`). A new SDK version is a new shell-mcp release, with the matching `msb` version in the changelog | Roadmap |
| Runtime check | At startup, resolve the `msb` runtime the SDK will use (`resolveRuntime()`) and read its version (`resolveRuntimeVersion()`), log both to stderr, and warn on a mismatch with the SDK version. Never exit on a mismatch (C7) | Claude's call |
| New CLI modes | `--version`, `--help`, and `--check` (validate config, runtime and sandbox, then exit). See §4 | Claude's call |
| `os` field | Not set. v1 supports Windows only (N6), but `"os": ["win32"]` would block the Linux CI smoke test and any later Linux support. The README states the supported host | Claude's call |
| Release | GitHub Actions on a `v*.*.*` tag: typecheck, build, test, publish with npm trusted publishing (OIDC, no stored token) and provenance | Roadmap, mechanism is Claude's call |
| Changelog | `CHANGELOG.md`, Keep a Changelog format. Every release entry names the pinned SDK and the tested `msb` version | Roadmap |
| License | MIT, with a `LICENSE` file at the repo root (the repo had none, and npm needs one to publish) | User |

## 2. Findings that shape the design

Checked against the npm registry on 2026-10-25 for `microsandbox@0.7.11`.

1. **No install scripts.** `microsandbox` and its platform packages have no
   `preinstall`/`postinstall`. The native code comes from
   `optionalDependencies` (`@superradcompany/microsandbox-win32-x64-msvc` and
   four others), so npm picks the right one at install time. A consumer
   install never builds anything. Installs with `--omit=optional`, or copied
   across platforms, lack the native module; `--check` reports that.
2. **The platform package bundles the runtime.**
   `microsandbox-win32-x64-msvc@0.7.11` contains `bin/msb.exe` (47 MB),
   `lib/libkrunfw.dll` (22 MB) and the `.node` addon (36 MB): 44.5 MB
   compressed, 105 MB unpacked. So installing shell-mcp also installs an
   `msb` that matches the SDK exactly.
3. **Runtime resolution order.** The SDK picks the runtime in this order:
   `MSB_PATH` (with `MSB_LIBKRUNFW_PATH`), then `paths.msb` in
   `~/.microsandbox/config.json`, then `~/.microsandbox/bin/msb.exe` (a user
   install), and only then the copy in the platform package. A user who
   installed `msb` separately therefore keeps using their own runtime, and a
   mismatch with the SDK is possible. That is why the runtime check exists.
4. **The SDK can report the runtime without running it.** `resolveRuntime()`
   returns `{ msbPath, libkrunfwPath, origin }` (`origin` is one of
   `environment`, `sdk_package`, `configuration`, `home`, `installed`) and
   `resolveRuntimeVersion(msbPath)` reads the version embedded in the
   executable. Neither spawns a process, so the check stays inside the "no
   `child_process` in `src/`" rule (X1, `test/no-host-exec.test.ts`).
5. **First launch downloads about 45 MB.** On a cold npx cache, the first
   client start fetches the platform package. That can exceed a client's
   server-startup timeout (Claude Code's `MCP_TIMEOUT`). The README tells the
   user to warm the cache once from a terminal (§5).

## 3. Risks to retire first (Task 2, on the user's Windows host)

1. **Runtime origin and sandbox compatibility.** With no separate `msb`
   installed, does a sandbox created by the packaged `msb.exe`
   (`npx -y -p microsandbox@0.7.11 msb create ...`) work with shell-mcp? With
   a home install present, does `resolveRuntime()` report `origin: "home"` and
   the right version? If sandboxes are tied to the runtime that created them,
   the README must say which `msb` to create them with.
2. **Launchers on native Windows.** Which `command` forms start the server:
   - Claude Code: `"command": "cmd", "args": ["/c", "npx", "-y", ...]` is what
     the Claude Code docs require for npx on native Windows. Confirm, and
     confirm that bare `"command": "npx"` fails, so the README states the rule
     from evidence.
   - VS Code Copilot: `"command": "npx"` (VS Code's own docs use it). If it
     fails, use the `cmd /c` form there too.
   - Global install: `"command": "shell-mcp"` and `cmd /c shell-mcp`. npm
     creates `shell-mcp.cmd` and `shell-mcp.ps1` shims, and a launcher that
     spawns without a shell may not resolve `.cmd`.
3. **Cold-start timeout.** With an empty npx cache, does the first client
   start succeed or time out? This decides how strongly the README insists on
   the warm-up step.
4. **`${workspaceFolder}` in `.vscode/mcp.json` args.** If VS Code substitutes
   it in `args`, the Copilot example uses `--host-root ${workspaceFolder}` and
   becomes copy-paste portable. Claude Code expands `${VAR}` from the
   environment only, so its example keeps a literal path.
5. **Trusted publishing for a new package.** Confirm on npmjs.com whether a
   trusted publisher can be configured before the package exists. If not,
   the user publishes `1.0.0` once by hand from a clean checkout
   (`npm publish --access public`), then configures trusted publishing, and
   CI publishes every later release.

## 4. Command line

The MCP mode (no mode flag) is unchanged. Three new flags, parsed in
`config.ts` alongside the existing ones:

| Flag | Behavior | Exit |
|------|----------|------|
| `--version` | Print `shell-mcp <version> (microsandbox SDK <version>)` to stdout | 0 |
| `--help` | Print usage: the flag table from the README, the env fallbacks, and a link to the README. stdout | 0 |
| `--check` | Requires the normal config. Runs the checks below and prints one line per check to stdout, `ok` or `FAIL` plus a hint | 0 if all pass, 1 otherwise |

`--version` and `--help` need no other flags and win over a config error.
They write to stdout because no MCP session exists. C9 gets a matching
carve-out (Task 6): stdout carries only MCP messages *while serving MCP*.

`--check` steps, in order, stopping at the first failure that makes the rest
meaningless:

1. **Config** valid (same validation as MCP mode, C6).
2. **Native module** loads (`import("microsandbox")`). Failure hint: reinstall
   without `--omit=optional`, on the same OS and CPU.
3. **Runtime** resolves: print `origin`, `msbPath` and version. A version
   different from the SDK's is a `FAIL` with the hint "install msb
   <sdk version> or remove the home install so the packaged runtime is used".
   (In MCP mode the same condition is only a stderr warning.)
4. **Sandbox** reachable and running, using the backend's existing connect
   path and error wording (E3, hint `msb start <name>`).
5. **Shell** runs: `uname -s` through `Backend.run` returns `Linux`, exit 0.
6. **Mount** matches: list the guest root (`ls -A1` through `Backend.run`) and
   the host root (`fs.readdir`), and pass if the two name sets are equal. An
   empty host root passes with a note, since it proves nothing. Read-only; no
   files are written on either side.

`--check` is what the README's "Verify" section runs first, before the agent
is asked to run `uname -a` (I5). It reuses `parseConfig`, the
`MicrosandboxBackend` and the path mapper; only the step runner and its
output are new (`src/check.ts`).

### Startup runtime log (MCP mode)

After the existing `version ..., microsandbox SDK ...` line, `index.ts` logs
`runtime msb <version> from <origin> (<msbPath>)` to stderr. On a mismatch it
adds `warning: msb <x> does not match SDK <y>; run shell-mcp --check`. A
failure to resolve the runtime is logged and does not stop the server (C7):
tool calls report the backend error as today.

## 5. Package and launch

`package.json` changes:

```jsonc
{
  "name": "@edorosh/shell-mcp",
  "version": "1.0.0",
  // "private": true removed
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/edorosh/shell-mcp.git" },
  "homepage": "https://github.com/edorosh/shell-mcp#readme",
  "bugs": "https://github.com/edorosh/shell-mcp/issues",
  "keywords": ["mcp", "model-context-protocol", "sandbox", "microsandbox", "shell", "windows"],
  "bin": { "shell-mcp": "dist/index.js" },
  "files": ["dist"],                     // README, LICENSE, CHANGELOG and package.json are always included
  "publishConfig": { "access": "public", "provenance": true },
  "scripts": { "prepack": "npm run build", ... }
}
```

- `repository.url` must match the GitHub repo exactly, or provenance fails.
- `prepack` builds before both `npm pack` and `npm publish`, so a stale or
  missing `dist/` cannot be published.
- `dist/` holds only compiled `src/` (tests are outside `tsconfig.json`'s
  include). The pack test (§6) pins the file list.
- No `npm-shrinkwrap.json`: consumers resolve `@modelcontextprotocol/sdk`
  and `zod` within their ranges, and `microsandbox` is exact anyway.

### Client config (README and `examples/`)

Claude Code, `.mcp.json`:

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "@edorosh/shell-mcp@1.0.0",
        "--sandbox", "myproj",
        "--host-root", "C:\\Users\\eugen\\dev\\myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

or `claude mcp add sandbox --scope project -- cmd /c npx -y @edorosh/shell-mcp@1.0.0 --sandbox myproj --host-root C:\Users\eugen\dev\myproj --guest-root /workspace`.

GitHub Copilot, `.vscode/mcp.json` (the `${workspaceFolder}` form only if
risk 4 confirms it):

```json
{
  "servers": {
    "sandbox": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y", "@edorosh/shell-mcp@1.0.0",
        "--sandbox", "myproj",
        "--host-root", "${workspaceFolder}",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

Copilot CLI: `/mcp add` with the same command and args.

README install flow, in order:

1. Requirements: Windows x64 or arm64, Node.js 22+, a running sandbox with
   `bash` (I4).
2. Warm the cache and confirm the package runs:
   `npx -y @edorosh/shell-mcp@1.0.0 --version`.
3. Create the sandbox (I1), with the `msb` that risk 1 says to use.
4. `npx -y @edorosh/shell-mcp@1.0.0 --sandbox myproj --host-root ... --guest-root /workspace --check`.
5. Paste the client config (I2) and turn off the built-in shell (I3, as in v1).
6. Ask the agent to run `uname -a` (I5).

Global install is a short alternative section (`npm i -g
@edorosh/shell-mcp@1.0.0`, then `shell-mcp` as the command, wrapped per
risk 2). Building from source moves to a "Development" section. The warning
against `npx shell-mcp` stays, next to the install step.

**Upgrading:** change the version in the client config (and run `--check`).
The README says so, and that the changelog lists the `msb` version each
release expects.

## 6. CI and release

`ci.yml` (pull requests), two jobs:

- **test**, matrix `ubuntu-latest` and `windows-latest`: `npm ci`,
  typecheck, build, unit tests. Windows CI is new; it catches path and shim
  issues the Linux job cannot. No `msb` in CI, so the integration suite stays
  manual.
- **pack**, `windows-latest`: `npm pack`, install the tarball into an empty
  temp project, then run the installed bin through both `npx --no-install
  shell-mcp` and `cmd /c` to check that the npm shim works on Windows:
  `--version` (exit 0, prints the package version), `--help` (exit 0), and
  no flags (exit 1 with the "sandbox is required" message on stderr and
  nothing on stdout). A script (`scripts/check-pack.mjs`) asserts the packed
  file list (`dist/**`, `package.json`, `README.md`, `LICENSE`,
  `CHANGELOG.md` and nothing else), that `dist/index.js` starts with
  `#!/usr/bin/env node`, that `private` is absent and that `microsandbox` is
  an exact version.

`release.yml` (push of a tag `v*.*.*`), one job on `ubuntu-latest` with
`permissions: { contents: write, id-token: write }` (write for the GitHub release):

1. Checkout, `setup-node` with Node 24 and the npm registry URL. Trusted
   publishing needs npm 11.5.1 or newer, so the job runs
   `npm install -g npm@^11.5.1` if the bundled npm is older.
2. Fail unless the tag equals `v` + `package.json` `version`, and unless
   `CHANGELOG.md` has a section for that version.
3. `npm ci`, typecheck, test, then the same pack check as CI.
4. `npm publish` (access and provenance come from `publishConfig`).
5. Create a GitHub release from the changelog section.

No `NPM_TOKEN` secret exists. The user configures the trusted publisher on
npmjs.com once (repo `edorosh/shell-mcp`, workflow `release.yml`). Release
steps for the maintainer go in `docs/releasing.md`: bump the version with
`npm version <x.y.z> --no-git-tag-version`, add the changelog entry, merge,
tag `vX.Y.Z` on `main`, push the tag.

## 7. Testing

- **Unit:** `--version`/`--help` parsing and precedence over config errors;
  each `--check` step against the fake backend (pass, fail, hint text,
  stop-after-failure); the mount comparison (equal, differing, empty host
  root); the runtime-mismatch message, with `resolveRuntime` and
  `resolveRuntimeVersion` injected so tests need no native module.
- **Pack:** `scripts/check-pack.mjs`, in CI on Windows (§6).
- **Manual on the user's host (Task 10):** install from the published package
  (or the packed tarball before the first publish) on a machine without the
  repo, then one Claude Code and one Copilot session through the npx config.
  `--check` passes, and `uname -a` in the agent reports Linux.

## 8. Left to the builder

- Exact `--help` text and `--check` line format.
- Whether `--check` also prints the resolved config (it must not print
  environment variables beyond the `SHELL_MCP_*` ones).
- Whether the GitHub release step uses `gh` or an action.

## 9. Out of scope

- Linux and macOS hosts (N6). The package installs there, but the README
  says Windows only.
- Changing any tool, flag or default from v1.
- Creating or starting sandboxes from shell-mcp (N1).
