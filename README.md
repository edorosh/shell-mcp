# shell-mcp

## What it is

An MCP server (stdio) that runs on your Windows host and executes shell commands
inside one existing microsandbox sandbox
instead of on the host. It exposes four tools: `shell` (foreground or background
commands with a timeout), `shell_output`, `shell_kill` and `shell_list`. Paths
are translated between the host project folder and the sandbox mount, and the
working directory is tracked across calls.

Status: v1, not published to npm. Windows hosts only; Linux and macOS hosts are
deferred. See [ROADMAP.md](ROADMAP.md).

## Status

The microsandbox SDK spike (`spike/`) and the integration suite
(`test/integration.test.ts`) have **not yet been run on a real host**. The unit
tests pass against a mocked backend only. Behaviors that depend on the real
SDK are listed under [Limitations](#limitations).

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

## Requirements

- Windows host.
- Node.js 22 or newer.
- The `msb` runtime at the version matching the pinned SDK. This repo pins
  `microsandbox` (npm SDK) at exactly **0.7.11**. The SDK and `msb` must match;
  the tested pair is recorded after the spike runs. At startup the server logs
  its own and the SDK version to stderr.
- A sandbox you have already created (shell-mcp never creates or starts one).
- `bash` installed in the sandbox image. The configured shell (default `bash`)
  is the only shell used, with no `sh` fallback.

## Install

shell-mcp is not published. Clone and build it:

```powershell
git clone <repo-url> C:\Users\eugen\dev\shell-mcp
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
| `--no-rewrite-output-paths` | `SHELL_MCP_REWRITE_OUTPUT_PATHS=0` | rewriting on |
| `--shell` | `SHELL_MCP_SHELL` | `bash` |

`--host-root` is normalized with `path.resolve` and must exist on disk. The
guest root must be an absolute POSIX path; a trailing `/` is stripped.

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

`node` needs no wrapper. If the server were ever launched via `npx` on native
Windows, Claude Code would need `"command": "cmd", "args": ["/c", "npx", ...]`;
that does not apply to the `node <clone>\dist\index.js` setup above.

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

Then, in the chat tool picker (or via tool sets), deselect the built-in
terminal tools so the agent can only run commands through shell-mcp.

## Client timeouts

TODO after manual check on the host.

Open question: does a 10-minute foreground call (`timeout_ms: 600000`) or a
background `sleep 700` probe get cut off by the client's own MCP tool timeout
(Claude Code: `MCP_TOOL_TIMEOUT`; Copilot: its own limit)? If so, what value of
`MCP_TOOL_TIMEOUT` is needed, and do progress notifications reset it? This
section will be filled in with the observed result. Until then, nothing is
promised about long-running calls.

## Verify

Ask the agent to run `uname -a`. It should report Linux (the sandbox kernel).
If it does not report Linux, the agent may still be using a built-in shell; if it fails, check that
the sandbox is running and reachable.

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
- Parallel calls run concurrently; the last to finish sets the working directory.
- Maintainer note (not a user-facing promise): timeout detection relies on the
  sandbox reporting exit code -1 when the SDK's deadline kills the shell. This
  comes from reading the SDK source and is to be confirmed by the spike.
- Maintainer note: the other SDK behaviors the backend assumes (error codes,
  cursor semantics, process-group kill, behavior on Windows) are likewise
  unconfirmed until the spike runs.
