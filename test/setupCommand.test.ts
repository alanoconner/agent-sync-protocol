import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSetupCommand } from "../src/cli/setupCommand.js";

const dirs: string[] = [];
function fixture(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "asl-setup-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("ASL worktree setup detection", () => {
  it("detects npm, pnpm, Bun, and Yarn lockfiles", () => {
    expect(detectSetupCommand(fixture({ "package-lock.json": "{}" }))).toBe("npm ci");
    expect(detectSetupCommand(fixture({ "pnpm-lock.yaml": "" }))).toBe("pnpm install --frozen-lockfile");
    expect(detectSetupCommand(fixture({ "bun.lock": "" }))).toBe("bun install --frozen-lockfile");
    expect(detectSetupCommand(fixture({ "yarn.lock": "" }))).toBe("yarn install --frozen-lockfile");
  });

  it("uses immutable installs for modern Yarn and does nothing without a lockfile", () => {
    expect(detectSetupCommand(fixture({ "yarn.lock": "", "package.json": '{"packageManager":"yarn@4.1.0"}' }))).toBe("yarn install --immutable");
    expect(detectSetupCommand(fixture())).toBeUndefined();
  });
});
