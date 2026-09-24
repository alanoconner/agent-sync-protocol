import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SyncFileOps } from "../sync/syncFileOps.js";
import { resolveSyncFileOpsOptions, type AgentSyncConfig } from "../config/agentSyncConfig.js";
import type { MappingConfig, ReadMapping, WriteMapping } from "./mappingConfig.js";

export interface McpSyncProxyOptions {
  /** Name/version this proxy presents both as an MCP server (to the agent) and MCP client (to the upstream server). */
  serverInfo: { name: string; version: string };
  mapping: MappingConfig;
  /** A parsed `.agent-sync.yml` (Phase 7, Section 7) — supplies `server` (the sync server URL) and `paths.exclusive`. Every explicit field below overrides its config counterpart; see `resolveSyncFileOpsOptions`. */
  config?: AgentSyncConfig;
  /** Sync server URL. Required unless `config` is given. */
  syncServerUrl?: string;
  /** Phase 6: paths that go through the lock service instead of relying on CRDT merge alone — see `SyncFileOpsOptions.exclusivePaths`. Replaces `config.paths.exclusive` when set. */
  exclusivePaths?: string[];
  /** Identifies this proxy instance as a lock owner; see `SyncFileOpsOptions.ownerId`. */
  ownerId?: string;
  /** Lock lease length per write; see `SyncFileOpsOptions.lockLeaseMs`. */
  lockLeaseMs?: number;
}

/**
 * Generic pass-through MCP proxy (Section 3.2). Sits between an agent and
 * whatever real MCP server it would normally talk to: forwards `tools/list`
 * verbatim, passes through any unmapped `tools/call` untouched, and diverts
 * mapped write/read tool calls into the sync layer instead of the upstream
 * server. Supporting a new upstream server is a mapping-config change, never a
 * change to this class.
 */
export class McpSyncProxy {
  readonly server: Server;
  private readonly upstream: Client;
  private readonly ops: SyncFileOps;
  private readonly writeMappings = new Map<string, WriteMapping>();
  private readonly readMappings = new Map<string, ReadMapping>();

  constructor(options: McpSyncProxyOptions) {
    this.upstream = new Client({ name: `${options.serverInfo.name}-upstream-client`, version: options.serverInfo.version });
    this.server = new Server(options.serverInfo, { capabilities: { tools: {} } });
    this.ops = new SyncFileOps(
      resolveSyncFileOpsOptions(options.config, {
        syncServerUrl: options.syncServerUrl,
        exclusivePaths: options.exclusivePaths,
        ownerId: options.ownerId,
        lockLeaseMs: options.lockLeaseMs,
      }),
    );

    for (const mapping of options.mapping.mappings) {
      if (mapping.op === "write") this.writeMappings.set(mapping.tool, mapping);
      else this.readMappings.set(mapping.tool, mapping);
    }

    // Same names, same schemas, same descriptions — the agent never knows a proxy exists.
    this.server.setRequestHandler(ListToolsRequestSchema, (request) => this.upstream.listTools(request.params));

    this.server.setRequestHandler(CallToolRequestSchema, (request) => this.handleCallTool(request.params));
  }

  /** Connects this proxy's upstream MCP client to the real server it's fronting. */
  async connectUpstream(transport: Transport): Promise<void> {
    await this.upstream.connect(transport);
  }

  /** Connects this proxy's MCP server side to the transport the agent talks to. */
  async connectAgent(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  private async handleCallTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> {
    const { name, arguments: args } = params;

    const write = this.writeMappings.get(name);
    if (write) return this.handleMappedWrite(write, args ?? {});

    const read = this.readMappings.get(name);
    if (read) return this.handleMappedRead(read, args ?? {});

    // Unmapped tool: pure pass-through, request and response untouched.
    return this.upstream.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  }

  private async handleMappedWrite(mapping: WriteMapping, args: Record<string, unknown>): Promise<CallToolResult> {
    const path = String(args[mapping.path_param]);
    const content = String(args[mapping.content_param]);
    try {
      if (mapping.mode === "full_replace") {
        await this.ops.writeFileFull(path, content);
      } else {
        const oldStrParam = mapping.range_params?.[0];
        if (!oldStrParam) {
          throw new Error(`mapping for "${mapping.tool}" declares mode "range_replace" with no range_params`);
        }
        const oldStr = String(args[oldStrParam]);
        await this.ops.writeFileRange(path, oldStr, content);
      }
      // Shape the success response the way the real tool would (Section 3.2) — a plain
      // text-content confirmation, which is the conventional MCP shape for a write tool.
      return { content: [{ type: "text", text: `Successfully wrote to ${path}` }] };
    } catch (err) {
      return this.toErrorResult(err);
    }
  }

  private async handleMappedRead(mapping: ReadMapping, args: Record<string, unknown>): Promise<CallToolResult> {
    const path = String(args[mapping.path_param]);
    try {
      const content = await this.ops.readFile(path);
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return this.toErrorResult(err);
    }
  }

  /** Section 3.5: fail in the shape the tool's caller already knows how to interpret — MCP's own conventional failure shape is `isError: true` plus text content, never a novel response shape. Section 3.6: put the actionable instruction (and, where one exists, the OS-style code — `RangeMismatchError`'s EAGAIN, `ValidationRejectedError`'s EVALIDATE) in that text. Checking for a `.code` rather than each error class by name means a new coded rejection type needs no change here. */
  private toErrorResult(err: unknown): CallToolResult {
    const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
    if (err instanceof Error && typeof code === "string") {
      return { isError: true, content: [{ type: "text", text: `${code}: ${err.message}` }] };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  async close(): Promise<void> {
    await this.ops.close();
    await this.upstream.close();
    await this.server.close();
  }
}
