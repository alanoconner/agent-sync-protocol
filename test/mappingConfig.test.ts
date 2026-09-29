import { describe, expect, it } from "vitest";
import { loadMappingConfigFile, parseMappingConfig } from "../src/mcp/mappingConfig.js";

describe("Phase 3: MCP mapping config", () => {
  it("parses the spec's own example file exactly as documented in Section 3.2", () => {
    const config = loadMappingConfigFile(new URL("../examples/agent-sync-mcp-map.example.yml", import.meta.url).pathname);
    expect(config.mappings).toEqual([
      { tool: "write_file", op: "write", path_param: "path", content_param: "content", mode: "full_replace" },
      {
        tool: "str_replace_based_edit_tool",
        op: "write",
        path_param: "path",
        content_param: "new_str",
        mode: "range_replace",
        range_params: ["old_str"],
      },
      { tool: "read_file", op: "read", path_param: "path" },
      { tool: "delete_file", op: "delete", path_param: "path" },
    ]);
  });

  it("rejects a write mapping with no mode rather than guessing one", () => {
    expect(() =>
      parseMappingConfig(`
mappings:
  - tool: "mystery_tool"
    op: write
    path_param: "path"
    content_param: "content"
`),
    ).toThrow(/mode/);
  });

  it("rejects range_replace with no range_params", () => {
    expect(() =>
      parseMappingConfig(`
mappings:
  - tool: "edit_tool"
    op: write
    path_param: "path"
    content_param: "new_str"
    mode: range_replace
`),
    ).toThrow(/range_params/);
  });

  it("rejects an unrecognized op", () => {
    expect(() =>
      parseMappingConfig(`
mappings:
  - tool: "rename_tool"
    op: rename
    path_param: "path"
`),
    ).toThrow(/op/);
  });

  it("parses an explicit delete mapping without content parameters", () => {
    expect(parseMappingConfig(`
mappings:
  - tool: delete_file
    op: delete
    path_param: path
`).mappings).toEqual([{ tool: "delete_file", op: "delete", path_param: "path" }]);
  });

  it("rejects a config with no top-level mappings array", () => {
    expect(() => parseMappingConfig("not_mappings: []")).toThrow(/mappings/);
  });
});
