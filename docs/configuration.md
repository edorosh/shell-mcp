# Configuration

Settings are given as flags or environment variables in the client's MCP
config. Flags win over environment variables.

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

Timeouts take `ms`, `s` or `m` (`1500ms`, `120s`, `5m`); a bare number means seconds.

`--host-root` must be an absolute path. It is normalized (`path.win32.normalize`:
`/` becomes `\`, `.` and `..` segments are collapsed), a trailing separator is
stripped, and it must exist on disk. The guest root must be an absolute POSIX
path; a trailing `/` is stripped.

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
6. the host folder is mounted at the guest path (both list the same names).

It is read-only and writes nothing on either side.

## npx or global install

The client configs in the [README](../README.md) run
`npx -y @edorosh/shell-mcp@1.0.2 ...`. That form contacts the npm registry on
every start, so it does not start offline. **Do not use `npx shell-mcp`**: the
unscoped npm name belongs to an unrelated package.

To start offline and instantly, install globally:

```powershell
npm i -g @edorosh/shell-mcp@1.0.2
```

Then use `shell-mcp` as the command, with the same arguments and without
`npx -y @edorosh/shell-mcp@1.0.2`: in `.vscode/mcp.json`
`"command": "shell-mcp"`, and in Claude Code's `.mcp.json`
`"command": "cmd", "args": ["/c", "shell-mcp", "--sandbox", ...]`.
