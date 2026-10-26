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
with trusted publishing; 1.0.2 was the last v2 release. Milestone numbers and package
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

## v2.1: macOS hosts

Status: done (2026-10-26). Released as npm 1.1.0. On an Apple Silicon Mac,
`--check` and Claude Code pass with the published 1.1.0; the acceptance suite
(12 of 12) and Copilot with the hook passed with 1.0.2 in the spike and were
not rerun, since 1.1.0 changes only the unsupported-Mac message, CI and docs.
Takes on the macOS half of N6.
Design: [v2.1 macOS design](docs/superpowers/specs/2026-10-26-shell-mcp-v2.1-macos-design.md).
Spike: [v2.1 macOS spike results](docs/superpowers/specs/v2.1-macos-spike-results.md).

Goal: a developer on an Apple Silicon Mac installs and runs shell-mcp from npm
the same way a Windows user does, with no separate `msb` install.

- Supported: Apple Silicon with an arm64 Node. The pinned SDK ships no Intel
  macOS package; on an Intel Mac or under Rosetta, `--check` and the startup
  log say so instead of the generic reinstall hint.
- CI runs typecheck, build, unit tests and the pack check on macOS as well.
- Docs for macOS: creating the sandbox with the bundled `msb`
  (`npx -y -p microsandbox@<sdk version> msb ...`) and the resolved project path
  (`msb` refuses mounts through a symlink), arm64 images, the guest seeing the
  Mac's case-insensitive file system, and client configs with `/Users/<you>/...`.
- Mark Claude Code, Copilot and the `deny-shell.sh` hook verified on macOS.

Done when: with the published 1.1.0 on an Apple Silicon Mac, `--check` passes,
the acceptance suite passes 12 of 12, and Claude Code and Copilot run
`uname -a` in the sandbox with the built-in shell turned off.

## v3: Sandbox created from the MCP config

Status: merged to `main` (PR #16); release pending (tag v1.2.0).
Design: [v3 create-sandbox design](docs/superpowers/specs/2026-10-26-shell-mcp-v3-create-sandbox-design.md).
Plan: [v3 implementation plan](docs/superpowers/plans/2026-10-26-shell-mcp-v3.md).

Goal: shell-mcp creates and starts its microsandbox machine when the MCP server
starts, so the user no longer prepares a sandbox by hand. This takes on
sandbox lifecycle management (N1) in a new create mode.

- `--image` switches on create mode; `--sandbox` stays the sandbox name. Without
  `--image` the server attaches to an existing sandbox as in v2, so v2 configs
  keep working.
- The machine is defined by flags: `--image`, repeatable `--mount HOST:GUEST[:ro]`
  (the first is the project mount; host symlinks are resolved for `msb`),
  `--allow-domain` / `--allow-network`, `--cpus`, `--memory`.
- The sandbox is persistent: created on first start, reused by name later, and
  never stopped when the server exits.
- If the sandbox no longer matches the flags, shell-mcp refuses and lists the
  differences; `--recreate` removes and recreates it.
- Network access is denied unless allowed; private addresses always stay blocked.
- The server answers the MCP handshake at once and provisions in the
  background; an early tool call says the sandbox is still being prepared.
  `--prepare` provisions in the terminal and exits. `--check` stays read-only.
- Path translation (G3) follows the configured mounts.
- Ships as npm 1.2.0.

Done when: a user with no hand-made sandbox adds one MCP config entry, and the
first `shell` call runs in a sandbox shell-mcp created, with the project folder
mounted, on Windows and on an Apple Silicon Mac, in Claude Code and Copilot.

## v3.1: Sandbox definition in a config file

Status: idea.

Goal: a project describes its sandbox in a file checked into the repo, so a team
shares one definition and richer settings fit without long flag lists.

- A project `shell-mcp.json` passed with `--config`, holding what v3's flags
  hold (image, mounts, network rules, resources) plus room for more structure,
  such as environment variables and finer network rules.
- Secrets: pass a host environment variable into the sandbox as a placeholder
  that microsandbox swaps for the real value only on requests to allowed
  hosts, so the guest never sees the token. Each secret names its env var,
  allowed hosts and, optionally, its own placeholder. A custom placeholder is
  needed for tools that check the token's format (Copilot rejects the default
  `$MSB_<VAR>`). Only the SDK can set it (`SecretBuilder.placeholder()`); the
  `msb` CLI and its YAML config cannot, so create mode is the way to get it.
- v3 flags keep working.

Done when: one MCP entry with `--config` gives the same sandbox as the
equivalent v3 flags.

## Project site on GitHub Pages

Status: idea. Not tied to a package release.

Goal: a public page that explains what shell-mcp is, so people who find the
repo or the npm package see the project at a glance.

- A GitHub Pages site for the repo with the project description: what it
  does, why commands run in a sandbox, supported hosts and clients, and a
  quick start with a pinned `npx -y @edorosh/shell-mcp@x.y.z` example.
- Links to the docs pages, the npm package, the changelog and this roadmap.
- Built and deployed from `main` by a GitHub Actions workflow, with no
  content duplicated from `docs/` by hand.
- Link the site from the README, the npm package `homepage` and the repo
  description.

Done when: the Pages URL shows the project description and quick start, and
the README and npm page link to it.

## v4: Linux hosts

Status: idea. Takes on the rest of N6 (macOS is v2.1).

Goal: shell-mcp runs on Linux hosts as well as Windows and macOS.

- Path translation for POSIX host paths (already used on macOS since v2.1).
- Run the acceptance suite on a Linux host; CI already runs the unit tests
  there.
- Test the Copilot hook (`deny-shell.sh`) with a real client on Linux
  (verified on macOS in v2.1).
- npm stays the install method on every host. A Homebrew formula in our own
  tap is optional, only if macOS users ask for it: it would still wrap npm,
  and `brew upgrade` would undo the exact version pin that keeps the SDK and
  `msb` matched.

Done when: the acceptance suite passes on a Linux host with Claude Code and
Copilot.

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
| Claude Code | macOS (Apple Silicon) | Verified in the v2.1 spike with 1.0.2 |
| GitHub Copilot in VS Code | Windows | Verified, including the hook that turns off the built-in shell |
| GitHub Copilot in VS Code | macOS (Apple Silicon) | Verified in the v2.1 spike with 1.0.2, including `deny-shell.sh` |
| GitHub Copilot hook (`deny-shell.sh`) | Linux | Untested |
| Local-harness agent file | Windows | Untested |
| Copilot CLI with `--deny-tool` | Windows | Untested |
