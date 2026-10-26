# shell-mcp

## What it is

An MCP server (stdio) that runs on your Windows host and executes shell commands
inside one existing microsandbox sandbox
instead of on the host. It exposes four tools: `shell` (foreground or background
commands with a timeout), `shell_output`, `shell_kill` and `shell_list`. Paths
are translated between the host project folder and the sandbox mount, and the
working directory is tracked across calls.

Published on npm as [`@edorosh/shell-mcp`](https://www.npmjs.com/package/@edorosh/shell-mcp).
Windows hosts only; see [Status](#status).

## Requirements

- Windows host (x64 or arm64).
- Node.js 22 or newer.
- A sandbox you have already created (shell-mcp never creates or starts one),
  with `bash` installed in its image. The configured shell (default `bash`) is
  the only shell used, with no `sh` fallback.
- A microsandbox runtime (`msb`) at the version matching the pinned SDK.
  `@edorosh/shell-mcp` 1.0.2 pins `microsandbox` (npm SDK) at exactly
  **0.7.11**; the tested pair is `microsandbox` 0.7.11 with `msb` 0.7.11 on
  Windows (see [spike-results.md](docs/superpowers/specs/spike-results.md)).
  shell-mcp uses the `msb` in your microsandbox home if you have one, and the
  runtime packaged with the SDK otherwise. A version mismatch is logged to
  stderr at startup and reported by `--check`; it never stops the server.

## Install

Nothing to clone or build. Warm the npx cache and confirm the package runs:

```powershell
npx -y @edorosh/shell-mcp@1.0.2 --version
```

**Do not use `npx shell-mcp`.** The npm name `shell-mcp` belongs to an unrelated
package; always use the scoped name `@edorosh/shell-mcp` with a version.

The client configs below run `npx -y @edorosh/shell-mcp@1.0.2 ...`. That form
contacts the npm registry on every start, so it does not start offline. To
start offline and instantly, use the [global install](#global-install).

## Creating a sandbox

A sandbox belongs to the `msb` runtime home that created it, so create it with
the same `msb` that shell-mcp will use. Use an image that contains `bash`, for
example `ubuntu:24.04`.

**You already have a separate `msb` install** (the `msb` in your microsandbox
home; shell-mcp uses it). Create the sandbox as usual. Its version must match
the SDK (0.7.11 for shell-mcp 1.0.2); `--check` verifies this.

```powershell
msb create ubuntu:24.04 --name myproj --mount-dir C:\Users\eugen\dev\myproj:/workspace
```

**You have no `msb` installed.** Use the runtime packaged with the SDK:

```powershell
npx -y -p microsandbox@0.7.11 msb create ubuntu:24.04 --name myproj --mount-dir C:\Users\eugen\dev\myproj:/workspace
```

`create` also starts the sandbox. If it is stopped later, start it with
`msb start myproj` (or the same `npx -y -p microsandbox@0.7.11 msb start myproj`);
until then `shell` returns a tool error, and the next call works once it runs.
The values to give shell-mcp are the sandbox name (`myproj`), the host folder
(`C:\Users\eugen\dev\myproj`) and the guest path (`/workspace`).

## Check

Run shell-mcp once with `--check` before configuring a client. It verifies the
native module, the runtime version, that the sandbox is reachable, that the
shell runs and that the host folder is mounted at the guest path:

```powershell
npx -y @edorosh/shell-mcp@1.0.2 --sandbox myproj --host-root C:\Users\eugen\dev\myproj --guest-root /workspace --check
```

## Claude Code

Put `.mcp.json` in your project (example: [examples/claude/.mcp.json](examples/claude/.mcp.json)):

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "@edorosh/shell-mcp@1.0.2",
        "--sandbox", "myproj",
        "--host-root", "C:\\Users\\eugen\\dev\\myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

Or add it from the command line:

```powershell
claude mcp add sandbox --scope project -- cmd /c npx -y @edorosh/shell-mcp@1.0.2 --sandbox myproj --host-root C:\Users\eugen\dev\myproj --guest-root /workspace
```

`cmd /c` is what the Claude Code docs prescribe for `npx` on native Windows.
Bare `npx` (and `shell-mcp` after a global install) also start in current
Claude Code, and VS Code's newer agent host also reads the project `.mcp.json`,
so one file can serve both clients.

Turn off Claude Code's built-in shell so the agent can only run commands through
shell-mcp, in `.claude/settings.json` (example:
[examples/claude/.claude/settings.json](examples/claude/.claude/settings.json)):

```json
{ "permissions": { "deny": ["Bash"] } }
```

## GitHub Copilot (VS Code)

Put `.vscode/mcp.json` in your project (example:
[examples/copilot/.vscode/mcp.json](examples/copilot/.vscode/mcp.json)):

```json
{
  "servers": {
    "sandbox": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y", "@edorosh/shell-mcp@1.0.2",
        "--sandbox", "myproj",
        "--host-root", "C:\\Users\\eugen\\dev\\myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

Use a literal host path: VS Code does not substitute `${workspaceFolder}` in
`args` (shell-mcp would get the literal string and exit with "host-root must be
an absolute path").

### Turning off Copilot's built-in shell

What works depends on where Copilot runs. As of 2026-10-25 the Copilot harness
hook below is verified with shell-mcp on Windows; its Linux/macOS script, the
Local harness and the Copilot CLI options are untested.

**VS Code, Local harness:** in Agent mode, select **Configure Tools** in the
chat input and deselect the built-in terminal tools (the `execute` group:
`runInTerminal`, `getTerminalOutput`, `createAndRunTask`, ...). The selection
applies to the current request. To make it reusable, add a custom agent with an
explicit tools list, for example `.github/agents/sandbox.agent.md`, and pick it
in the agent dropdown. With a `tools` list, only those tools are available:

```markdown
---
name: Sandbox
description: Coding agent whose commands run only in the shell-mcp sandbox
tools: ['read', 'edit', 'search', 'sandbox/*']
---
Run every command through the sandbox shell tools. Use the file tools with host paths.
```

**VS Code, Copilot harness (Agent Host):** the harness's built-in tools are
read-only in the Agent Customizations **Tools** tab, so the shell cannot be
deselected there, and approval settings such as `chat.tools.terminal.autoApprove`
only force a confirmation. Use a `preToolUse` hook instead; Copilot reads
repository hooks from `.github/hooks/*.json`. Copy
[examples/copilot/.github/hooks/](examples/copilot/.github/hooks/) into your
project (`deny-shell.json` plus `deny-shell.ps1` for Windows and
`deny-shell.sh` for Linux and macOS) and reload VS Code. Copilot runs the json's
`powershell` command on Windows and its `bash` command elsewhere. Both scripts
exit non-zero for the built-in shell tools (`powershell` on Windows, `bash`
elsewhere), which denies the call; every other tool, including shell-mcp's
(`sandbox-shell` and friends in the hook payload), passes. Input that cannot be
parsed is let through. `deny-shell.sh` uses `jq` when it is installed and falls
back to `sed` otherwise.

Verified on Windows on 2026-10-25 in a Copilot harness session: asked to use
its built-in terminal, the agent's two `powershell` calls were denied, and it
then ran `uname -a` through `sandbox-shell` and got Linux. The hook payload
carries `toolName` and `toolArgs`; to debug, add
`Add-Content "$env:TEMP\copilot-hook.log" $raw` after the first line of the
script and read the log (in `deny-shell.sh`, add
`printf '%s\n' "$raw" >> /tmp/copilot-hook.log` after the `raw=` line).
The Linux/macOS script is untested with Copilot; it was only checked against
sample payloads from the command line.

References: [VS Code: use tools with agents](https://code.visualstudio.com/docs/agents/agent-tools),
[custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents),
[approvals](https://code.visualstudio.com/docs/agents/run/approvals),
[Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
[Copilot CLI: allowing tools](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools).

## Copilot CLI

Add the server with `/mcp add`, using the same command and arguments as the
VS Code example (`npx` with `-y @edorosh/shell-mcp@1.0.2 --sandbox ...`) and
the name `/mcp` shows. The CLI does not read `.vscode/mcp.json`. To deny the
built-in shell and allow shell-mcp per session (deny rules win over every allow
rule, including `--allow-all-tools`):

```powershell
copilot --deny-tool='shell' --allow-tool='sandbox'
```

These flags are not saved to a config file, so put them in a wrapper script.
Unverified on Windows: whether the CLI's PowerShell tool is also covered by
`shell`.

## Upgrading

Change the version in the client config (for example `@edorosh/shell-mcp@1.0.2`)
and run `--check` with the new version. [CHANGELOG.md](CHANGELOG.md) lists the
`msb` version each release expects; if it changed, recreate or update `msb` to
match. Close running clients first (see
[Troubleshooting](#access-denied-when-clearing-the-npx-cache-or-upgrading)).

## Global install

```powershell
npm i -g @edorosh/shell-mcp@1.0.2
```

Then use `shell-mcp` as the command, with the same arguments as above and
without `npx -y @edorosh/shell-mcp@1.0.2`: in `.vscode/mcp.json`
`"command": "shell-mcp"`, and in Claude Code's `.mcp.json`
`"command": "cmd", "args": ["/c", "shell-mcp", "--sandbox", ...]`. The global
install starts instantly and works offline.

## Configuration

Flags win over environment variables.

| Flag | Env | Default |
|------|-----|---------|
| `--sandbox` | `SHELL_MCP_SANDBOX` | required |
| `--host-root` | `SHELL_MCP_HOST_ROOT` | required |
| `--guest-root` | `SHELL_MCP_GUEST_ROOT` | required |
| `--default-timeout` | `SHELL_MCP_DEFAULT_TIMEOUT` | `120s` |
| `--max-timeout` | `SHELL_MCP_MAX_TIMEOUT` | `600s` |
| `--max-output` | `SHELL_MCP_MAX_OUTPUT` | `30000` |
| `--no-rewrite-output-paths` | `SHELL_MCP_REWRITE_OUTPUT_PATHS=0` (or `false`, `no`) | rewriting on |
| `--shell` | `SHELL_MCP_SHELL` | `bash` |
| `--version` | none | prints the version and exits |
| `--help` | none | prints usage and exits |
| `--check` | none | verifies native module, runtime version, sandbox, shell and mount, then exits |

`--host-root` must be an absolute path. It is normalized (`path.win32.normalize`:
`/` becomes `\`, `.` and `..` segments are collapsed), a trailing separator is
stripped, and it must exist on disk. The guest root must be an absolute POSIX
path; a trailing `/` is stripped.

Path rewriting is turned off only by `--no-rewrite-output-paths` or by
`SHELL_MCP_REWRITE_OUTPUT_PATHS` set to `0`, `false` or `no` (any case). Any
other value leaves it on; the flag wins over the variable.

## Verify

Ask the agent to run `uname -a`. It should report Linux (the sandbox kernel).
If it does not report Linux, the agent may still be using a built-in shell; if it fails, check that
the sandbox is running and reachable.

## Client timeouts

**GitHub Copilot (VS Code), checked on Windows on 2026-10-25:** foreground calls
up to the 600 s `max-timeout` were not cut off by the client. A `sleep 300` call
and a `sleep 540` call (`timeout_ms: 600000`) both completed and returned their
output. No client setting was changed. Copilot showed no progress indication while
waiting. Background jobs, `shell_output`, `shell_kill` and `shell_list` worked
as expected, including a `sleep 700` job that was killed with its process gone.

**Claude Code, checked on Windows on 2026-10-25:** all steps passed with
`MCP_TOOL_TIMEOUT` unset. Calls longer than 120 s are not cut off: Claude Code
moves the still-open call to a background task ("still running after 120s ...
moved to the background") and the agent picks up the result when it completes.
`sleep 300` and `sleep 540` (`timeout_ms: 600000`) both finished with their
output. Such a background task does not survive exiting the Claude Code session.
No progress indication was shown beyond that one notice. If your Claude Code
version cuts long calls off instead, raise `MCP_TOOL_TIMEOUT` (milliseconds)
above your `max-timeout`.

**Leave headroom under the timeout.** In the sandbox, `sleep` ran about 3% longer
than requested (90 s took 93 s, 300 s took 310 s, 540 s took 556 s), so
`sleep 590` with `timeout_ms: 600000` hit shell-mcp's own 600 s deadline. That
result is shell-mcp's `timed out after 600s (process killed)`, not a client
error. Give foreground commands a few percent of slack, or run anything long in
the background. To allow longer foreground calls, raise `--max-timeout` (for
example `--max-timeout 15m`), but no client has been checked beyond 600 s.

## Troubleshooting

### Native module failure in `--check` on Windows

`npm config get os` must print nothing on Windows. An `os=linux` line in a
user or project `.npmrc` makes npm fetch the Linux binaries, and `--check`
reports it as a native-module failure. Fix it with:

```powershell
npm config delete os
```

Then re-run the `--check` command. If the Linux package is already cached,
clear the npx cache (see the next entry) before retrying.

### Access denied when clearing the npx cache or upgrading

Deleting `%LOCALAPPDATA%\npm-cache\_npx`, or an upgrade that replaces it, fails with
"access denied" on `microsandbox.win32-x64-msvc.node` while a client is
running shell-mcp (Windows locks loaded DLLs). Close the clients first.

A sandbox created with the packaged runtime (`npx -y -p microsandbox@… msb create`)
keeps `msb.exe` running from inside that npx cache or `node_modules` folder, so
`msb.exe` and `libkrunfw.dll` stay locked too. Stop the sandbox first
(`msb stop <name>` with the same runtime and `MSB_HOME`), or find the process with
`Get-Process msb | Select-Object Id, Path` and stop it.

## Limitations

- No interactive programs: stdin is closed for every command.
- Environment variables do not persist between calls (`export X=1` then
  `echo $X` prints an empty line). The working directory does persist.
- Background jobs are not listed after a server restart. Only jobs started by
  the running server instance are visible and killable.
- Output paths containing spaces are rewritten from guest to host only up to
  the first space.
- A user `trap ... EXIT` or `exec` in a command disables working-directory
  tracking for that call; the working directory stays as it was.
- A newline in a working-directory path is not supported.
- Job-output retention gaps are detected only when a read follows a cursor. If
  output was discarded before the first read of a job, that gap is not flagged.
- The `microsandbox` SDK and the `msb` runtime must be the same version; the
  SDK is pinned to 0.7.11 for that reason.
- The sandbox sees host-side changes to the mounted folder with a short delay. Right
  after a host-side delete of the current directory the guest may still resolve it
  (measured: still visible right after, gone after about 5 s), so the next call runs there
  instead of resetting to the workspace root; later calls reset normally.
- Parallel calls run concurrently; the last to finish sets the working directory.
- A command killed by a signal other than the timeout (for example `kill -9 $$`,
  or the out-of-memory killer) reports exit code -1, not 128+N: the sandbox
  does not pass the signal number through.
- If the sandbox never confirms the exit after a timeout kill, the result still
  says `timed out` and adds a note that the exit was not confirmed.
- Timeout detection relies on the sandbox reporting exit code -1 when the SDK's
  deadline kills the shell. The spike confirmed this on Windows with `msb` 0.7.11
  (output produced before the deadline is kept and the process group dies).
  shell-mcp's own kill half a second past the deadline is only a fallback.
- Not yet verified on a real host: the `output_gap` and `launch_unconfirmed` error
  paths.

## Status

The microsandbox SDK spike (`spike/`) has been run on Windows (results in
[spike-results.md](docs/superpowers/specs/spike-results.md)). The integration
suite (`test/integration.test.ts`) passes all 12 acceptance criteria against a real
sandbox on Windows (with `SHELL_MCP_IT_ALLOW_STOP=1`; see spike-results.md). The
manual client check passed for GitHub Copilot and Claude Code (see [Client timeouts](#client-timeouts)). Behaviors that depend on the real
SDK are listed under [Limitations](#limitations). Linux and macOS hosts are
deferred; see [ROADMAP.md](ROADMAP.md).

## Development

To work on shell-mcp itself, clone the repository and build it:

```powershell
cd C:\Users\eugen\dev\shell-mcp
npm ci
npm run build
```

The server is then `node C:\Users\eugen\dev\shell-mcp\dist\index.js`, with the same
flags as above.

To run the integration suite and the SDK spike, in PowerShell, with a running sandbox:

```powershell
# Integration suite (repo root)
$env:SHELL_MCP_IT_SANDBOX="myproj"; $env:SHELL_MCP_IT_HOST_ROOT="C:\Users\eugen\dev\myproj"; $env:SHELL_MCP_IT_GUEST_ROOT="/workspace"; npx vitest run test/integration.test.ts
```

Expected: 12 pass, or 11 pass and 1 skipped.

```powershell
# SDK spike (see spike\README.md)
mkdir C:\temp\spike-ws -Force
msb create <image> --name spike --mount-dir C:\temp\spike-ws:/workspace
msb start spike          # skip if create already starts it
msb --version
cd spike
npm install
node sdk-check.mjs spike *>&1 | Tee-Object -FilePath spike-output.txt

# Optional: probe a stopped sandbox too
msb create <image> --name spike-stopped
msb stop spike-stopped
$env:SPIKE_STOPPED = "spike-stopped"
node sdk-check.mjs spike *>&1 | Tee-Object -FilePath spike-output.txt
```

### `Unable to resolve @typescript/typescript-win32-x64` on `npm run build` or `npm run typecheck`

The project builds with TypeScript 7, which runs a compiler from a per-platform package
(`@typescript/typescript-<os>-<cpu>`). The lockfile lists all of them, and npm installs only
the one matching the machine. This error means `node_modules` contains a different platform's
package, for example `@typescript/typescript-linux-x64`. Check with:

```powershell
dir node_modules\@typescript
```

Typical causes: `node_modules` was installed on another OS (for example by copying a folder,
or from a Linux sandbox sharing the folder), or npm detected the wrong platform on your
machine. Fix it by reinstalling with the platform stated explicitly:

```powershell
Remove-Item -Recurse -Force node_modules
npm ci --os=win32 --cpu=x64
dir node_modules\@typescript     # should now list typescript-win32-x64
npm run build
```

If a plain `npm ci` keeps installing the wrong package, find out why npm thinks it is on
another platform:

```powershell
node -p "process.platform + ' ' + process.arch"      # expect: win32 x64
where.exe node                                       # a Windows install, not a WSL or Git Bash shim
npm config get os
npm config get cpu
Get-ChildItem Env: | Where-Object Name -like 'npm_config*'
Get-Content $HOME\.npmrc -ErrorAction SilentlyContinue
```

An `os` or `cpu` setting, an `npm_config_os`/`npm_config_cpu` variable, or an `.npmrc` line that
names `linux` is the override: remove it. As a last resort, pin the platform in your **user**
npm config (not in the repository, because Linux CI needs the default):

```powershell
npm config set os win32
npm config set cpu x64
```

The same wrong-platform install would also break the native `microsandbox` package, so fix it
before running the spike or the integration suite. Do not install dependencies in a folder that
a Linux sandbox shares with your Windows checkout; use a separate clone for each.

