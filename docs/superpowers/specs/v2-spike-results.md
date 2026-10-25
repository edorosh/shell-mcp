# shell-mcp v2 spike results (plan Task 2)

Date: 2026-10-25 · Host: Windows 11 x64, Node 24.20.0, npm 12.2.0, home-installed msb 0.7.11
· Package: `edorosh-shell-mcp-1.0.0.tgz` packed from the v2 branch (not yet published), run through
`npx -y --package=<tgz> shell-mcp`. Retires the risks in the [v2 design §3](2026-10-25-shell-mcp-v2-npm-design.md#3-risks-to-retire-first-task-2-on-the-users-windows-host).

## Setup finding

The user-level `~/.npmrc` had `os=linux`. With it, `npm ci` on Windows installed
`@typescript/typescript-linux-x64` and the build failed with "Unable to resolve
@typescript/typescript-win32-x64". The same setting would make an `npx` install of shell-mcp
fetch the Linux microsandbox package. Removing the line fixed it. The README gets a
troubleshooting entry (`npm config get os` should print nothing on Windows); `--check` reports
the case as a native-module failure.

## Risk 1: runtime origin and sandbox compatibility

| Case | `origin` | `msbPath` | version |
|---|---|---|---|
| Home install present | `home` | `C:\Users\eugen\.microsandbox\bin\msb.exe` | 0.7.11 |
| `MSB_HOME` pointed at an empty folder | `sdk_package` | `…\node_modules\@superradcompany\microsandbox-win32-x64-msvc\bin\msb.exe` | 0.7.11 |

- With `MSB_HOME` set to the empty folder, `npx -p microsandbox@0.7.11 msb create ubuntu:24.04 --name spike-pkg --mount-dir C:\temp\spike-ws:/workspace` created and started the sandbox (`create` starts it; a following `msb start` reports "already running").
- **Sandboxes belong to the runtime home that created them.** The packaged `msb` with the empty home listed only `spike-pkg`; the home-installed `msb` listed only `spike`.
- shell-mcp started from Claude Code with `"env": { "MSB_HOME": "C:\\temp\\msb-empty" }` reached `spike-pkg`: `uname -a` returned `Linux spike-pkg 6.12.113 … x86_64 GNU/Linux`.

**README consequence:** create the sandbox with the same `msb` and home that shell-mcp will use. Users
with a separate msb install keep using it (shell-mcp picks the home runtime). Users without one can
create sandboxes with `npx -y -p microsandbox@<sdk version> msb create …`, which uses the packaged runtime.

## Risk 2: launchers on native Windows

All eight forms started the server (4 tools listed):

| Form | Claude Code (`.mcp.json`) | VS Code (same file, new agent host) |
|---|---|---|
| `cmd /c npx -y …` | starts | starts |
| `npx -y …` | starts | starts |
| `shell-mcp` (global install) | starts | starts |
| `cmd /c shell-mcp` | starts | starts |

VS Code's new agent host reads the project's `.mcp.json` (`mcpServers` key), so one file serves both
clients. **README consequence:** keep `cmd /c npx` for Claude Code (what the Claude Code docs
prescribe on native Windows, and it works), `npx` for `.vscode/mcp.json`, and note that bare forms
also work in current versions.

## Risk 3: cold, warm and offline start

- Cold start (npm cache cleaned, `_npx` deleted): the server connected within the client's startup timeout; no timeout seen.
- Warm start: connected.
- **Offline (network off, warm cache): the `npx` form failed to start.** npx revalidates with the registry on each launch.
- Offline with the global install (`"command": "shell-mcp"`): connected instantly.
- Deleting `%LOCALAPPDATA%\npm-cache\_npx` fails with "access denied" on `microsandbox.win32-x64-msvc.node` while any shell-mcp process is running (Windows locks loaded DLLs). Close the clients first.

**README consequence:** warm-up step stays (cheap insurance); state that the `npx` form needs network
on every start and point offline or slow-network users at the global install.

## Risk 4: `${workspaceFolder}` in `.vscode/mcp.json`

Not substituted. The server got the literal string and exited: `shell-mcp: host-root must be an
absolute path: ${workspaceFolder}`. **README consequence:** the Copilot example uses a literal path,
like the Claude Code one.

## Risk 5: trusted publishing for a new package

Not possible before the package exists. npmjs.com shows no trusted-publisher settings for an
unpublished name, and the npm docs for `npm trust` say "The package you're configuring must already
exist on the npm registry." **Consequence:** publish 1.0.0 once by hand from a clean checkout of the
tag, then add the trusted publisher (web UI: package → Settings → Trusted publishing, or
`npm trust github @edorosh/shell-mcp --file release.yml --repo edorosh/shell-mcp --allow-publish`,
npm ≥ 11.15.0, 2FA on). CI publishes every later release.
