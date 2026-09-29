import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const platformName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
const artifactRoot = resolve(process.env.ASL_ARTIFACT_DIR ?? join(root, "artifacts"));
const targetName = `${pkg.name}-v${pkg.version}-${platformName}-${process.arch}`;
const targetDir = join(artifactRoot, targetName);
if (!existsSync(targetDir)) throw new Error(`standalone build not found: ${targetDir}`);

const archive = join(artifactRoot, `${targetName}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
const command = process.platform === "win32" ? "tar.exe" : "tar";
const args = process.platform === "win32"
  ? ["-a", "-c", "-f", archive, "-C", artifactRoot, targetName]
  : ["-c", "-z", "-f", archive, "-C", artifactRoot, targetName];
const result = spawnSync(command, args, { encoding: "utf8" });
if (result.status !== 0) throw new Error(`could not create ${basename(archive)}: ${result.stderr || result.stdout}`);

const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${hash}  ${basename(archive)}\n`);
console.log(archive);
