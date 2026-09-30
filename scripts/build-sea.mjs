import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import postject from "postject";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const platformName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
if (!(["windows", "macos", "linux"].includes(platformName))) {
  throw new Error(`unsupported SEA build platform: ${process.platform}`);
}
if (!(process.arch === "x64" || process.arch === "arm64")) {
  throw new Error(`unsupported SEA build architecture: ${process.arch}`);
}

const artifactRoot = resolve(process.env.ASL_ARTIFACT_DIR ?? join(root, "artifacts"));
const targetName = `${pkg.name}-v${pkg.version}-${platformName}-${process.arch}`;
const targetDir = join(artifactRoot, targetName);
const executable = join(targetDir, process.platform === "win32" ? "asl.exe" : "asl");
const temporary = mkdtempSync(join(tmpdir(), "asl-sea-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${basename(command)} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

try {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  const bundle = join(temporary, "asl.cjs");
  const blob = join(temporary, "sea-prep.blob");
  const config = join(temporary, "sea-config.json");

  await esbuild.build({
    entryPoints: [join(root, "src", "cli", "index.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    packages: "bundle",
    external: ["fuse-native"],
    define: { ASL_SEA: "true" },
    logOverride: { "empty-import-meta": "silent" },
  });
  writeFileSync(config, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }, null, 2));
  run(process.execPath, ["--experimental-sea-config", config]);

  copyFileSync(process.execPath, executable);
  if (process.platform === "darwin") run("codesign", ["--remove-signature", executable]);
  await postject.inject(executable, "NODE_SEA_BLOB", readFileSync(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    machoSegmentName: "NODE_SEA",
  });
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", executable]);

  const smoke = run(executable, []);
  if (!smoke.stdout.includes("Usage: asl")) throw new Error("SEA smoke test did not print the ASL usage text");
  copyFileSync(join(root, "README.md"), join(targetDir, "README.md"));
  copyFileSync(join(root, "CHANGELOG.md"), join(targetDir, "CHANGELOG.md"));
  copyFileSync(join(root, "docs", "installation.md"), join(targetDir, "INSTALL.md"));
  console.log(executable);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
