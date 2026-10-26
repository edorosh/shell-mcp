# shell-mcp

An MCP server for Claude Code and GitHub Copilot that runs your agent's shell
commands inside a microsandbox
Linux sandbox instead of on your Windows machine. Your project folder is
mounted into the sandbox, so file tools keep working on the host while every
command runs in Linux.

It exposes four tools: `shell` (foreground or background commands with a
timeout), `shell_output`, `shell_kill` and `shell_list`. Paths are translated
between the host folder and the sandbox mount, and the working directory is
kept across calls.

Published on npm as [`@edorosh/shell-mcp`](https://www.npmjs.com/package/@edorosh/shell-mcp).

## Requirements

- Windows (x64 or arm64) with Node.js 22 or newer.
- A microsandbox sandbox with your project folder mounted and `bash` in its
  image. shell-mcp never creates or starts one.
- `msb` 0.7.11, matching the SDK that shell-mcp 1.0.2 pins. Without a separate
  install, the runtime packaged with the SDK is used.

## Quick start

**1. Create a sandbox** (here with the packaged runtime; see
[Sandbox and runtime](docs/sandbox.md) if you already have `msb`):

```powershell
npx -y -p microsandbox@0.7.11 msb create ubuntu:24.04 --name myproj --mount-dir C:\Users\<you>\dev\myproj:/workspace
```

**2. Check the setup:**

```powershell
npx -y @edorosh/shell-mcp@1.0.2 --sandbox myproj --host-root C:\Users\<you>\dev\myproj --guest-root /workspace --check
```

Always use the scoped name with a version. `npx shell-mcp` is an unrelated
package.

**3. Add it to your client.** Claude Code, in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "@edorosh/shell-mcp@1.0.2",
        "--sandbox", "myproj",
        "--host-root", "C:\\Users\\<you>\\dev\\myproj",
        "--guest-root", "/workspace"
      ]
    }
  }
}
```

and turn off the built-in shell in `.claude/settings.json`:

```json
{ "permissions": { "deny": ["Bash"] } }
```

For GitHub Copilot in VS Code (`.vscode/mcp.json` plus a hook that blocks its
built-in shell) and the Copilot CLI, see [Client setup](docs/clients.md).
Ready-made files are in [examples/](examples/).

**4. Verify:** ask the agent to run `uname -a`. It should report Linux.

## Documentation

- [Sandbox and runtime](docs/sandbox.md): creating a sandbox, `msb` versions, upgrading.
- [Client setup](docs/clients.md): Claude Code, GitHub Copilot, Copilot CLI, client timeouts.
- [Configuration](docs/configuration.md): all flags and environment variables, `--check`, global install.
- [Troubleshooting](docs/troubleshooting.md)
- [Known issues and limitations](docs/known-issues.md)
- [CHANGELOG.md](CHANGELOG.md) and [ROADMAP.md](ROADMAP.md)

## Contributing

```powershell
npm ci
npm test
npm run build
```

See [Development](docs/development.md) for the integration suite against a real
sandbox, the SDK spike and platform pitfalls, [releasing.md](docs/releasing.md)
for releases, and the [product spec](docs/product-spec.md) for the requirements.

## License

[MIT](LICENSE)
