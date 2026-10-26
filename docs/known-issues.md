# Known issues and limitations

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
- `npx -y @edorosh/shell-mcp@<version>` needs the npm registry on every start;
  use a [global install](configuration.md#npx-or-global-install) to start offline.
- No progress notifications during long calls; Copilot shows nothing while it
  waits (see [Client timeouts](clients.md#client-timeouts)).

## Status

- Windows and macOS (Apple Silicon) hosts are supported. Linux hosts are
  planned; see [ROADMAP.md](../ROADMAP.md).
- On macOS the guest sees the Mac's case-insensitive file system, and `msb`
  needs a mount path without symlinks (see
  [Sandbox and runtime](sandbox.md#macos)).
- The microsandbox SDK spike (`spike/`) has been run on Windows (results in
  [spike-results.md](superpowers/specs/spike-results.md) and
  [v2-spike-results.md](superpowers/specs/v2-spike-results.md)).
- The integration suite (`test/integration.test.ts`) passes all 12 acceptance
  criteria against a real sandbox on Windows (with `SHELL_MCP_IT_ALLOW_STOP=1`).
- Not yet verified on a real host: the `output_gap` and `launch_unconfirmed`
  error paths.

| Client | Host | Status |
|--------|------|--------|
| Claude Code | Windows | Verified |
| Claude Code | macOS (Apple Silicon) | Verified in the v2.1 spike with 1.0.2 |
| GitHub Copilot in VS Code | Windows | Verified, including the hook that turns off the built-in shell |
| GitHub Copilot in VS Code | macOS (Apple Silicon) | Verified in the v2.1 spike with 1.0.2, including `deny-shell.sh` |
| GitHub Copilot hook (`deny-shell.sh`) | Linux | Untested |
| Local-harness agent file | Windows | Untested |
| Copilot CLI with `--deny-tool` | Windows | Untested |
