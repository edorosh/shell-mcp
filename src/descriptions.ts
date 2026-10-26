import type { Config } from "./config.js";

export function describeTools(cfg: Config): {
  shell: string;
  shell_output: string;
  shell_kill: string;
  shell_list: string;
} {
  const def = Math.round(cfg.defaultTimeoutMs / 1000);
  const max = Math.round(cfg.maxTimeoutMs / 1000);
  const [proj, ...others] = cfg.mounts;
  const ro = (m: { readonly: boolean }) => (m.readonly ? " (read-only)" : "");
  const also = others.length
    ? `Also mounted: ${others.map((m) => `${m.host} at ${m.guest}${ro(m)}`).join(", ")}. `
    : "";
  return {
    shell:
      `Run a shell command (${cfg.shell}) inside an isolated Linux sandbox, not on the host machine. ` +
      `The host directory ${proj.host} is mounted in the sandbox at ${proj.guest}${ro(proj)}; the command starts in ${proj.guest} ` +
      `and only files under ${others.length ? "the mounted directories" : "that directory"} are shared with the host. ` +
      also +
      `The working directory persists between calls, but environment variables and shell state (aliases, functions) do not. ` +
      `Do not rely on cd across parallel calls: each starts in the directory current when it starts, and the last to finish sets it. ` +
      `Default timeout is ${def} seconds, maximum ${max} seconds (timeout_ms). ` +
      `Use run_in_background for servers and other long-running processes; it returns a job id to use with shell_output, shell_kill and shell_list. ` +
      `Interactive programs (editors, pagers, prompts waiting for input) are not supported. ` +
      (others.length
        ? `Paths in output under a mounted guest path are shown as the matching host paths. `
        : `Paths in output under ${proj.guest} are shown as host paths under ${proj.host}. `) +
      `To read or edit files, use your file tools with host paths (${proj.host}) rather than shell commands.`,
    shell_output:
      "Read new output from a background job started with shell, since the last call. Reports whether the job is still running and its exit code once finished.",
    shell_kill: "Stop a background job started with shell and report whether it has stopped.",
    shell_list: "List background jobs started in this session, with their state and command.",
  };
}
