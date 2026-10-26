# Configuration

Settings are given as flags or environment variables in the client's MCP
config. Flags win over environment variables.

| Flag | Env | Default |
|------|-----|---------|
| `--sandbox` | `SHELL_MCP_SANDBOX` | required |
| `--host-root` | `SHELL_MCP_HOST_ROOT` | required without `--image` |
| `--guest-root` | `SHELL_MCP_GUEST_ROOT` | required without `--image` |
| `--image REF` | `SHELL_MCP_IMAGE` | none; switches on create mode |
| `--mount HOST:GUEST[:ro]` | `SHELL_MCP_MOUNT` (`;`-separated) | repeatable, at least one with `--image`; the first is the project mount |
| `--allow-domain HOST` | `SHELL_MCP_ALLOW_DOMAIN` (comma-separated) | repeatable; a host or a suffix such as `*.example.com` |
| `--allow-network` | `SHELL_MCP_ALLOW_NETWORK` (`1`, `true`, `yes`) | off; allows all public hosts |
| `--cpus N` | `SHELL_MCP_CPUS` | SDK default |
| `--memory SIZE` | `SHELL_MCP_MEMORY` | SDK default; MiB (`2048`) or `g` suffix (`2g`) |
| `--recreate` | none | off; remove and recreate the sandbox when it differs from the flags |
| `--prepare` | none | provisions the sandbox in the foreground, prints progress, then exits |
| `--default-timeout` | `SHELL_MCP_DEFAULT_TIMEOUT` | `120s` |
| `--max-timeout` | `SHELL_MCP_MAX_TIMEOUT` | `600s` |
| `--max-output` | `SHELL_MCP_MAX_OUTPUT` | `30000` |
| `--no-rewrite-output-paths` | `SHELL_MCP_REWRITE_OUTPUT_PATHS=0` (or `false`, `no`) | rewriting on |
| `--shell` | `SHELL_MCP_SHELL` | `bash` |
| `--version` | none | prints the version and exits |
| `--help` | none | prints usage and exits |
| `--check` | none | verifies native module, runtime version, sandbox, shell and mount, then exits |

Timeouts take `ms`, `s` or `m` (`1500ms`, `120s`, `5m`); a bare number means seconds.

`--host-root` must be an absolute path. It is normalized (`path.win32.normalize`:
`/` becomes `\`, `.` and `..` segments are collapsed), a trailing separator is
stripped, and it must exist on disk. The guest root must be an absolute POSIX
path; a trailing `/` is stripped.

Create mode is switched on by `--image`. With it, `--host-root` and
`--guest-root` are an error (use `--mount`); without it, every create-only flag
(`--mount`, `--allow-domain`, `--allow-network`, `--cpus`, `--memory`,
`--recreate`) is an error ("only with `--image`"). `--recreate` cannot be
combined with `--check`, and has no environment variable on purpose. A repeated
flag replaces its environment variable. Mode priority: `--help` > `--version` >
`--check` > `--prepare` > serve.

`--mount` takes `HOST:GUEST[:ro]`. The guest part is everything after the last
`:/`, with an optional trailing `:ro`, so
`C:\Users\<you>\dev\myproj:/workspace` and `/Users/<you>/dev/myproj:/workspace:ro`
both parse. The host part must be absolute and exist; it is normalized like
`--host-root`. The guest part must be an absolute POSIX path other than `/`, a
trailing `/` is stripped, and guest paths must be unique. The host path is also
resolved through symlinks (`realpath`) for the sandbox, while tool output keeps
the path as you wrote it. `--memory` must be positive; `--cpus` a positive integer.

Path rewriting is turned off only by `--no-rewrite-output-paths` or by
`SHELL_MCP_REWRITE_OUTPUT_PATHS` set to `0`, `false` or `no` (any case). Any
other value leaves it on; the flag wins over the variable.

## `--check`

Run it once before configuring a client, with the same flags the client will
use. It prints one line per step, `ok`, `FAIL` with a hint, or `skipped`, and
exits 1 if any step failed:

1. config is valid;
2. the native `microsandbox` module loads;
3. the `msb` runtime resolves and its version matches the SDK;
4. the sandbox is reachable and running;
5. the shell runs (`uname -s` returns `Linux`);
6. each host folder is mounted at its guest path (both list the same names); one line per mount.

In create mode there is an extra `definition` step between the runtime and the
sandbox: it compares the existing sandbox with the flags, and prints
`ok definition: matches the flags` or `FAIL definition: <differences>` (the
steps after it are `skipped`). A sandbox that does not exist yet fails as
`FAIL sandbox: "myproj" is not created yet; run with --prepare`. Every
`--mount` is checked, not only the project mount.

It is read-only and writes nothing on either side; in create mode it never
creates, starts or recreates the sandbox.

## npx or global install

The client configs in the [README](../README.md) run
`npx -y @edorosh/shell-mcp@1.2.0 ...`. That form contacts the npm registry on
every start, so it does not start offline. **Do not use `npx shell-mcp`**: the
unscoped npm name belongs to an unrelated package.

To start offline and instantly, install globally:

```powershell
npm i -g @edorosh/shell-mcp@1.2.0
```

Then use `shell-mcp` as the command, with the same arguments and without
`npx -y @edorosh/shell-mcp@1.2.0`: in `.vscode/mcp.json`
`"command": "shell-mcp"`, and in Claude Code's `.mcp.json`
`"command": "cmd", "args": ["/c", "shell-mcp", "--sandbox", ...]`. On macOS use
`"command": "shell-mcp", "args": ["--sandbox", ...]` (untested on macOS: the
spike did not exercise a global install there).
