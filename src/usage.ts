/** Help text for --help; keep in step with the README configuration table. */
export function usage(): string {
  return `Usage: shell-mcp [options]

Run shell commands inside a microsandbox, served over MCP on stdio.

Options (a flag wins over its environment variable):
  --sandbox <name>            Sandbox to run in. Env: SHELL_MCP_SANDBOX. Required.
  --host-root <path>          Absolute host directory mapped into the sandbox.
                              Env: SHELL_MCP_HOST_ROOT. Required.
  --guest-root <path>         Absolute POSIX path of that directory inside the sandbox.
                              Env: SHELL_MCP_GUEST_ROOT. Required.
  --default-timeout <time>    Timeout when a call gives none (e.g. 120s, 5m, 1500ms).
                              Env: SHELL_MCP_DEFAULT_TIMEOUT. Default: 120s.
  --max-timeout <time>        Upper limit for any call's timeout.
                              Env: SHELL_MCP_MAX_TIMEOUT. Default: 600s.
  --max-output <n>            Maximum output size returned per call.
                              Env: SHELL_MCP_MAX_OUTPUT. Default: 30000.
  --no-rewrite-output-paths   Do not rewrite guest paths in output to host paths.
                              Env: SHELL_MCP_REWRITE_OUTPUT_PATHS=0 (or false, no).
                              Default: rewriting on.
  --shell <name>              Shell used inside the sandbox.
                              Env: SHELL_MCP_SHELL. Default: bash.
  --check                     Check the setup and exit.
  --version                   Print the version and exit.
  --help                      Print this help and exit.

Docs: https://github.com/edorosh/shell-mcp#readme
`;
}
