# shell-mcp

## What it is

An MCP server (stdio) that runs on your Windows host and executes shell commands
inside one existing microsandbox sandbox
instead of on the host. It exposes four tools: `shell` (foreground or background
commands with a timeout), `shell_output`, `shell_kill` and `shell_list`. Paths
are translated between the host project folder and the sandbox mount, and the
working directory is tracked across calls.

v1, Windows hosts only, not published to npm; see [Status](#status).

## Requirements

- Windows host.
- Node.js 22 or newer.
- The `msb` runtime at the version matching the pinned SDK. This repo pins
  `microsandbox` (npm SDK) at exactly **0.7.11**. The SDK and `msb` must match;
  the tested pair is **`microsandbox` 0.7.11 with `msb` 0.7.11** on Windows (see
  [spike-results.md](docs/superpowers/specs/spike-results.md)). At startup the server logs
  its own and the SDK version to stderr.
- A sandbox you have already created (shell-mcp never creates or starts one).
- `bash` installed in the sandbox image. The configured shell (default `bash`)
  is the only shell used, with no `sh` fallback.

## Install

shell-mcp is not published. Clone this repository and build it:

```powershell
# clone this repository to C:\Users\eugen\dev\shell-mcp, then:
cd C:\Users\eugen\dev\shell-mcp
npm ci
npm run build
```

The server is then `node <clone>\dist\index.js`, for example
`node C:\Users\eugen\dev\shell-mcp\dist\index.js`.

**Do not use `npx shell-mcp`.** The npm name `shell-mcp` belongs to an unrelated package.

## Creating a sandbox

Create a sandbox with your project folder mounted, using an image that contains
`bash`:

```powershell
msb create <image> --name myproj --mount-dir C:\Users\eugen\dev\myproj:/workspace
```

Then make sure it is running (`msb start myproj`, if `create` did not start it).
The values to give shell-mcp are the sandbox name (`myproj`), the host folder
(`C:\Users\eugen\dev\myproj`) and the guest path (`/workspace`). If the
sandbox is stopped, `shell` returns a tool error; start it and the next call
works.

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

`--host-root` must be an absolute path. It is normalized (`path.win32.normalize`:
`/` becomes `\`, `.` and `..` segments are collapsed), a trailing separator is
stripped, and it must exist on disk. The guest root must be an absolute POSIX
path; a trailing `/` is stripped.

Path rewriting is turned off only by `--no-rewrite-output-paths` or by
`SHELL_MCP_REWRITE_OUTPUT_PATHS` set to `0`, `false` or `no` (any case). Any
other value leaves it on; the flag wins over the variable.

## Claude Code

Put `.mcp.json` in your project (example: [examples/claude/.mcp.json](examples/claude/.mcp.json)):

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "node",
      "args": [
        "C:\\Users\\eugen\\dev\\shell-mcp\\dist\\index.js",
        "--sandbox", "myproj",
        "--host-root", "C:\\Users\\eugen\\dev\\myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

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
      "command": "node",
      "args": [
        "C:\\Users\\eugen\\dev\\shell-mcp\\dist\\index.js",
        "--sandbox", "myproj",
        "--host-root", "C:\\Users\\eugen\\dev\\myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

### Turning off Copilot's built-in shell

Copilot has no project-level equivalent of Claude Code's `deny` rule, and what
works depends on where Copilot runs. Status as of 2026-10-25; only the
`.vscode/mcp.json` setup above has been tested with shell-mcp.

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
deselected there, and the docs do not promise that custom agent `tools` lists
apply. Approval settings such as `chat.tools.terminal.autoApprove` only force a
confirmation; they do not block commands. The one documented way to block a
tool call is a `preToolUse` hook. Copilot reads repository hooks from
`.github/hooks/*.json`; its shell tools (`bash`, `powershell`) match the
Claude-style name `Bash`, and a command `preToolUse` hook that exits non-zero
denies the call. Untested sketch, `.github/hooks/deny-shell.json`:

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo Use the sandbox shell tool instead 1>&2 & exit 2" } ] }
    ]
  }
}
```

GitHub documents hooks for Copilot CLI and the cloud agent; whether the VS Code
Agent Host runs them is unconfirmed. Check by asking the agent to run
`uname -a` with its built-in shell: the call should be blocked.

**Copilot CLI:** deny the built-in shell and allow the shell-mcp server per
session (deny rules win over every allow rule, including `--allow-all-tools`):

```powershell
copilot --deny-tool='shell' --allow-tool='sandbox'
```

These flags are not saved to a config file, so put them in a wrapper script.
The CLI does not read `.vscode/mcp.json`; add the server with `/mcp add` using
the same command and arguments, and use the name `/mcp` shows. Unverified on
Windows: whether the CLI's PowerShell tool is also covered by `shell`.

References: [VS Code: use tools with agents](https://code.visualstudio.com/docs/agents/agent-tools),
[custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents),
[approvals](https://code.visualstudio.com/docs/agents/run/approvals),
[Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
[Copilot CLI: allowing tools](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools).

## Client timeouts

**GitHub Copilot (VS Code), checked on Windows on 2026-10-25:** foreground calls
up to the 600 s `max-timeout` were not cut off by the client. A `sleep 300` call
and a `sleep 540` call (`timeout_ms: 600000`) both completed and returned their
output. No client setting was changed. Copilot showed no progress indication while
waiting. Background jobs, `shell_output`, `shell_kill` and `shell_list` worked
as expected, including a `sleep 700` job that was killed with its process gone.

**Claude Code:** not checked yet. Claude Code's MCP tool timeout is set with the
`MCP_TOOL_TIMEOUT` environment variable (milliseconds). If long calls are cut
off, raise it above your `max-timeout`.

**Leave headroom under the timeout.** In the sandbox, `sleep` ran about 3% longer
than requested (90 s took 93 s, 300 s took 310 s, 540 s took 556 s), so
`sleep 590` with `timeout_ms: 600000` hit shell-mcp's own 600 s deadline. That
result is shell-mcp's `timed out after 600s (process killed)`, not a client
error. Give foreground commands a few percent of slack, or run anything long in
the background. To allow longer foreground calls, raise `--max-timeout` (for
example `--max-timeout 15m`), but no client has been checked beyond 600 s.

## Verify

Ask the agent to run `uname -a`. It should report Linux (the sandbox kernel).
If it does not report Linux, the agent may still be using a built-in shell; if it fails, check that
the sandbox is running and reachable.

## Troubleshooting

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
manual client check passed for GitHub Copilot (see [Client timeouts](#client-timeouts)); Claude Code is still to do. Behaviors that depend on the real
SDK are listed under [Limitations](#limitations). Linux and macOS hosts are
deferred; see [ROADMAP.md](ROADMAP.md).

To run them, in PowerShell, with a running sandbox:

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
