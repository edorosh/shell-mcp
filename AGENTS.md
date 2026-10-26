# AGENTS.md

Guidance for coding agents working on this repository. Humans: see
[docs/development.md](docs/development.md).

## What this is

`@edorosh/shell-mcp`: an MCP server (stdio, TypeScript, Node 22+) that runs on a
Windows or macOS (Apple Silicon) host and executes shell commands inside an existing microsandbox
sandbox. The requirements are in [docs/product-spec.md](docs/product-spec.md);
requirement IDs (C4, S5, P4, ...) are cited in code and tests.

## Commands

```sh
npm ci
npm run typecheck
npm test            # unit tests, no sandbox needed
npm run build
npm run check:pack  # what the published tarball contains and that the bin starts
```

CI runs typecheck, build and tests on Ubuntu, Windows and macOS, plus the pack
check on Windows and macOS. `test/integration.test.ts` needs a real sandbox on a
Windows host or an Apple Silicon Mac (`SHELL_MCP_IT_*` variables) and is skipped otherwise; you cannot run it from a
Linux container.

## Layout

- `src/index.ts`: entry point and modes (`--help`, `--version`, `--check`, MCP).
- `src/config.ts` flags and env; `src/usage.ts` help text;
  `src/check.ts` the `--check` steps; `src/runtime.ts` the `msb` version check.
- `src/tools.ts`, `src/descriptions.ts`: MCP tools and their descriptions.
- `src/service.ts`, `src/jobs.ts`, `src/wrap.ts`, `src/output.ts`, `src/paths.ts`:
  command execution, background jobs, cwd tracking, output limits, path mapping.
- `src/backend/`: the backend interface and the microsandbox implementation. Keep
  SDK-specific code there.
- `docs/superpowers/`: design specs, plans and spike results per milestone.

## Rules

- Never add a code path that runs agent commands on the host (spec X1, A1;
  `test/no-host-exec.test.ts` guards it).
- Nothing but MCP messages on stdout while serving; diagnostics go to stderr (C9).
- `microsandbox` stays pinned to an exact version; it must match the `msb` runtime.
- Do not run `npx @edorosh/shell-mcp@...` inside this clone: npx runs the local
  copy. Use another folder for checks of the published package.
- Do not share `node_modules` between Windows and a Linux sandbox. TypeScript 7
  and microsandbox install per-platform packages (see docs/development.md).
- Docs: keep `README.md` minimal (what it is, quick start, contributing). Put
  setup detail, configuration, troubleshooting and known issues in the matching
  `docs/` page. When a feature ships, update `docs/product-spec.md`, the
  `[Unreleased]` section of `CHANGELOG.md`, and `ROADMAP.md` if a milestone moves.
- Flags change in three places: `src/config.ts`, `src/usage.ts` and the table in
  `docs/configuration.md`.
- In docs and examples, use the `C:\Users\<you>\...` placeholder, never a real
  user name, and pin the package with an exact version
  (`@edorosh/shell-mcp@x.y.z`). Never write `npx shell-mcp`; the unscoped name
  is an unrelated package.
- Releases follow [docs/releasing.md](docs/releasing.md). Agents never publish
  to npm or push tags unless asked.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `docs:`, `ci:`,
  `chore:`, `test:`).
