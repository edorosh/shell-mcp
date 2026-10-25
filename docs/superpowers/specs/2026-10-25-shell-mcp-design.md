# shell-mcp v1 — Implementation Design (TypeScript + microsandbox)

Date: 2026-10-25 · Implements: [docs/product-spec.md](../../product-spec.md)

The product spec is the source of truth for behavior. This document records
how v1 is built. Requirement IDs (S1, P4, ...) refer to the spec.

## 1. Decisions

| Area | Decision | Who decided |
|------|----------|-------------|
| Language | TypeScript on Node.js (current LTS, ≥ 20) | User |
| MCP | Official `@modelcontextprotocol/sdk`, stdio transport | Claude's call |
| Backend access | microsandbox TypeScript SDK (`microsandbox` on npm), **not** the `msb` CLI and **not** SSH | User asked to double-check; agreed after comparison |
| Execution primitive | Native `exec` (stream variant) and managed jobs (`execDetached`) | Claude's call, from docs |
| Lifecycle | `Sandbox.get(name)` then `handle.connect()`. Never `start`, `connectOrStart`, `create` | User (sandboxes pre-created) |
| Shell state | Fresh `bash -c` per call. Working directory tracked by the server. Env does not persist | Claude's call (matches Claude Code's Bash) |
| Background jobs | microsandbox runtime-owned jobs; only jobs this instance started are visible/killable | Claude's call |
| Parallel calls | Run concurrently, last finisher sets cwd | Claude's call |
| Cancellation | Client cancel kills the sandbox process | Claude's call |
| Shell | Configured shell only, no `sh` fallback | Claude's call |
| Packaging | npm package with a `bin`, run via `npx` | Claude's call |
| Config | CLI flags, each with an env-var fallback | Claude's call |

Why the SDK over the CLI: passing arbitrary agent commands through
`msb exec name -- bash -c "<cmd>"` means escaping them through Windows
command-line quoting. That is a classic source of subtle bugs with `"`, `$`,
`&&` and `\`. The SDK takes the command as a plain string argument and
returns typed exit codes, streams, and job IDs, so there is no text parsing.

## 2. Risks to retire first (spike, task 0)

1. **SDK on Windows.** The `microsandbox` npm package ships native code. Confirm
   that it installs and that `Sandbox.get(name)` → `connect()` → `shell("uname -a")`
   works on a Windows host, and on Linux.
2. **Version coupling.** The SDK must match the installed `msb` runtime. Record
   the tested pair and pin the SDK version exactly. Startup logs both versions
   to stderr.
3. **Partial output on timeout.** Confirm that the stream API delivers the
   output produced before a timeout kill (spec S5). If not, fall back to a
   host-side timer plus `handle.kill()`.
4. **Job logs.** Confirm the shape of `JobLogEntry` (text vs bytes, stdout vs
   stderr source) and the behavior of `fromCursor`.
5. **Client tool timeouts.** Confirm that a 10-minute foreground call isn't cut
   off by the client's own MCP request timeout (Claude Code: `MCP_TOOL_TIMEOUT`;
   Copilot: its own limit), and whether progress notifications (S7c) reset it.
   Document any needed client setting in the README; the shipped defaults stay.

If (1) fails, the fallback is to implement the same `Backend` interface over
the `msb` CLI (`msb exec --no-tty --no-stdin`, `msb exec -d`, `msb logs --job`,
`msb kill --job`), spawning `msb` directly with an argument array (no shell),
so Windows quoting is limited to one argument.

## 3. Layout

```
shell-mcp/
  package.json            bin: { "shell-mcp": "dist/index.js" }
  tsconfig.json
  src/
    index.ts              entry: parse config, build server, connect stdio
    config.ts             flags/env → validated Config (spec C3–C6)
    paths.ts              PathMapper: host↔guest, output rewriting (spec §8)
    wrap.ts               command wrapper + cwd-marker extraction (spec §9)
    output.ts             head/tail truncation, UTF-8 decode (spec §7.5)
    jobs.ts               JobRegistry: per-job read cursor, metadata (spec §7.2–7.4)
    tools.ts              registers shell, shell_output, shell_kill, shell_list
    descriptions.ts       tool description text, templated with config (spec §7.6)
    backend/
      types.ts            Backend interface (spec B2)
      microsandbox.ts     Backend over the microsandbox SDK
  test/
    paths.test.ts  wrap.test.ts  output.test.ts  tools.test.ts (fake backend)
    integration.test.ts   real msb sandbox. Skipped unless SHELL_MCP_IT_SANDBOX is set
  README.md               spec §12 user documentation
```

Testing: `vitest`. Lint/format: whatever the scaffold provides, kept minimal.

## 4. Configuration

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

Flags win over env. `--host-root` is normalized with `path.resolve` and must
exist on disk. The guest root must be absolute POSIX and has any trailing `/`
stripped.

Example `.mcp.json` (Claude Code):

```json
{ "mcpServers": { "sandbox": {
  "command": "npx", "args": ["-y", "shell-mcp",
    "--sandbox", "myproj", "--host-root", "C:\\Users\\eugen\\dev\\myproj",
    "--guest-root", "/workspace"] } } }
```

## 5. Backend interface

```ts
interface RunResult {
  output: string;            // stdout+stderr interleaved in arrival order
  exitCode: number | null;   // null when killed by timeout
  timedOut: boolean;
}
interface JobStatus { state: "running" | "exited" | "killed" | "lost" | "unknown"; exitCode?: number }
interface Backend {
  run(script: string, opts: { cwd: string; timeoutMs: number }): Promise<RunResult>;
  startJob(script: string, opts: { cwd: string }): Promise<{ id: string }>;
  readJob(id: string, cursor?: string): Promise<{ text: string; cursor?: string; more: boolean; gap: boolean }>;
  jobStatus(id: string): Promise<JobStatus>;
  killJob(id: string, waitMs: number): Promise<{ confirmed: boolean; status: JobStatus }>;
}
```

Errors are normalized into `BackendError` with `kind`:
`not_found | not_running | unreachable | not_started | outcome_unknown`. The
tool layer maps the kind to the wording spec E3 requires.

### 5.1 microsandbox implementation

- **Connection:** lazy and cached. On first use, `Sandbox.get(name)`. If the
  status isn't running, throw `not_running` with the hint
  `msb start <name>`. Otherwise `handle.connect()` (10 s timeout). On any
  connection-class error, drop the cache so the next call reconnects (E4).
- **run:** `sb.execStreamWith(shell, b => b.args(["-c", script]).timeout(timeoutMs).stdinNull())`.
  Iterate events, appending stdout/stderr chunks to one buffer in arrival
  order and capping the in-memory buffer at about 4 × `max-output` (keep
  the head and a rolling tail). An `exited` event gives the code.
  `ExecTimeoutError`, or the SDK's timeout signal, sets `timedOut`.
- **startJob:** `sb.execDetachedWith(shell, b => b.args(["-c", script]).stdinNull())`,
  returning `job.id`.
- **readJob:** `sb.getJob(id).logs({ fromCursor })`. (Note: the SDK never
  receives a `cwd()` option; see §6.) Concatenate entry text and
  return the last entry's cursor. A retention gap sets `gap` (surfaced as
  "[some output was discarded by the sandbox]").
- **jobStatus / killJob:** `job.inspect()`; `job.kill()` then `job.wait()`
  raced against `waitMs` (default 3 s). microsandbox has no `killed` state;
  the tool layer reports `killed` only for jobs this instance killed (O2).
- **listJobs:** not needed from the backend. `shell_list` reads the
  in-memory `JobRegistry` and asks `jobStatus` per entry (L1/L2).

## 6. Command wrapping and working directory (spec §9)

The server holds `cwd` (guest path), initially the guest root. Each
foreground command is sent as:

```bash
cd -- '<cwd>' 2>/dev/null || { cd -- '<guest-root>'; printf '%s\n' '__SHELLMCP_RESET__' >&2; }
trap 'printf "\n%s%s\n" "__SHELLMCP_CWD_<nonce>__" "$PWD" >&2' EXIT
<command>
```

- `<cwd>` and `<guest-root>` are single-quote-escaped (`'` → `'\''`).
- `<nonce>` is random per instance, so command output can't spoof the marker.
- The user's command is appended verbatim on its own line. Using a separate
  line, not `;`, keeps a trailing `#` comment or here-doc in the command
  from breaking the wrapper.
- After the run, the server finds the **last** marker line in the output,
  takes the path, and strips the marker line and the reset line (W5). No
  marker (because of `exec` or a stderr redirect) means `cwd` stays
  unchanged (W2). A reset line means the result says "directory no longer
  existed; reset to workspace root" (W3).
- Background jobs get a different prefix and no trap. They never update
  `cwd` (S10). On a missing directory they print a human-readable note
  instead of the marker, so nothing needs stripping from job logs:
  `cd -- '<cwd>' 2>/dev/null || { cd -- '<guest-root>'; echo "[shell-mcp: <cwd> no longer exists; started in <guest-root>]" >&2; }`
- The SDK `cwd()` option is not used, because it can't express the reset
  fallback. Both `run` and `startJob` pass `cwd` to the backend only so the
  backend can build this prefix. The `opts.cwd` in §5 means "prefix target",
  not the SDK option.

## 7. Paths (spec §8)

`PathMapper` is built from `hostRoot`, `guestRoot`, and `process.platform`:

- `toGuest(hostPath)` and `toHost(guestPath)` per P2/P3. On Windows, host
  comparison is case-insensitive and accepts both `\` and `/`.
- `rewriteOutput(text)`: a regex anchored on the escaped guest root, preceded
  by start-of-line or one of ``\s"'`(=:[,`` and followed by `/`, a
  delimiter, or end of text. The match is extended over path characters
  `[^\s"'`:),\]]*` and converted with `toHost`. A `:line:col` suffix is
  preserved because `:` ends the path. Order: strip markers → rewrite paths →
  truncate (so T1 holds even when host paths are longer than guest paths).

The result header always shows the cwd: in host form when it is inside the
workspace (via `toHost`), and in guest form otherwise.

## 8. Tool results

Text content, for example:

```
exit code: 0
cwd: C:\Users\eugen\dev\myproj\src
---
<output>
```

Timeout: `timed out after 120s (process killed)` replaces the exit-code line.
Truncation adds `[... 48211 characters omitted ...]` in the middle (T2),
keeping the first 40% and the last 60% of the budget. Background start
returns `started background job <id>` plus a one-line hint to use
`shell_output`.

`JobRegistry` keeps, per job id: the read cursor, the shortened command,
the start time, and whether this instance killed it. In-memory only. It is
the only source for `shell_list`, and `shell_output`/`shell_kill` reject ids
not in it (L2, K4). Jobs keep running in the sandbox after a server restart
but are no longer visible to the agent; that is accepted for v1.

Concurrency and cancellation (S7a–c): foreground calls run concurrently;
each captures `cwd` at start and writes it back on finish. Each call gets
an `AbortSignal` from the MCP SDK; on abort, `run` calls the stream
handle's `kill()`. While a run is in progress and the request carries a
progress token, send a progress notification every 15 s.

## 9. Tool descriptions

Kept in `descriptions.ts` and templated with the configured roots, shell,
and timeouts. Spec D1–D6 is the checklist. They should be tuned against
real agent behavior during the integration pass, especially so the agent
uses `run_in_background` for servers and calls `shell_output` afterwards.

## 10. Testing

- **Unit (no sandbox):** `paths` (Windows and Linux variants, case,
  `/workspace2`, `:line:col`), `wrap` (quoting, marker extraction, missing
  marker, reset), `output` (truncation, UTF-8), `tools` with a fake
  `Backend` (timeouts clamped, error wording per kind, job cursoring).
- **Integration (real msb):** spec §13 acceptance criteria 1–12, run when
  `SHELL_MCP_IT_SANDBOX` names a running sandbox whose mount matches
  `SHELL_MCP_IT_HOST_ROOT` / `SHELL_MCP_IT_GUEST_ROOT`.
- **Manual:** one session each in Claude Code and Copilot with the built-in
  shell disabled (spec I4).

## 11. Left to the builder

- Exact wording of tool descriptions and result text, within the spec.
- Internal module boundaries beyond the layout above.
- Whether to add MCP structured content alongside text.
- Logging verbosity flags.
