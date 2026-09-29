import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(root, "artifacts", "npm");
mkdirSync(output, { recursive: true });
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmCli ? [npmCli, "pack", "--pack-destination", output] : ["pack", "--pack-destination", output];
const cache = mkdtempSync(join(tmpdir(), "asl-pack-cache-"));
try {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    shell: !npmCli && process.platform === "win32",
    env: { ...process.env, npm_config_cache: cache },
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  rmSync(cache, { recursive: true, force: true });
}
