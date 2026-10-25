import type { Config } from "./config.js";

export function describeTools(cfg: Config): {
  shell: string;
  shell_output: string;
  shell_kill: string;
  shell_list: string;
} {
  const def = Math.round(cfg.defaultTimeoutMs / 1000);
  const max = Math.round(cfg.maxTimeoutMs / 1000);
  return {
    shell:
      `Run a shell command (${cfg.shell}) inside an isolated Linux sandbox, not on the host machine. ` +
      `The host directory ${cfg.hostRoot} is mounted in the sandbox at ${cfg.guestRoot}; the command starts in ${cfg.guestRoot} ` +
      `and only files under that directory are shared with the host. ` +
      `The working directory persists between calls, but environment variables and shell state (aliases, functions) do not. ` +
      `Default timeout is ${def} seconds, maximum ${max} seconds (timeout_ms). ` +
      `Use run_in_background for servers and other long-running processes; it returns a job id to use with shell_output, shell_kill and shell_list. ` +
      `Interactive programs (editors, pagers, prompts waiting for input) are not supported. ` +
      `Paths in output under ${cfg.guestRoot} are shown as host paths under ${cfg.hostRoot}. ` +
      `To read or edit files, use your file tools with host paths (${cfg.hostRoot}) rather than shell commands.`,
    shell_output:
      "Read new output from a background job started with shell, since the last call. Reports whether the job is still running and its exit code once finished.",
    shell_kill: "Stop a background job started with shell and report whether it has stopped.",
    shell_list: "List background jobs started in this session, with their state and command.",
  };
}
