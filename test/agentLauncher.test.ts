import { describe, expect, it } from "vitest";
import { codexHookOverrides, validateForwardedArgs } from "../src/cli/agentLauncher.js";

describe("ASL agent launch configuration", () => {
  it("injects compiled Codex pre/post hooks without bypassing hook trust", () => {
    const values = codexHookOverrides();
    expect(values).toHaveLength(2);
    expect(values[0]).toContain("hooks.PreToolUse");
    expect(values[1]).toContain("hooks.PostToolUse");
    expect(values[0]).toContain('matcher="*"');
    expect(values[1]).toContain('matcher="^(apply_patch|Bash)$"');
    expect(values.join(" ")).toContain("'_hook' 'codex'");
    expect(values.join(" ")).toContain("command_windows=");
    expect(values.join(" ")).toContain('\\"_hook\\" \\"codex\\"');
    expect(values.join(" ")).not.toContain("bypass-hook-trust");
  });

  it("rejects workspace and hook flags owned by ASL", () => {
    expect(() => validateForwardedArgs("codex", ["-C", "/tmp/other"])).toThrow(/managed by ASL/);
    expect(() => validateForwardedArgs("codex", ["--cd=/tmp/other"])).toThrow(/managed by ASL/);
    expect(() => validateForwardedArgs("codex", ["-c", "hooks.PreToolUse=[]"])).toThrow(/hook configuration/);
    expect(() => validateForwardedArgs("codex", ["--config=hooks.PreToolUse=[]"])).toThrow(/hook configuration/);
    expect(() => validateForwardedArgs("claude", ["--settings", "other.json"])).toThrow(/managed by ASL/);
    expect(() => validateForwardedArgs("claude", ["--settings=other.json"])).toThrow(/managed by ASL/);
    expect(() => validateForwardedArgs("codex", ["--model", "gpt-test"])).not.toThrow();
  });
});
