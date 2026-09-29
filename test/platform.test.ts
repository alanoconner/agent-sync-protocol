import { describe, expect, it } from "vitest";
import { renderCommand, selfInvocation, shellDisplayQuote } from "../src/cli/platform.js";

describe("cross-platform command rendering", () => {
  const invocation = {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Users\\Test User\\agent sync\\index.js", "_hook", "codex", "pre"],
  };

  it("renders a Windows command without POSIX quoting", () => {
    expect(renderCommand(invocation, "windows")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Test User\\agent sync\\index.js" "_hook" "codex" "pre"',
    );
  });

  it("renders Windows paths for Git Bash", () => {
    expect(renderCommand(invocation, "git-bash")).toBe(
      "'/c/Program Files/nodejs/node.exe' '/c/Users/Test User/agent sync/index.js' '_hook' 'codex' 'pre'",
    );
  });

  it("keeps apostrophes safe in POSIX commands and uses Windows display quoting", () => {
    expect(renderCommand({ command: "/tmp/agent's node", args: [] }, "posix")).toBe("'/tmp/agent'\"'\"'s node'");
    expect(shellDisplayQuote("C:\\My Repo", "win32")).toBe('"C:\\My Repo"');
  });

  it("reinvokes installed JavaScript through Node", () => {
    expect(selfInvocation("/opt/agent-sync/dist/cli/index.js", false)).toEqual({
      command: process.execPath,
      args: ["/opt/agent-sync/dist/cli/index.js"],
    });
  });

  it("reinvokes a single executable without a filesystem entry point", () => {
    expect(selfInvocation("/path/that/must/not/be-used.js", true)).toEqual({
      command: process.execPath,
      args: [],
    });
  });
});
