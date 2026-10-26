# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
