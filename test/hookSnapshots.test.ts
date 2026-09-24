import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookSnapshots } from "../examples/hookSnapshots.js";

describe("hook snapshot isolation", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("isolates identical paths across workspaces, sessions, and tool calls", () => {
    const directory = mkdtempSync(join(tmpdir(), "snapshot-test-"));
    directories.push(directory);
    const store = new HookSnapshots(directory);
    const base = { workspaceRoot: "/work/a", sessionId: "one", toolUseId: "edit-1" };
    const identities = [base, { ...base, workspaceRoot: "/work/b" }, { ...base, sessionId: "two" }, { ...base, toolUseId: "edit-2" }];
    identities.forEach((identity, index) => store.stash(identity, "src/foo.ts", `baseline ${index}`));
    identities.forEach((identity, index) => expect(store.take(identity, "src/foo.ts")).toBe(`baseline ${index}`));
    expect(() => store.take(base, "src/foo.ts")).toThrow();
    expect(() => store.stash({ workspaceRoot: "/work/a" }, "src/foo.ts", "")).toThrow(/tool_use_id/);
  });
});
