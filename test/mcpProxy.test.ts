import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SyncServer } from "../src/server/syncServer.js";
import { SyncClient } from "../src/client/SyncClient.js";
import { McpSyncProxy } from "../src/mcp/proxy.js";
import { genericFilesystemPreset } from "../src/mcp/presets.js";

/** A minimal fake "real" MCP filesystem server, backed by an in-memory `disk` Map — stands in for whatever server the proxy is actually fronting, so tests can assert mapped calls never reach it and unmapped calls do. */
function createFakeFilesystemServer() {
  const disk = new Map<string, string>();
  const server = new Server({ name: "fake-fs", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "write_file",
        inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
      { name: "read_file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      {
        name: "str_replace_based_edit_tool",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" } },
          required: ["path", "old_str", "new_str"],
        },
      },
      { name: "list_directory", inputSchema: { type: "object", properties: {} } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    if (name === "write_file") {
      disk.set(String(args?.path), String(args?.content));
      return { content: [{ type: "text", text: `wrote ${args?.path} to real disk` }] };
    }
    if (name === "read_file") {
      const content = disk.get(String(args?.path));
      if (content === undefined) return { isError: true, content: [{ type: "text", text: "ENOENT" }] };
      return { content: [{ type: "text", text: content }] };
    }
    if (name === "list_directory") {
      return { content: [{ type: "text", text: JSON.stringify(Array.from(disk.keys())) }] };
    }
    return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
  });

  return { server, disk };
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected a text content block");
  return block.text;
}

describe("Phase 3: generic MCP proxy (Section 3.2)", () => {
  let syncServer: SyncServer;
  let syncServerUrl: string;
  let proxy: McpSyncProxy;
  let agentClient: Client;
  let fakeUpstream: ReturnType<typeof createFakeFilesystemServer>;
  const rawClients: SyncClient[] = [];

  beforeEach(async () => {
    syncServer = new SyncServer(0);
    syncServerUrl = `ws://localhost:${syncServer.port}`;
    fakeUpstream = createFakeFilesystemServer();
    proxy = new McpSyncProxy({
      serverInfo: { name: "agent-sync-proxy", version: "0.1.0" },
      mapping: genericFilesystemPreset,
      syncServerUrl,
    });

    const [agentTransport, proxyServerTransport] = InMemoryTransport.createLinkedPair();
    const [proxyUpstreamTransport, upstreamServerTransport] = InMemoryTransport.createLinkedPair();

    await fakeUpstream.server.connect(upstreamServerTransport);
    await proxy.connectUpstream(proxyUpstreamTransport);
    await proxy.connectAgent(proxyServerTransport);

    agentClient = new Client({ name: "test-agent", version: "1.0.0" });
    await agentClient.connect(agentTransport);
  });

  afterEach(async () => {
    await agentClient.close();
    await proxy.close();
    for (const client of rawClients.splice(0)) client.close();
    await syncServer.close();
  });

  function makeRawClient(docName: string): SyncClient {
    const client = new SyncClient({ serverUrl: syncServerUrl, docName });
    rawClients.push(client);
    return client;
  }

  it("passes through the upstream tool list unchanged — the agent can't tell a proxy exists", async () => {
    const { tools } = await agentClient.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_directory", "read_file", "str_replace_based_edit_tool", "write_file"]);
  });

  it("diverts a mapped write_file call into the sync layer instead of the real upstream disk", async () => {
    const result = await agentClient.callTool({ name: "write_file", arguments: { path: "shared.ts", content: "hello from agent" } });
    expect(result.isError).toBeFalsy();
    expect(fakeUpstream.disk.has("shared.ts")).toBe(false);

    const observer = makeRawClient("shared.ts");
    await observer.connect();
    await observer.whenSynced();
    expect(observer.getText().toString()).toBe("hello from agent");
  });

  it("diverts a mapped read_file call to return the sync layer's live content, not disk", async () => {
    const seed = makeRawClient("live.ts");
    await seed.connect();
    await seed.whenSynced();
    seed.getText().insert(0, "content only the sync layer has");

    const result = await agentClient.callTool({ name: "read_file", arguments: { path: "live.ts" } });
    expect(textOf(result)).toBe("content only the sync layer has");
    expect(fakeUpstream.disk.has("live.ts")).toBe(false);
  });

  it("passes an unmapped tool straight through to the real upstream server untouched", async () => {
    const before = await agentClient.callTool({ name: "list_directory", arguments: {} });
    expect(textOf(before)).toBe("[]");

    // A mapped write never reaches the fake upstream's disk...
    await agentClient.callTool({ name: "write_file", arguments: { path: "shared.ts", content: "x" } });
    const after = await agentClient.callTool({ name: "list_directory", arguments: {} });
    expect(textOf(after)).toBe("[]");
  });

  it("a range_replace edit merges with a concurrent edit made elsewhere in the same file", async () => {
    await agentClient.callTool({ name: "write_file", arguments: { path: "range.ts", content: "AAAA BBBB CCCC" } });

    const other = makeRawClient("range.ts");
    await other.connect();
    await other.whenSynced();
    other.getText().insert(0, "HEADER\n");

    // Confirm the header has actually reached the sync server (not just `other`'s
    // own local Yjs state) before the mapped tool call spins up its own fresh
    // SyncClient for this path — otherwise this is a race against propagation.
    const probe = makeRawClient("range.ts");
    await probe.connect();
    await probe.whenSynced();
    await vi.waitFor(() => expect(probe.getText().toString()).toBe("HEADER\nAAAA BBBB CCCC"));

    const result = await agentClient.callTool({
      name: "str_replace_based_edit_tool",
      arguments: { path: "range.ts", old_str: "BBBB", new_str: "ZZZZ" },
    });
    expect(result.isError).toBeFalsy();

    const read = await agentClient.callTool({ name: "read_file", arguments: { path: "range.ts" } });
    expect(textOf(read)).toBe("HEADER\nAAAA ZZZZ CCCC");
  });

  it("rejects a range_replace whose old_str no longer matches, with an EAGAIN-coded, actionable message", async () => {
    await agentClient.callTool({ name: "write_file", arguments: { path: "stale.ts", content: "original content" } });

    const result = await agentClient.callTool({
      name: "str_replace_based_edit_tool",
      arguments: { path: "stale.ts", old_str: "text that was never there", new_str: "x" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^EAGAIN:/);
    expect(textOf(result)).toMatch(/re-read/i);

    // The rejected edit must not have been applied at all.
    const read = await agentClient.callTool({ name: "read_file", arguments: { path: "stale.ts" } });
    expect(textOf(read)).toBe("original content");
  });

  it("rejects an ambiguous range_replace match rather than guessing which occurrence was meant", async () => {
    await agentClient.callTool({ name: "write_file", arguments: { path: "dup.ts", content: "foo bar foo baz" } });

    const result = await agentClient.callTool({
      name: "str_replace_based_edit_tool",
      arguments: { path: "dup.ts", old_str: "foo", new_str: "qux" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^EAGAIN:/);
  });
});
