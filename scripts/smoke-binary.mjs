import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const platformName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
const defaultExecutable = join(
  projectRoot,
  "artifacts",
  `${pkg.name}-v${pkg.version}-${platformName}-${process.arch}`,
  process.platform === "win32" ? "asl.exe" : "asl",
);
const executable = resolve(process.argv[2] ?? defaultExecutable);

const root = mkdtempSync(join(tmpdir(), "asl-sea-smoke-"));
const repo = join(root, "repo");
const state = join(root, "state");
const env = { ...process.env, ASL_STATE_DIR: state };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env, ...options });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${basename(command)} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

try {
  run("git", ["init", "--quiet", "--initial-branch=main", repo]);
  run("git", ["-C", repo, "config", "user.name", "ASL Binary Smoke"]);
  run("git", ["-C", repo, "config", "user.email", "asl-binary@example.test"]);
  writeFileSync(join(repo, "README.md"), "standalone smoke test\n");
  const fakeAgent = join(repo, process.platform === "win32" ? "fake-agent.cmd" : "fake-agent.sh");
  if (process.platform === "win32") {
    writeFileSync(fakeAgent, "@echo off\r\nexit /b 0\r\n");
  } else {
    writeFileSync(fakeAgent, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeAgent, 0o755);
  }
  run("git", ["-C", repo, "add", "README.md", basename(fakeAgent)]);
  run("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"]);

  const launch = run(executable, ["codex", "--yes", "--skip-setup", "--bin", fakeAgent], { cwd: repo });
  if (!launch.stdout.includes("codex workspace")) throw new Error("standalone launcher did not create an agent workspace");
  const status = JSON.parse(run(executable, ["status", "--json"], { cwd: repo }).stdout);
  if (!status.daemon?.running) throw new Error("standalone launcher did not self-spawn a running daemon");
  if (status.agents?.[0]?.status !== "exited") throw new Error("fake agent did not exit cleanly");

  const reset = run(executable, ["reset"], { cwd: repo });
  if (!reset.stdout.includes("removed all managed worktrees, branches, and state")) {
    throw new Error("standalone reset did not clean the managed session");
  }
  console.log(`Verified standalone lifecycle for ${executable}`);
} finally {
  if (process.env.ASL_SMOKE_KEEP === "1") console.error(`Preserved smoke fixture at ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
