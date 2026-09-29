// Standalone Codex hook entry point. The implementation lives in src so the
// example and the installed `asl _hook` command cannot drift apart.
import { readFileSync } from "node:fs";
import { runHook, type HookMode } from "../src/hooks/runner.js";

const mode = process.argv[2] as HookMode;
if (mode === "pre" || mode === "post") {
  process.exitCode = await runHook("codex", mode, readFileSync(0, "utf8"));
}
