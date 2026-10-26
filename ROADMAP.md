# shell-mcp Roadmap

Milestones in delivery order. Each milestone ships on its own. Requirement IDs
(G1, N6, ...) refer to the [product spec](docs/product-spec.md).

## v1: Sandboxed shell tool on Windows

Status: done (2026-10-25). Spec: [product-spec.md](docs/product-spec.md).
Design: [shell-mcp design](docs/superpowers/specs/2026-10-25-shell-mcp-design.md).
Plan: [v1 implementation plan](docs/superpowers/plans/2026-10-25-shell-mcp-v1.md).

- MCP server over stdio, running on the host, never inside the sandbox (G5).
- `shell`, `shell_output`, `shell_kill` and `shell_list` tools that match the
  client's built-in shell: foreground commands with timeouts, and background
  jobs with output polling and termination (G1).
- Commands run in one existing, user-provided microsandbox sandbox (G2).
- Host↔sandbox path translation and working-directory tracking (G3).
- Works with Claude Code and GitHub Copilot on Windows hosts (G4).
- Distribution: not published. Clients run `node <clone>\dist\index.js`.

Known issues:

- After the working directory is deleted on the host, the sandbox mount takes
  about 5 s to notice it.
- The `output_gap` and `launch_unconfirmed` paths are covered only by unit
  tests and have never fired on a real host.

## v2: npm package for easy install on Windows

Status: done. 1.0.0 published 2026-10-25; 1.0.1 was the first CI release
with trusted publishing; current release 1.0.2. Milestone numbers and package
versions are unrelated. Spec: [product-spec.md](docs/product-spec.md) (C10 to
C12, B5, §12a).
Design: [v2 npm distribution design](docs/superpowers/specs/2026-10-25-shell-mcp-v2-npm-design.md).
Plan: [v2 implementation plan](docs/superpowers/plans/2026-10-25-shell-mcp-v2.md).

Goal: a Windows user installs and configures shell-mcp without cloning or
building the repo.

- Publish to the npm registry as `@edorosh/shell-mcp` (MIT). The unscoped name `shell-mcp` belongs to an unrelated
  package, so the docs must never say `npx shell-mcp`.
- Run with `npx -y @edorosh/shell-mcp@<version> ...` (exact version in client
  configs) or install globally with `npm i -g @edorosh/shell-mcp`. The `bin` entry works from `cmd`, PowerShell
  and the clients' MCP launchers on Windows.
- Pin the `microsandbox` SDK version exactly and document the supported `msb`
  runtime version for each release. `--check` and the startup log report
  which `msb` the SDK resolved and whether its version matches.
- Release pipeline: build, test and publish from CI on a version tag, with npm
  provenance. Semver, with a changelog.
- Update the README and client setup snippets (Claude Code, GitHub Copilot) to
  use the published package.
- Verify each untested client option in the [client support](#client-support)
  table, or remove it from the docs.

## v3: Sandbox created from the MCP config

Status: idea.

Goal: shell-mcp creates and starts its microsandbox machine when the MCP server
starts, so the user no longer prepares a sandbox by hand. This takes on
sandbox lifecycle management (N1).

- Define the machine in the MCP server config: image, mounts (host folder to
  sandbox path), network rules, and resources such as CPU and memory.
- On startup, create the sandbox from that definition, or reuse one that
  already matches it; stop it when the server exits.
- Path translation (G3) follows the configured mounts instead of a separate
  mapping.
- Keep today's attach mode (`--sandbox` names an existing sandbox) next to the
  new create mode, so v2 configs keep working.
- Network access is denied unless the config allows it.
- Open questions: flags or a config file for the machine definition, start-up
  time on the first tool call, what happens to a running machine when the
  config changes, and whether data in the sandbox survives a restart.
- Notes on the SDK's creation API: `v3-spec/sdk-create-notes.md` in the project
  files.

Done when: a user with only `msb` installed adds one MCP config entry, and the
first `shell` call runs in a sandbox shell-mcp created, with the project folder
mounted.

## v4: Linux and macOS hosts

Status: idea. Takes on N6.

Goal: shell-mcp runs on Linux and macOS hosts as well as Windows.

- Path translation for POSIX host paths.
- CI runs the test suite on Windows, Linux and macOS.
- Test the Linux/macOS Copilot hook (`deny-shell.sh`) with a real client.
- npm stays the install method on every host. A Homebrew formula in our own
  tap is optional, only if macOS users ask for it: it would still wrap npm,
  and `brew upgrade` would undo the exact version pin that keeps the SDK and
  `msb` matched.

Done when: the acceptance suite passes on a Linux and a macOS host with Claude
Code and Copilot.

## Later (unscheduled)

Deferred by the v1 spec or found while testing v1. None of these is committed
to a milestone yet.

- Backends other than microsandbox, e.g. Docker sbx (N5).
- More than one sandbox per instance, or switching sandboxes at runtime (N2).
- Interactive programs that need a terminal (N3).
- Progress notifications for long `shell` calls. Copilot showed nothing for
  the full 600 s of a long call.
- Ship the client setup files (such as the Copilot hook that turns off the
  built-in shell) with the package, for example through an `init` command.

## Client support

| Client | Host | Status |
|--------|------|--------|
| Claude Code | Windows | Verified |
| GitHub Copilot in VS Code | Windows | Verified, including the hook that turns off the built-in shell |
| GitHub Copilot hook (`deny-shell.sh`) | Linux, macOS | Untested |
| Local-harness agent file | Windows | Untested |
| Copilot CLI with `--deny-tool` | Windows | Untested |
