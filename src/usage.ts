/** Help text for --help; keep in step with the table in docs/configuration.md. */
export function usage(): string {
  return `Usage: shell-mcp [options]

Run shell commands inside a microsandbox, served over MCP on stdio.

Options (a flag wins over its environment variable):
  --sandbox <name>            Sandbox to run in. Env: SHELL_MCP_SANDBOX. Required.
  --host-root <path>          Attach mode: absolute host directory mapped into the sandbox.
                              Env: SHELL_MCP_HOST_ROOT. Required without --image.
  --guest-root <path>         Attach mode: absolute POSIX path of that directory inside
                              the sandbox. Env: SHELL_MCP_GUEST_ROOT. Required without --image.

Create mode (with --image; --host-root and --guest-root are then an error):
  --image <ref>               OCI image; switches on create mode. Env: SHELL_MCP_IMAGE.
  --mount <host:guest[:ro]>   Bind mount, repeatable, at least one; the first is the project
                              mount. Env: SHELL_MCP_MOUNT (separated by ;).
  --allow-domain <host>       Allow one host, or a suffix such as *.example.com. Repeatable.
                              Env: SHELL_MCP_ALLOW_DOMAIN (separated by ,).
  --allow-network             Allow all public hosts. Env: SHELL_MCP_ALLOW_NETWORK=1 (or true, yes).
  --cpus <n>                  Number of vCPUs. Env: SHELL_MCP_CPUS. Default: SDK default.
  --memory <size>             Memory in MiB (2048) or with a g suffix (2g).
                              Env: SHELL_MCP_MEMORY. Default: SDK default.
  --recreate                  When the sandbox differs from these flags, remove and recreate it.
                              No env var.
  --prepare                   Provision the sandbox in the foreground, print progress and exit.

Other options:
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
