import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { BackendError } from "../src/backend/types.js";
import { parseConfig } from "../src/config.js";
import { describeTools } from "../src/descriptions.js";
import { ShellService } from "../src/service.js";
import { createServer } from "../src/tools.js";
import { FakeBackend } from "./fakeBackend.js";

const cfg = parseConfig(
  ["--sandbox", "sb", "--host-root", "C:\\Users\\e\\proj", "--guest-root", "/workspace"],
  {},
  { platform: "win32", exists: () => true },
);

async function connect() {
  const fb = new FakeBackend();
  const svc = new ShellService(cfg, fb, { nonce: "n" });
  const server = createServer(cfg, svc);
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { fb, client };
}
const textOf = (r: any) => (r.content as Array<{ type: string; text: string }>)[0]!.text;

describe("MCP registration", () => {
  it("lists the four tools with descriptions", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const d = describeTools(cfg);
    expect(tools.map((t) => t.name).sort()).toEqual(["shell", "shell_kill", "shell_list", "shell_output"]);
    for (const t of tools) expect(t.description).toBe(d[t.name as keyof typeof d]);
  });

  it("calls shell", async () => {
    const { fb, client } = await connect();
    fb.queueRun({ output: "hi\n\n__SHELLMCP_CWD_n__/workspace\n", exitCode: 0, timedOut: false, droppedChars: 0 });
    const r = await client.callTool({ name: "shell", arguments: { command: "echo hi" } });
    expect(textOf(r)).toContain("exit code: 0");
    expect(r.isError).toBeFalsy();
  });

  it("maps service errors to isError", async () => {
    const { fb, client } = await connect();
    fb.queueRun(new BackendError("not_running", "x"));
    const r = await client.callTool({ name: "shell", arguments: { command: "a" } });
    expect(r.isError).toBe(true);
  });

  it("rejects invalid input and stays up", async () => {
    const { client } = await connect();
    let failed = false;
    try {
      const r = await client.callTool({ name: "shell", arguments: {} });
      failed = r.isError === true;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const r = await client.callTool({ name: "shell_list", arguments: {} });
    expect(textOf(r)).toContain("No background jobs");
  });

  it("job tools work through MCP", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "shell_output", arguments: { job_id: "zz" } });
    expect(r.isError).toBe(true);
  });
});
