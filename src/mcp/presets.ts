import type { MappingConfig } from "./mappingConfig.js";

/**
 * Matches the exact tool shape used by common reference filesystem MCP servers
 * (and the example in spec Section 3.2 itself) — ship this so most setups need
 * zero config.
 */
export const genericFilesystemPreset: MappingConfig = {
  mappings: [
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
  ],
};

/**
 * Claude Code's own built-in tool names — useful when another agent's exposed
 * MCP surface reuses this exact shape, or as a copy-pasteable second example
 * per Section 3.4.
 */
export const claudeCodePreset: MappingConfig = {
  mappings: [
    { tool: "Write", op: "write", path_param: "file_path", content_param: "content", mode: "full_replace" },
    {
      tool: "Edit",
      op: "write",
      path_param: "file_path",
      content_param: "new_string",
      mode: "range_replace",
      range_params: ["old_string"],
    },
    { tool: "Read", op: "read", path_param: "file_path" },
  ],
};
