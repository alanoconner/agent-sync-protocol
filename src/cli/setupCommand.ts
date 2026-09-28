import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function yarnCommand(repoRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { packageManager?: string };
    const match = /^yarn@(\d+)/.exec(pkg.packageManager ?? "");
    if (match && Number(match[1]) >= 2) return "yarn install --immutable";
  } catch { /* package.json is optional for detection */ }
  return "yarn install --frozen-lockfile";
}

export function detectSetupCommand(repoRoot: string): string | undefined {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(join(repoRoot, "yarn.lock"))) return yarnCommand(repoRoot);
  if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) return "bun install --frozen-lockfile";
  if (existsSync(join(repoRoot, "package-lock.json")) || existsSync(join(repoRoot, "npm-shrinkwrap.json"))) return "npm ci";
  return undefined;
}
