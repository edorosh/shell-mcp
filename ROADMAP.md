# shell-mcp Roadmap

Milestones in delivery order. Each milestone ships on its own. Requirement IDs
(G1, N6, ...) refer to the [product spec](docs/product-spec.md).

## v1: Sandboxed shell tool on Windows

Status: planned. Spec: [product-spec.md](docs/product-spec.md).
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

## v2: npm package for easy install on Windows

Status: next.

Goal: a Windows user installs and configures shell-mcp without cloning or
building the repo.

- Publish to the npm registry under a scope the user owns (e.g.
  `@<scope>/shell-mcp`). The unscoped name `shell-mcp` belongs to an unrelated
  package, so the docs must never say `npx shell-mcp`.
- Run with `npx -y @<scope>/shell-mcp ...` or install globally with
  `npm i -g @<scope>/shell-mcp`. The `bin` entry works from `cmd`, PowerShell
  and the clients' MCP launchers on Windows.
- Pin the `microsandbox` SDK version exactly and document the supported `msb`
  runtime version for each release.
- Release pipeline: build, test and publish from CI on a version tag, with npm
  provenance. Semver, with a changelog.
- Update the README and client setup snippets (Claude Code, GitHub Copilot) to
  use the published package.

## Later (unscheduled)

Deferred by the v1 spec. None of these is committed to a milestone yet.

- Linux and macOS hosts (N6).
- Backends other than microsandbox, e.g. Docker sbx (N5).
- More than one sandbox per instance, or switching sandboxes at runtime (N2).
- Sandbox lifecycle management: create, start, stop, delete (N1).
- Interactive programs that need a terminal (N3).
