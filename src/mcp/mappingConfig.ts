import { readFileSync } from "node:fs";
import { load } from "js-yaml";

export type EditMode = "full_replace" | "range_replace";

export interface WriteMapping {
  tool: string;
  op: "write";
  path_param: string;
  content_param: string;
  mode: EditMode;
  /** Required (and length 1) when mode is "range_replace": the arg name holding the exact text to match, e.g. "old_str". */
  range_params?: string[];
}

export interface ReadMapping {
  tool: string;
  op: "read";
  path_param: string;
}

export interface DeleteMapping {
  tool: string;
  op: "delete";
  path_param: string;
}

export type ToolMapping = WriteMapping | ReadMapping | DeleteMapping;

export interface MappingConfig {
  mappings: ToolMapping[];
}

/**
 * Parses a `.agent-sync-mcp-map.yml`-shaped document (Section 3.2). Deliberately
 * strict: an unrecognized `op`/`mode`, or a range_replace mapping missing
 * `range_params`, is a configuration error raised immediately rather than a
 * tool that silently misbehaves at call time — per spec, ambiguous/composite
 * tools require an explicit mapping, never an auto-detected guess.
 */
export function parseMappingConfig(yamlText: string): MappingConfig {
  const parsed = load(yamlText);
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>).mappings)) {
    throw new Error("mapping config must have a top-level `mappings` array");
  }
  const mappings = (parsed as { mappings: unknown[] }).mappings.map((raw, index) => validateMapping(raw, index));
  return { mappings };
}

function validateMapping(raw: unknown, index: number): ToolMapping {
  if (typeof raw !== "object" || raw === null) throw new Error(`mappings[${index}] must be an object`);
  const m = raw as Record<string, unknown>;
  if (typeof m.tool !== "string" || m.tool.length === 0) {
    throw new Error(`mappings[${index}].tool must be a non-empty string`);
  }
  if (typeof m.path_param !== "string" || m.path_param.length === 0) {
    throw new Error(`mappings[${index}] ("${m.tool}").path_param must be a non-empty string`);
  }

  if (m.op === "read") {
    return { tool: m.tool, op: "read", path_param: m.path_param };
  }

  if (m.op === "delete") {
    return { tool: m.tool, op: "delete", path_param: m.path_param };
  }

  if (m.op === "write") {
    if (typeof m.content_param !== "string" || m.content_param.length === 0) {
      throw new Error(`mappings[${index}] ("${m.tool}").content_param must be a non-empty string`);
    }
    if (m.mode !== "full_replace" && m.mode !== "range_replace") {
      throw new Error(
        `mappings[${index}] ("${m.tool}").mode must be "full_replace" or "range_replace" — an ambiguous or composite tool needs an explicit mode, never a guess (Section 3.2)`,
      );
    }
    if (m.mode === "range_replace") {
      if (!Array.isArray(m.range_params) || m.range_params.length === 0 || typeof m.range_params[0] !== "string") {
        throw new Error(`mappings[${index}] ("${m.tool}") mode "range_replace" requires range_params: [<old-string-arg-name>]`);
      }
      return {
        tool: m.tool,
        op: "write",
        path_param: m.path_param,
        content_param: m.content_param,
        mode: "range_replace",
        range_params: m.range_params as string[],
      };
    }
    return { tool: m.tool, op: "write", path_param: m.path_param, content_param: m.content_param, mode: "full_replace" };
  }

  throw new Error(`mappings[${index}] ("${m.tool}").op must be "read", "write", or "delete"`);
}

export function loadMappingConfigFile(path: string): MappingConfig {
  return parseMappingConfig(readFileSync(path, "utf8"));
}

/** Merges configs in priority order — the first config to name a given tool wins, so a project-local config can override a built-in preset entry without repeating the rest of it. */
export function mergeMappingConfigs(...configs: MappingConfig[]): MappingConfig {
  const mappings: ToolMapping[] = [];
  const seen = new Set<string>();
  for (const config of configs) {
    for (const mapping of config.mappings) {
      if (seen.has(mapping.tool)) continue;
      seen.add(mapping.tool);
      mappings.push(mapping);
    }
  }
  return { mappings };
}
