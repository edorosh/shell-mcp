# shell-mcp — Product Specification

Status: current through release 1.2.0 (v1, v2, v2.1 and v3) · Date: 2026-10-25 ·
v2 amendments 2026-10-25 · v2.1 (macOS) 2026-10-26 · updated 2026-10-26

## 1. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in RFC 2119 and RFC 8174 when, and only when, they
appear in all capitals.

This specification is implementation-agnostic. It names no programming
language, library, or SDK. Any conforming implementation, in any language,
is a valid shell-mcp.

## 2. Purpose

AI coding agents (Claude Code, GitHub Copilot) run shell commands on the
user's own machine. shell-mcp replaces that capability with an MCP server
whose shell tool runs every command inside an isolated sandbox instead.

The user's project folder is mounted into the sandbox. Therefore:

- File tools (read, write, edit, search) keep running on the host, against
  the host's copy of the files.
- Every command (build, test, run, install) runs in the sandbox, against the
  same files seen through the mount.

Motivations:

- **Security:** commands proposed by an agent never execute on the host.
- **Platform:** the host can be Windows while the project builds and runs on
  Linux.

## 3. Terminology

| Term | Meaning |
|------|---------|
| Host | The machine running the agent and the shell-mcp server. Windows, or macOS on Apple Silicon (v2.1). |
| Sandbox | An isolated Linux environment in which commands run. |
| Backend | The sandboxing technology providing the sandbox (v1: microsandbox). |
| Client | The MCP host application (Claude Code, GitHub Copilot in VS Code). |
| Agent | The model driving the client and calling tools. |
| Host root | Absolute host path of the project folder. |
| Guest root | Absolute sandbox path where the host root is mounted. |
| Job | A background command started by the server. |
| Instance | One running shell-mcp server process. |

## 4. Scope

### 4.1 Goals (v1)

- G1. A shell tool whose use cases match the client's built-in shell tool:
  foreground commands with timeouts, and background commands with output
  polling and termination.
- G2. Commands execute in a microsandbox sandbox: an existing, user-provided
  one (attach mode), or one the instance creates from its configuration
  (create mode, C13). (Amended v3.)
- G3. The host/sandbox path difference is handled so the agent can move
  between file tools (host paths) and shell commands (sandbox paths) without
  confusion.
- G4. Works with Claude Code and GitHub Copilot on Windows and macOS (Apple Silicon) hosts.
- G5. The server runs on the host, never inside the sandbox, so that it
  survives sandbox pause, stop, or compromise and can always report the
  sandbox's state to the agent.

### 4.2 Non-goals (v1)

- N1. In attach mode (no `--image`), creating, starting, stopping, or deleting
  sandboxes. The user manages sandbox lifecycle. (Amended v3: create mode,
  C13, creates and starts its sandbox; the instance still never stops one.)
- N2. More than one sandbox per instance, or switching sandboxes at runtime.
- N3. Interactive programs requiring a terminal (editors, password prompts,
  REPLs driven by keystrokes).
- N4. File read/write tools. Those stay with the client's built-in tools.
- N6. Linux hosts. Deferred to a later version. Nothing in v1
  may assume a Windows host beyond the host-path rules of §8, so that
  adding them later is a matter of path handling and testing. (Amended v2.1:
  macOS supported.)
- N5. Backends other than microsandbox (e.g. Docker sbx). The design MUST
  NOT preclude adding them later (see §6).

### 4.3 Anti-goals

These outcomes make the product a failure even if it otherwise works:

- A1. Any agent-issued command executing on the host.
- A2. A silent fallback to host execution when the sandbox is unavailable.
- A3. Errors that leave the agent unable to tell whether a command ran.

## 5. Deployment and configuration

- C1. One instance MUST serve exactly one sandbox for its whole lifetime.
- C2. The instance MUST communicate with the client using MCP over the
  stdio transport.
- C3. Configuration MUST be supplied at launch, via command-line arguments,
  environment variables, or both. The implementation MUST document which.
- C4. These settings are REQUIRED:
  - `sandbox`: backend-specific sandbox identifier (v1: the microsandbox
    sandbox name).
  - `host-root`: absolute host path of the project folder.
  - `guest-root`: absolute sandbox path where `host-root` is mounted.
- C5. These settings are OPTIONAL, with the stated defaults:
  - `default-timeout`: 120 seconds.
  - `max-timeout`: 600 seconds.
  - `max-output`: 30,000 characters.
  - `rewrite-output-paths`: enabled (see §8.4).
  - `shell`: `bash`. The configured shell MUST be named in the tool
    description. The implementation MUST NOT silently substitute another
    shell; a missing shell is reported as a command failure.
- C6. Invalid configuration (a missing required setting, a relative path, a
  non-existent host root) MUST cause the instance to exit at startup with a
  clear message on stderr.
- C7. A sandbox that is unreachable at startup MUST NOT prevent the instance
  from starting. Tool calls report the condition instead (§10).
- C8. The configuration is intended to live in per-project client config
  files (`.mcp.json` for Claude Code, `.vscode/mcp.json` for Copilot) so
  that opening a project binds it to its sandbox.
- C9. The instance MUST NOT write anything except MCP protocol messages to
  stdout while it serves MCP. Diagnostics MUST go to stderr. Informational
  modes that exit without serving MCP (`--version`, `--help`, `--check`) MAY
  print to stdout. (Amended 2026-10-25, v2.)
- C10. Informational modes (added 2026-10-25, v2). Each MUST exit without
  serving MCP:
  - `--help` prints usage (every setting, its environment variable and its
    default) and exits 0.
  - `--version` prints the instance's version and the backend SDK version
    and exits 0.
  - `--check` requires the normal configuration, runs the diagnostics in C11,
    prints one line per step (`ok`, `FAIL` with a hint, or `skipped`) and
    exits 0 when every step passes and 1 otherwise.
  `--help` and `--version` need no other setting and win over invalid
  configuration, unknown flags and each other. Precedence is `--help`,
  `--version`, `--check`, then MCP mode.
- C11. `--check` steps, in order: configuration valid (C6); backend native
  components load; backend runtime resolves and its version matches the one
  the implementation was built for (B5); sandbox reachable and running;
  configured shell runs and reports Linux; host root and guest root list the
  same entries (case-insensitive on Windows hosts). A step that cannot run
  because an earlier one failed is reported as `skipped`. `--check` MUST be
  read-only and MUST NOT write files on either side.
- C12. The MCP `initialize` response (`serverInfo.version`) MUST report the
  instance's released version. (Added 2026-10-26, 1.0.2.)
- C13. Create mode (added v3, 1.2.0). When `--image` is given the instance
  creates and starts the sandbox named by `sandbox` itself:
  - The machine is defined by flags: `--image`, repeatable
    `--mount HOST:GUEST[:ro]` (at least one; the first is the project mount),
    `--allow-domain`, `--allow-network`, `--cpus` and `--memory`.
    `host-root` and `guest-root` are not accepted; path translation (§8)
    follows the mounts.
  - The sandbox is persistent: created on first start, reused by name later,
    and MUST NOT be stopped when the instance exits.
  - If an existing sandbox differs from the flags, the instance MUST refuse and
    list the differences. Only `--recreate` removes and recreates it, deleting
    everything in the sandbox outside the mounts.
  - The instance answers the MCP handshake at once and provisions in the
    background; a tool call made too early reports that the sandbox is still
    being prepared (§10). `--prepare` provisions in the foreground and exits.
    `--check` stays read-only (C11) and MUST NOT create, start or recreate.
  Without `--image` the instance is in attach mode and behaves as in v1/v2.

## 6. Backend

- B1. The implementation MUST support microsandbox as a backend in v1.
- B2. The implementation SHOULD isolate backend-specific code behind an
  internal interface providing: run a command to completion, start a
  background command, read its output incrementally, query its status,
  terminate it, and list the background commands it started.
- B3. The implementation MUST connect to an already-existing sandbox. It MUST
  NOT create, start, stop, restart, or delete sandboxes.
- B4. When the sandbox is stopped or missing, the implementation MUST fail
  the tool call (§10) rather than start or create it. The error message
  SHOULD tell the user how to start the sandbox.
- B5. Where the backend has a separately installed runtime whose version
  must match its SDK (microsandbox: `msb`), the implementation MUST pin the
  SDK to an exact version, and after connecting to the client SHOULD log to
  stderr which runtime it resolved, from where, and its version. A version
  mismatch MUST be a stderr warning only and MUST NOT stop the instance or
  delay serving (C7). (Added 2026-10-25, v2.)

## 7. Tools

The instance MUST expose exactly these four tools in v1. Names are
normative. Parameter and result field names are normative where shown in
code format. Results MUST be returned as MCP text content, formatted for a
model to read. Implementations MAY add structured content as well.

### 7.1 `shell`

Runs a command in the sandbox.

Parameters:

| Name | Type | Req. | Meaning |
|------|------|------|---------|
| `command` | string | yes | Shell command text, run by the configured shell with `-c`. |
| `description` | string | no | Short human-readable purpose. Informational only. |
| `timeout_ms` | integer | no | Foreground timeout. Default `default-timeout`. |
| `run_in_background` | boolean | no | Default false. |

Foreground behavior (`run_in_background` false):

- S1. The command MUST start in the instance's current directory (§9).
- S2. The call MUST return only after the command exits or times out.
- S3. The result MUST include: exit code; stdout and stderr (combined or
  labeled separately); the current directory after the command, in host
  form when inside the guest root (§8) and in guest form otherwise; and
  whether output was truncated.
- S4. `timeout_ms` above `max-timeout` MUST be clamped to `max-timeout`.
  Values ≤ 0 MUST be rejected as invalid parameters.
- S5. On timeout, the implementation MUST terminate the command, including
  its child processes where the backend allows. The result MUST state that
  the command timed out, MUST include the output captured so far, and MUST
  NOT report a normal exit code.
- S6. Standard input MUST be closed (end-of-file), so a command that reads
  stdin terminates instead of hanging.
- S7. A non-zero exit code is a normal result, not a tool error.
- S7a. Foreground calls MAY run concurrently. Each starts in the current
  directory as of its start; when concurrent calls change directory, the
  last one to finish wins. The tool description SHOULD advise against
  relying on `cd` across parallel calls.
- S7b. If the client cancels a foreground call (MCP cancellation), the
  implementation MUST terminate the command as in S5.
- S7c. When the client supplies an MCP progress token, the implementation
  SHOULD send periodic progress notifications during long foreground
  commands, so clients with shorter request timeouts keep the call alive.

Background behavior (`run_in_background` true):

- S8. The call MUST return as soon as the backend confirms the command has
  started, with a job identifier `job_id`.
- S9. `timeout_ms` does not apply to background jobs. A job runs until it
  exits, is killed, or the sandbox stops.
- S10. A background command MUST start in the current directory (§9).
  Directory changes made by a background command MUST NOT affect the
  current directory. If the current directory no longer exists, the job
  MUST start in the guest root, and the agent MUST be told so (in the start
  result or at the beginning of the job's output).

### 7.2 `shell_output`

Parameters: `job_id` (string, required).

- O1. MUST return the output produced since the previous `shell_output`
  call for that job in this instance, or since the job started if there was
  no previous call.
- O2. MUST return the job status: `running`, `exited` (with exit code),
  `killed` (only for jobs this instance terminated via `shell_kill`), or
  `unknown`/`lost` when the backend cannot tell. Jobs ended by other means
  report `exited` with whatever exit code the backend gives (e.g. 137).
- O3. Output in a single response MUST obey `max-output` (§7.5). When more
  output is pending, the response MUST say so, so the agent can call again.
- O4. An unknown `job_id` MUST produce a tool error.
- O5. MUST NOT block waiting for new output. It returns what is available
  immediately.

### 7.3 `shell_kill`

Parameters: `job_id` (string, required).

- K1. MUST request termination of the job and its child processes where the
  backend allows.
- K2. SHOULD wait briefly (a few seconds at most) for confirmed exit, and
  MUST report whether exit was confirmed.
- K3. Killing an already-finished job MUST succeed and report its final
  status.
- K4. `shell_kill` and `shell_output` MUST reject job identifiers this
  instance did not start (O4), so the agent can never kill a job started
  by the user or another instance.

### 7.4 `shell_list`

No parameters.

- L1. MUST list jobs started by this instance: `job_id`, command (shortened
  if long), status, and start time.
- L2. MUST NOT list jobs it did not start (jobs started by the user, other
  tools, or other instances).

### 7.5 Output limits

- T1. Text returned to the agent per call MUST NOT exceed `max-output`
  characters, excluding the fixed fields of the result. The limit applies
  after any path rewriting (§8.4).
- T2. When foreground output is truncated, the implementation SHOULD keep
  the beginning and the end and replace the middle with a marker stating
  how many characters were omitted.
- T3. Output MUST be decoded as UTF-8, replacing invalid sequences rather
  than failing.
- T4. Implementations SHOULD strip or neutralize terminal control sequences
  (such as ANSI colors) only if doing so cannot corrupt ordinary text.
  Doing so is OPTIONAL.

### 7.6 Tool descriptions

The tool descriptions are part of the product. The `shell` description
MUST state:

- D1. that commands run in an isolated Linux sandbox, not on the user's
  machine;
- D2. the host-root ↔ guest-root mapping, with both concrete paths;
- D3. that the working directory persists between calls but environment
  variables and shell state do not;
- D4. the default and maximum timeouts, and when to use
  `run_in_background` (servers, watchers, anything long-running);
- D5. that interactive programs are not supported;
- D6. that file reading and editing should use the client's file tools with
  host paths.

The descriptions SHOULD be short enough not to crowd the agent's context.

## 8. Path translation

The agent sees host paths in file tools and sandbox paths in commands. The
server bridges the two deterministically.

- P1. A path is *inside the workspace* when it equals the root, or extends
  it by a path separator, on its side. Host-side comparison MUST be
  case-insensitive on Windows hosts and case-sensitive otherwise.
- P2. Host → guest: strip the host root, convert separators to `/`, prepend
  the guest root.
- P3. Guest → host: strip the guest root, convert separators to the host's
  native separator, prepend the host root.
- P4. Output rewriting (`rewrite-output-paths`): when enabled, occurrences
  of the guest root in command output that begin a path (start of text, or
  preceded by whitespace, a quote, `(`, `=`, `:` or a similar delimiter) and
  end at a path boundary MUST be rewritten to host form, together with the
  rest of that path. Rewriting MUST NOT touch text that merely contains the
  guest root as part of a longer word, such as `/workspace2` for guest root
  `/workspace`.
- P5. Command text MUST NOT be rewritten. The agent writes commands in
  sandbox terms, guided by the tool description (D2).
- P6. Paths outside the workspace pass through unchanged in guest form.
- P7. The mapping MUST be correct for Windows hosts (drive letters, `\`
  and `/` separators, case-insensitive comparison). Implementations SHOULD
  keep the mapping parameterized by host platform so other hosts can be
  added (N6).

## 9. Working directory

- W1. The instance MUST keep a *current directory*, a guest path,
  initially the guest root.
- W2. After each foreground command, the current directory MUST become the
  directory the command's shell was in when it exited, provided the
  implementation could determine it. If it could not (for example, the
  command ran `exec`), the current directory MUST stay unchanged.
- W3. If the current directory no longer exists when a command starts, the
  command MUST run in the guest root instead, and the result MUST say that
  the directory was reset.
- W4. Environment variables, shell options, functions, and aliases MUST NOT
  persist between calls.
- W5. Implementation mechanics for tracking the directory (markers, traps,
  side files) MUST NOT appear in output returned to the agent.

## 10. Errors

- E1. The instance MUST NOT crash or exit because of a tool-call failure.
- E2. These conditions MUST produce an MCP tool error (`isError: true`)
  with a plain-language message: sandbox not found, sandbox not running,
  backend unreachable, invalid parameters, unknown job.
- E3. For every failed `shell` call, the message MUST make clear whether
  the command was *not started*, *started but outcome unknown*, or
  *completed*. For "outcome unknown", it MUST warn against blindly retrying
  side-effecting commands.
- E4. When the backend becomes reachable again, the instance MUST recover
  without a restart.

## 11. Security

- X1. The instance MUST NOT execute agent-supplied commands on the host
  under any circumstances. No host-execution fallback mode MAY exist.
- X2. The instance MUST NOT start host processes other than those required
  to talk to the backend.
- X3. The instance MUST NOT log command output or environment contents
  beyond what is needed for diagnostics. Logs go to stderr only.
- X4. In attach mode the sandbox's isolation (network policy, mounts, secrets)
  is the backend's and the user's responsibility; the instance MUST NOT widen
  it. In create mode the instance sets the mounts and the network policy
  exactly from the flags and MUST NOT widen them: the network is denied unless
  `--allow-domain` or `--allow-network` says otherwise, and private addresses
  are always blocked. (Amended v3.)

## 12. Client integration

The project MUST ship user documentation covering:

- I1. Creating a suitable sandbox with the project folder mounted, with a
  concrete microsandbox example.
- I2. Registering the server in Claude Code (`.mcp.json`) and GitHub Copilot
  (`.vscode/mcp.json`) on Windows, running the published package at an exact
  version (`npx -y @edorosh/shell-mcp@<version>`). (Amended 2026-10-25, v2.)
- I3. Turning off each client's built-in shell tool, so the agent can only
  run commands through shell-mcp:
  - Claude Code: a permissions deny rule for `Bash` in project settings.
  - GitHub Copilot in VS Code, Copilot harness: a `preToolUse` repository
    hook (`.github/hooks/`) that denies the built-in shell tools, with a
    Windows (PowerShell) and a Linux/macOS (bash) script. (Amended
    2026-10-25.)
  - GitHub Copilot in VS Code, Local harness: deselecting the built-in
    terminal tools in the tool picker, or a custom agent with an explicit
    tools list.
  - Copilot CLI: `--deny-tool` for the built-in shell.
  The documentation MUST say which of these options were verified with a
  real client.
- I4. Sandbox image requirements: the configured shell (default `bash`)
  MUST be installed in the sandbox.
- I5. Verifying the setup, for example by asking the agent to run `uname -a`
  and confirming it reports Linux.
- I6. Install without building: the documentation MUST give a client config
  that runs the published package at an exact version, and MUST NOT use the
  unscoped name `shell-mcp`. (Added 2026-10-25, v2.)
- I7. Running `--check` before configuring a client, a global install for
  offline start, upgrading, the backend runtime version each release
  expects, measured client timeout behavior, troubleshooting for known
  host problems, and the known limitations. (Added 2026-10-26.)
- I8. The README stays short: what shell-mcp is, requirements, a quick start
  (create a sandbox, `--check`, one client config, verify), and how to build
  and test. Everything else lives in `docs/` and is linked from the README.
  (Added 2026-10-26.)

## 12a. Distribution and release

Added 2026-10-25, v2.

- R1. The server MUST be published to the npm registry as
  `@edorosh/shell-mcp` under the MIT license, with a `bin` entry that starts
  from `cmd`, PowerShell and the clients' MCP launchers on Windows.
- R2. Versions follow semantic versioning. Every release MUST have a
  `CHANGELOG.md` section, which SHOULD name the backend SDK version and the
  runtime version it was tested with.
- R3. Releases MUST be published from CI on a pushed `vX.Y.Z` tag, using npm
  trusted publishing (OIDC, no stored token) with provenance. The release
  job MUST refuse a tag that does not match `package.json` and the
  changelog, MUST run typecheck, tests and a pack check first, and MUST be
  safe to rerun (an already published version is skipped). It creates a
  GitHub release from the changelog section.
- R4. A pack check MUST verify that the tarball contains exactly the
  runtime files, README, license and changelog, and that the installed
  `bin` starts through npm's shim. CI MUST run it on Windows.
- R5. Pinned versions in the README, `docs/` and `examples/` MUST be updated
  in every release.

## 13. Acceptance criteria

A conforming implementation passes all of these on a Windows or Apple Silicon macOS host (1 to 12
from v1, 13 to 17 from v2 and later):

1. `shell` with `echo hi` returns `hi` and exit code 0.
2. `shell` with `exit 3` returns exit code 3 and no tool error.
3. `cd src` followed by `pwd` reports the guest path of `src`, and the
   result's current directory shows the host path of `src`.
   Note (ruling): verified with `--no-rewrite-output-paths`. With default
   path rewriting (P4), `pwd` prints the host form; the current-directory
   field shows the host form either way.
4. `export X=1` followed by `echo $X` prints an empty line.
5. `sleep 30` with `timeout_ms` 1000 returns within a few seconds, marked as
   timed out, and the process is gone from the sandbox.
6. `cat` with no arguments finishes immediately (stdin closed).
7. A command printing 1 MB of output returns at most `max-output` characters
   with a truncation marker, keeping the start and end.
8. A background `while true; do echo tick; sleep 1; done` returns a `job_id`. `shell_output`
   shows `tick` lines. `shell_list` lists it as running. `shell_kill`
   stops it, and `shell_list` then reports it as killed or exited.
9. A test failure printing `/workspace/src/a.ts:3` (guest root
   `/workspace`) appears with the host path of `src/a.ts`. `/workspace2/x`
   is left unchanged.
10. With the sandbox stopped, `shell` returns a tool error naming the
    sandbox and saying how to start it. After the sandbox is started, the
    next call succeeds without restarting the instance.
11. A file written by `shell` (`echo x > out.txt`) is visible to the host's
    file tools at the host path.
12. Deleting the current directory from the host, then running `pwd`, runs
    in the guest root and reports the reset.
    Note (ruling): verified with `--no-rewrite-output-paths`, for the same
    reason as criterion 3 (with default rewriting, `pwd` prints the host form;
    the current-directory field shows the host form either way).
13. `--version` prints the package version and the SDK version and exits 0;
    `--help` prints usage and exits 0, even with no other flags.
14. `--check` against a running, correctly mounted sandbox prints `ok` for
    every step and exits 0; with the sandbox stopped it fails the sandbox
    step with how to start it, skips the later steps and exits 1.
15. A runtime version that differs from the pinned SDK fails `--check` and
    only logs a warning in MCP mode.
16. The `initialize` response reports the package version as
    `serverInfo.version`.
17. A fresh user, with nothing cloned or built, runs the published package
    through `npx -y @edorosh/shell-mcp@<version>` from Claude Code and
    GitHub Copilot, and `uname -a` reports Linux.
