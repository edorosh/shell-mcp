# shell-mcp v3 — Sandbox Created from the MCP Config Design

Date: 2026-10-26 · Milestone: [ROADMAP v3](../../../ROADMAP.md#v3-sandbox-created-from-the-mcp-config)
· Builds on: [v1 design](2026-10-25-shell-mcp-design.md),
[v2 npm design](2026-10-25-shell-mcp-v2-npm-design.md),
[v2.1 macOS design](2026-10-26-shell-mcp-v2.1-macos-design.md),
[product spec](../../product-spec.md)

Today the user creates a microsandbox sandbox by hand (`msb create ...`) and
gives shell-mcp its name. v3 adds a **create mode**: the MCP server config
describes the machine (image, mounts, network, resources), and shell-mcp
creates, reuses or starts that sandbox itself. Today's behavior stays as
**attach mode**. Requirement IDs (N1, X4, C9, ...) refer to the product spec.

## 0. Goal and success criteria

- **For:** a developer on Windows or an Apple Silicon Mac who uses Claude Code
  or VS Code Copilot and wants the agent's shell in a Linux sandbox without
  preparing that sandbox by hand.
- **Done when:** on the maintainer's Windows machine and Mac, with the
  published 1.2.0 package, one MCP config entry using `--image` and `--mount`
  (and no `msb create` beforehand) gives a first `shell` call that runs in a
  sandbox shell-mcp created, with the project folder mounted, in both Claude
  Code and Copilot; and the create-mode integration suite (§8) passes.
- **Not a goal:** a config file (next milestone, §10), Linux hosts (v4), more
  than one sandbox per instance (N2), other backends (N5), secrets, port
  forwarding, custom registries.

## 1. Decisions

| Area | Decision | Who decided |
|------|----------|-------------|
| Sandbox lifetime | Persistent and reused by name. The server never stops or removes it on exit, since another client may share it | User |
| Where the definition lives | Flags and env vars only, like every v2 setting. A config file is the next milestone | User |
| Config changed after creation | Refuse with the list of differences; `--recreate` removes and recreates. Never recreate silently | User |
| Mode and name | `--sandbox` stays the name in both modes. `--image` switches on create mode; without it the server attaches as in v2 | User |
| Network | Denied by default. `--allow-domain` (repeatable, `*.` suffixes) opens hosts; `--allow-network` opens all public hosts. Private and LAN addresses always blocked | User |
| Start-up | Answer the MCP handshake at once and provision in the background; tool calls wait within their timeout. `--prepare` provisions in the foreground and exits | User |
| Approach | A provisioner on the microsandbox SDK inside `src/backend/`, not the `msb` CLI, not provision-only-in-`--prepare` | User |
| Mounts | Repeatable `--mount HOST:GUEST[:ro]`; the first one is the project mount. shell-mcp resolves host symlinks itself | Claude's call, user agreed |
| Config comparison | Compare the handle's stored `config()` with the builder's `.build()`, not a label hash | Claude's call, user agreed |
| Version | 1.2.0: additive, attach-mode configs keep working | Claude's call, user agreed |

## 2. Flags (create mode)

All new flags apply only in create mode. Each goes in `src/config.ts`,
`src/usage.ts` and the table in `docs/configuration.md`.

| Flag | Env | Meaning |
|------|-----|---------|
| `--image REF` | `SHELL_MCP_IMAGE` | OCI image. Switches on create mode. Pulled only if missing |
| `--mount HOST:GUEST[:ro]` | `SHELL_MCP_MOUNT` (`;`-separated) | Bind mount, repeatable, at least one. The first is the project mount |
| `--allow-domain HOST` | `SHELL_MCP_ALLOW_DOMAIN` (comma-separated) | Allow one host, or a suffix with `*.example.com`. Repeatable |
| `--allow-network` | `SHELL_MCP_ALLOW_NETWORK` (`1`/`true`/`yes`) | Allow all public hosts |
| `--cpus N` | `SHELL_MCP_CPUS` | vCPUs; SDK default if unset |
| `--memory SIZE` | `SHELL_MCP_MEMORY` | MiB (`2048`) or `g` suffix (`2g`); SDK default if unset |
| `--recreate` | none | When the sandbox differs from the flags, remove and recreate it |
| `--prepare` | none | Mode, like `--check`: provision in the foreground, print progress, exit |

Rules:

- `--sandbox` stays required in both modes. `--shell`, the timeout flags,
  `--max-output` and `--no-rewrite-output-paths` are unchanged.
- With `--image`: `--host-root` and `--guest-root` are an error
  ("use --mount"). Without `--image`: every create-only flag above is an error
  ("only with --image"). `--recreate` with `--check` is an error.
- `--mount` parsing: the guest part is everything after the **last** `:/`, and
  an optional trailing `:ro`. So `C:\Users\<you>\dev\myproj:/workspace` and
  `/Users/<you>/dev/myproj:/workspace:ro` both parse. The host part must be
  absolute and exist; it is normalized as `--host-root` is today. The guest part
  must be an absolute POSIX path other than `/`, and guest paths must be unique.
- `--recreate` has no env var on purpose, so it cannot stay switched on in a
  client config by accident.
- Mode priority: `--help` > `--version` > `--check` > `--prepare` > serve.

Example (Windows, Claude Code `.mcp.json` args):

```text
--sandbox myproj --image ubuntu:24.04 --mount C:\Users\<you>\dev\myproj:/workspace --allow-domain registry.npmjs.org
```

## 3. Provisioning flow (`src/backend/provision.ts`)

SDK-specific, so it lives in `src/backend/` behind a small interface the
service and `index.ts` use (`ensureSandbox(spec, onProgress)` returning a
connected sandbox, plus a read-only `inspectSandbox(spec)` for `--check`).

1. **Wanted config.** `Sandbox.builder(name)` with `.image()`,
   `.pullPolicy("if-missing")`, one `.volume(guest, m => m.bind(resolvedHost))`
   per mount (`.readonly()` for `:ro`), the network policy (denied by default;
   `allowDomain`/`allowDomainSuffix` per `--allow-domain`, `allowPublic` for
   `--allow-network`, private ranges denied), `.cpus()`/`.memory()` when given,
   and `.detached(true)` so the VM outlives the server process. `.build()`
   yields the config as data.
2. **Look up** `Sandbox.get(name)`:
   - not found (`sandboxNotFound`): create with `createWithPullProgress()`,
     reporting stages and pull percentage;
   - found: compare the fields shell-mcp owns (image, mounts with read-only
     flag, network policy, cpus, memory) between `handle.config()` and the
     wanted config. Other fields (labels, env the user added by hand) are
     ignored. On a difference: fail with `config_mismatch` listing each one,
     unless `--recreate`, in which case stop if running, `Sandbox.remove(name)`,
     and create as above;
   - matches and `stopped`/`crashed`/`created`: `Sandbox.startDetached(name)`;
   - matches and `running`: use it.
3. **Connect** and hand the connection to `MicrosandboxBackend`, which no
   longer calls `Sandbox.get()` itself in create mode.

`connectOrCreate()` is not used: the SDK documents that "existing
configuration wins", which would hide a config change.

**Lifecycle in the server.** `index.ts` starts provisioning right after the
MCP handshake and keeps the promise. Tool calls await it within their own
timeout. A failed attempt is kept until the next tool call, which starts a new
attempt (only one runs at a time), so a fixed network or a started runtime
recovers without restarting the client. On exit the server stops nothing.

**Attach mode** is unchanged: no provisioner, `Sandbox.get()` per call as in v2.

## 4. Paths

- `Config.hostRoot`/`guestRoot` become `mounts: { host, hostResolved, guest,
  readonly }[]`. Attach mode builds one mount from `--host-root`/`--guest-root`
  (with `hostResolved = host`), so its behavior is unchanged.
- The **first mount is the project mount**: the shell starts in its guest path,
  `src/wrap.ts` falls back to it when the cwd disappears, and the tool
  descriptions name it first.
- `PathMapper` takes the mount list. `toHost` uses the mount with the longest
  matching guest prefix (nested mounts work); output rewriting matches every
  guest root, longest first.
- Two host paths per mount: `host` as the user wrote it is what the agent sees
  (it matches the client's file tools); `hostResolved` (`fs.realpathSync.native`)
  is what goes to `msb`, which refuses mounts through a symlink (v2.1 finding).
  On a Mac with `~/dev` linked to another volume, output shows
  `/Users/<you>/dev/myproj/...` while the mount uses `/Volumes/<disk>/dev/myproj`.
- Read-only mounts are marked `(read-only)` in the tool descriptions.

## 5. Errors, `--check`, `--prepare` and logging

**New `BackendError` kinds** (next to `not_found`, `not_running`,
`unreachable`, `not_started`, `outcome_unknown`):

- `preparing`: "sandbox myproj is still being prepared (pulling ubuntu:24.04,
  60%); retry shortly". Returned when a tool call's timeout ends before
  provisioning does.
- `config_mismatch`: "sandbox myproj was created with different settings:
  image ubuntu:22.04 → ubuntu:24.04, mount /cache added. Restart with
  --recreate (deletes everything in the sandbox outside the mounts) or run
  --prepare --recreate."

A failed create (pull error, runtime missing, unknown image) is a tool error
with the SDK's message; the next call retries.

**`--check` in create mode** is still read-only: it never creates, starts or
recreates. Steps:

1. config is valid;
2. the native module loads;
3. the runtime version matches the SDK;
4. the sandbox exists and matches the flags (FAIL lists the differences, or
   "not created yet; run with --prepare");
5. the sandbox is running;
6. the shell runs (hint adds "the image must contain bash, or your --shell");
7. every mount lists the same names on both sides.

**`--prepare`** prints one line per stage (pull progress, create, start,
connect) and exits 0 once the sandbox runs; exit 1 on a mismatch without
`--recreate` or any failure. Its output goes to stdout like `--check`; it never
serves MCP.

**Logging.** The startup line names the mode (`create mode, sandbox "myproj",
image ubuntu:24.04` or `attach mode, sandbox "myproj"`); provisioning stages
follow on stderr. stdout carries only MCP while serving (C9).

**Product spec changes.** N1 (lifecycle is the user's) becomes "attach mode
only"; a new requirement covers create mode. X4 (the user owns the sandbox's
isolation) holds in attach mode; in create mode shell-mcp sets mounts and the
network policy exactly from the flags and never widens them. X1/X2 are
unaffected: provisioning goes through the SDK and spawns no host process.

## 6. Components touched

| File | Change |
|------|--------|
| `src/config.ts` | New flags and env vars, mode rules, `--mount` parsing, `mounts` list, `prepare` mode |
| `src/usage.ts`, `docs/configuration.md` | New flags |
| `src/backend/provision.ts` (new) | Wanted config, lookup, compare, create/start/recreate, progress |
| `src/backend/microsandbox.ts` | Accept a ready connection (create mode) as well as a name (attach mode) |
| `src/backend/types.ts` | `preparing`, `config_mismatch` kinds |
| `src/paths.ts` | Mount list, longest-prefix mapping |
| `src/service.ts`, `src/wrap.ts`, `src/descriptions.ts` | Project mount instead of guest root; describe all mounts |
| `src/check.ts` | Create-mode steps 4 and 7 |
| `src/index.ts` | Background provisioning, `--prepare` mode, startup log |

## 7. Stage A: spike

Before any code, on the maintainer's Windows machine and Mac, a throwaway
`spike/v3-create.mjs` with steps in the project files checks what was read
from the SDK 0.7.11 typings but never run:

1. A `.detached(true)` sandbox keeps running after the creating process exits.
2. `handle.config()` returns image, mounts (with read-only), network policy,
   cpus and memory in a form comparable with `.build()`, including Windows
   drive-letter case and resolved Mac paths.
3. `createWithPullProgress()` emits usable progress events.
4. With `allowDomain("example.com")`, `curl` reaches that host while another
   public host and a LAN address fail; default policy blocks all three.
5. `startDetached` on a stopped sandbox works; `Sandbox.remove` after stop works.
6. Timings: first create with pull, create with cached image, reuse of a running
   sandbox, start of a stopped one.

A failing step changes this design before the plan is executed.

## 8. Testing

- **Unit (CI, no sandbox):** `--mount` parsing (drive letters, `:ro`, bad
  guest paths, duplicates), env lists, mode conflicts; `PathMapper` with
  several and nested mounts; the provisioner against a fake SDK, one test per
  branch (absent, match, mismatch, `--recreate`, stopped, failure then retry,
  one attempt at a time); the service's `preparing` error; create-mode
  `--check` steps. `test/no-host-exec.test.ts` keeps passing.
- **Integration (maintainer's machines):** a create-mode suite enabled by
  `SHELL_MCP_IT_IMAGE` that creates a throwaway sandbox and checks the mount,
  network deny and allow, reuse, mismatch refusal and `--recreate`, then
  removes the sandbox. The 12 attach-mode tests stay as they are.
- **Clients:** Claude Code and Copilot on Windows and the Mac with a create-mode
  entry and no prior `msb create`.

## 9. Docs and release

- `docs/sandbox.md` leads with create mode; attach mode stays as the
  alternative. `docs/configuration.md` gets the new rows; the README quick
  start uses `--image`/`--mount`.
- `docs/product-spec.md` per §5, `CHANGELOG.md` `[Unreleased]`, `ROADMAP.md`
  v3 status.
- Release as 1.2.0 per `docs/releasing.md`.

## 10. Out of scope / next

- **Config file** (next milestone, v3.1 in ROADMAP): a project `shell-mcp.json`
  passed with `--config`, for richer definitions (several mounts, network
  rules, env) shared by a team. Flags keep working.
- Secrets (`secretEnv`), port forwarding, registry auth, idle timeouts.
- Updating a sandbox in place with `modify()` instead of recreating it.
