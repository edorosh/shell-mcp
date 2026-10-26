# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
