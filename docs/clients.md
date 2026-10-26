# Client setup

Each client gets two things: the shell-mcp server entry, and its built-in shell
turned off so the agent can only run commands through shell-mcp. The examples
use sandbox `myproj`, host folder `C:\Users\<you>\dev\myproj` (on a Mac,
`/Users/<you>/dev/myproj`) and guest path `/workspace` (see
[Sandbox and runtime](sandbox.md)).

## Claude Code

Put `.mcp.json` in your project (example: [examples/claude/.mcp.json](../examples/claude/.mcp.json)):

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "@edorosh/shell-mcp@1.1.0",
        "--sandbox", "myproj",
        "--host-root", "C:\\Users\\<you>\\dev\\myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

On macOS, use `npx` directly, with the host folder as a literal path. If
`~/dev` is a symlink, give the `pwd -P` path instead (see
[Sandbox and runtime](sandbox.md#macos)):

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "npx",
      "args": [
        "-y", "@edorosh/shell-mcp@1.1.0",
        "--sandbox", "myproj",
        "--host-root", "/Users/<you>/dev/myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

Or add it from the command line on Windows:

```powershell
claude mcp add sandbox --scope project -- cmd /c npx -y @edorosh/shell-mcp@1.1.0 --sandbox myproj --host-root C:\Users\<you>\dev\myproj --guest-root /workspace
```

`cmd /c` is what the Claude Code docs prescribe for `npx` on native Windows.
Bare `npx` (and `shell-mcp` after a global install) also start in current
Claude Code, and VS Code's newer agent host also reads the project `.mcp.json`,
so one file can serve both clients.

Turn off Claude Code's built-in shell in `.claude/settings.json` (example:
[examples/claude/.claude/settings.json](../examples/claude/.claude/settings.json)):

```json
{ "permissions": { "deny": ["Bash"] } }
```

## GitHub Copilot (VS Code)

Put `.vscode/mcp.json` in your project (example:
[examples/copilot/.vscode/mcp.json](../examples/copilot/.vscode/mcp.json)):

```json
{
  "servers": {
    "sandbox": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y", "@edorosh/shell-mcp@1.1.0",
        "--sandbox", "myproj",
        "--host-root", "C:\\Users\\<you>\\dev\\myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

On macOS the same file uses the host root `"/Users/<you>/dev/myproj"` (the
`pwd -P` path if `~/dev` is a symlink); the rest is unchanged.

Use a literal host path: VS Code does not substitute `${workspaceFolder}` in
`args` (shell-mcp would get the literal string and exit with "host-root must be
an absolute path").

### Turning off Copilot's built-in shell

What works depends on where Copilot runs. As of 2026-10-26 the Copilot harness
hook below is verified with shell-mcp on Windows (`deny-shell.ps1`) and macOS
(`deny-shell.sh`); the script is still untested on Linux, and so are the Local
harness and the Copilot CLI options.

**VS Code, Copilot harness (Agent Host):** the harness's built-in tools are
read-only in the Agent Customizations **Tools** tab, so the shell cannot be
deselected there, and approval settings such as `chat.tools.terminal.autoApprove`
only force a confirmation. Use a `preToolUse` hook instead; Copilot reads
repository hooks from `.github/hooks/*.json`. Copy
[examples/copilot/.github/hooks/](../examples/copilot/.github/hooks/) into your
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
`deny-shell.sh` was verified on macOS on 2026-10-26 in a Copilot harness
session: the built-in `bash` tool was denied (hook exit 2), and the agent then
ran a command through `sandbox-shell` and got Linux. It is still untested on
Linux; there it was only checked against sample payloads from the command line.

**VS Code, Local harness (untested):** in Agent mode, select **Configure Tools**
in the chat input and deselect the built-in terminal tools (the `execute`
group: `runInTerminal`, `getTerminalOutput`, `createAndRunTask`, ...). The
selection applies to the current request. To make it reusable, add a custom
agent with an explicit tools list, for example `.github/agents/sandbox.agent.md`,
and pick it in the agent dropdown. With a `tools` list, only those tools are
available:

```markdown
---
name: Sandbox
description: Coding agent whose commands run only in the shell-mcp sandbox
tools: ['read', 'edit', 'search', 'sandbox/*']
---
Run every command through the sandbox shell tools. Use the file tools with host paths.
```

References: [VS Code: use tools with agents](https://code.visualstudio.com/docs/agents/agent-tools),
[custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents),
[approvals](https://code.visualstudio.com/docs/agents/run/approvals),
[Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
[Copilot CLI: allowing tools](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools).

## Copilot CLI (untested)

Add the server with `/mcp add`, using the same command and arguments as the
VS Code example (`npx` with `-y @edorosh/shell-mcp@1.1.0 --sandbox ...`) and
the name `/mcp` shows. The CLI does not read `.vscode/mcp.json`. To deny the
built-in shell and allow shell-mcp per session (deny rules win over every allow
rule, including `--allow-all-tools`):

```powershell
copilot --deny-tool='shell' --allow-tool='sandbox'
```

These flags are not saved to a config file, so put them in a wrapper script.
Unverified on Windows: whether the CLI's PowerShell tool is also covered by
`shell`.

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
