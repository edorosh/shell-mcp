# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-10-26

### Added

- Create mode. With `--image`, shell-mcp creates and starts the sandbox named
  by `--sandbox` itself, so no hand-made sandbox is needed. New flags:
  `--image`, repeatable `--mount HOST:GUEST[:ro]` (the first is the project
  mount), `--allow-domain`, `--allow-network`, `--cpus`, `--memory`,
  `--recreate` and `--prepare`. Without `--image` the server attaches to an
  existing sandbox with `--host-root` and `--guest-root` as before.
- The sandbox is persistent: created once, reused by name, and not stopped
  when the client exits. Stop or remove it with `msb stop` / `msb remove`.
- The network is denied by default; `--allow-domain` and `--allow-network`
  open it, and private addresses always stay blocked.
- If the sandbox differs from the flags, shell-mcp refuses and lists the
  differences; `--recreate` removes and recreates it (deleting everything in
  the sandbox outside the mounts).
- The server answers the MCP handshake at once and prepares the sandbox in the
  background; an early tool call reports that it is still being prepared.
  `--prepare` does the first image pull in a terminal. `--check` stays
  read-only.
- On macOS, host symlinks in `--mount` paths are resolved automatically.

microsandbox SDK 0.7.11, expects msb 0.7.11.

## [1.1.0] - 2026-10-26

### Added

- macOS hosts on Apple Silicon. On an Intel Mac or an x64 Node under Rosetta,
  `--check` and the startup log say that macOS needs Apple Silicon and an arm64 Node.
- CI runs the tests and the pack check on macOS.

microsandbox SDK 0.7.11, tested with msb 0.7.11 on Windows and macOS (Apple
Silicon).

## [1.0.2] - 2026-10-26

### Fixed

- The MCP `initialize` response reports the package version instead of a
  hardcoded `0.1.0`.

## [1.0.1] - 2026-10-25

First release published from GitHub Actions with npm trusted publishing and
provenance. No change to the server.

### Fixed

- The pre-publish pack check reads npm 12's `npm pack --json` output and no
  longer triggers Node's DEP0190 warning on Windows.

microsandbox SDK 0.7.11, tested with msb 0.7.11 on Windows.

## [1.0.0] - 2026-10-25

First npm release.

microsandbox SDK 0.7.11, tested with msb 0.7.11 on Windows.
