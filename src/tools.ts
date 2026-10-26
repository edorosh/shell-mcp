import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { describeTools } from "./descriptions.js";
import type { CallContext, ShellService, ToolResult } from "./service.js";

const out = (r: ToolResult) => ({ content: [{ type: "text" as const, text: r.text }], isError: r.isError });

export function createServer(cfg: Config, service: ShellService, version: string): McpServer {
  const server = new McpServer({ name: "shell-mcp", version });
  const d = describeTools(cfg);

  server.registerTool(
    "shell",
    {
      description: d.shell,
      inputSchema: {
        command: z.string().describe("The shell command to run"),
        description: z.string().optional().describe("Short description of what the command does"),
        timeout_ms: z.number().int().optional().describe("Timeout in milliseconds"),
        run_in_background: z.boolean().optional().describe("Run as a background job and return a job id"),
      },
    },
    async (args, extra) => {
      const ctx: CallContext = { signal: extra.signal };
      const token = extra._meta?.progressToken;
      if (token !== undefined) {
        ctx.onProgress = (elapsedSec) => {
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken: token, progress: elapsedSec, message: "running" },
            })
            .catch(() => {});
        };
      }
      return out(await service.shell(args, ctx));
    },
  );

  server.registerTool(
    "shell_output",
    { description: d.shell_output, inputSchema: { job_id: z.string().describe("Job id returned by shell") } },
    async (args) => out(await service.output(args)),
  );
  server.registerTool(
    "shell_kill",
    { description: d.shell_kill, inputSchema: { job_id: z.string().describe("Job id returned by shell") } },
    async (args) => out(await service.kill(args)),
  );
  server.registerTool("shell_list", { description: d.shell_list }, async () => out(await service.list()));

  return server;
}
