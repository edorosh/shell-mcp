# shell-mcp

An MCP server for Claude Code and GitHub Copilot that runs your agent's shell
commands inside a microsandbox
Linux sandbox instead of on your Windows or Mac machine. Your project folder is
mounted into the sandbox, so file tools keep working on the host while every
command runs in Linux.

It exposes four tools: `shell` (foreground or background commands with a
timeout), `shell_output`, `shell_kill` and `shell_list`. Paths are translated
between the host folder and the sandbox mount, and the working directory is
kept across calls.

Published on npm as [`@edorosh/shell-mcp`](https://www.npmjs.com/package/@edorosh/shell-mcp).

## Requirements

- Windows (x64 or arm64) or macOS on Apple Silicon, with Node.js 22 or newer
  (arm64 Node on a Mac).
- `bash` in the sandbox image (`ubuntu:24.04` has it). shell-mcp creates the
  sandbox itself, or attaches to one you made (see
  [Sandbox and runtime](docs/sandbox.md)).
- `msb` 0.7.11, matching the SDK that shell-mcp 1.2.0 pins. Without a separate
  install, the runtime packaged with the SDK is used.

## Quick start

New to microsandbox? [Typical setups](docs/setups.md) has ready-to-copy
configurations: no internet, package registries only, full internet, extra
folders, a bigger machine.

**1. Check the setup, and do the first image pull in a terminal** (the sandbox
is created on first use and keeps running after the client exits):

```powershell
npx -y @edorosh/shell-mcp@1.2.0 --sandbox myproj --image ubuntu:24.04 --mount C:\Users\<you>\dev\myproj:/workspace --prepare
```

```zsh
npx -y @edorosh/shell-mcp@1.2.0 --sandbox myproj --image ubuntu:24.04 --mount /Users/<you>/dev/myproj:/workspace --prepare
```

Always use the scoped name with a version. `npx shell-mcp` is an unrelated
package.

**2. Add it to your client.** Claude Code, in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y", "@edorosh/shell-mcp@1.2.0",
        "--sandbox", "myproj",
        "--image", "ubuntu:24.04",
        "--mount", "C:\\Users\\<you>\\dev\\myproj:/workspace"
      ]
    }
  }
}
```

and turn off the built-in shell in `.claude/settings.json`:

```json
{ "permissions": { "deny": ["Bash"] } }
```

On a Mac, use `"command": "npx"` with `"-y", "@edorosh/shell-mcp@1.2.0", ...`
and `"/Users/<you>/dev/myproj:/workspace"` as the mount (see
[Client setup](docs/clients.md)).

For GitHub Copilot in VS Code (`.vscode/mcp.json` plus a hook that blocks its
built-in shell) and the Copilot CLI, see [Client setup](docs/clients.md).
Ready-made files are in [examples/](examples/).

**3. Verify:** ask the agent to run `uname -a`. It should report Linux.

## Documentation

- [Typical setups](docs/setups.md): ready-to-copy configurations for people new to microsandbox.
- [Sandbox and runtime](docs/sandbox.md): creating a sandbox, `msb` versions, upgrading.
- [Client setup](docs/clients.md): Claude Code, GitHub Copilot, Copilot CLI, client timeouts.
- [Configuration](docs/configuration.md): all flags and environment variables, `--check`, global install.
- [Troubleshooting](docs/troubleshooting.md)
- [Known issues and limitations](docs/known-issues.md)
- [CHANGELOG.md](CHANGELOG.md) and [ROADMAP.md](ROADMAP.md)

## Contributing

```sh
npm ci
npm test
npm run build
```

See [Development](docs/development.md) for the integration suite against a real
sandbox and platform pitfalls, [releasing.md](docs/releasing.md)
for releases, and the [product spec](docs/product-spec.md) for the requirements.
Coding agents read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
