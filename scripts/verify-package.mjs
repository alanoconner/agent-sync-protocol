import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCli = process.env.npm_execpath;
const temporary = mkdtempSync(join(tmpdir(), "asl-package-"));
const packDir = join(temporary, "pack");
const consumer = join(temporary, "consumer");
const npmEnv = { ...process.env, npm_config_cache: join(temporary, "npm-cache") };
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.name !== "agent-sync-layer") throw new Error(`unexpected package name: ${packageJson.name}`);
if (packageJson.private !== true) throw new Error("package.json must remain private until publication is explicitly enabled");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

function runNpm(args, options = {}) {
  return npmCli
    ? run(process.execPath, [npmCli, ...args], options)
    : run(process.platform === "win32" ? "npm.cmd" : "npm", args, { ...options, shell: process.platform === "win32" });
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  const packed = runNpm(["pack", "--json", "--silent", "--pack-destination", packDir], { cwd: root, env: npmEnv });
  const [manifest] = JSON.parse(packed.stdout);
  const paths = manifest.files.map((file) => file.path);
  const required = [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "docs/asl-cli.md",
    "docs/installation.md",
    "docs/getting-started.md",
    "docs/distribution.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/config.js",
    "dist/server.js",
    "dist/mcp.js",
    "dist/fuse.js",
    "dist/cli/index.js",
  ];
  for (const path of required) {
    if (!paths.includes(path)) throw new Error(`packed package is missing ${path}`);
  }
  const forbidden = ["src/", "test/", "examples/", "scripts/", ".github/"];
  const leaked = paths.find((path) => forbidden.some((prefix) => path.startsWith(prefix)));
  if (leaked) throw new Error(`packed package unexpectedly contains ${leaked}`);

  const tarball = join(packDir, manifest.filename);
  runNpm(["init", "--yes", "--silent"], { cwd: consumer, env: npmEnv });
  runNpm(["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", tarball], { cwd: consumer, env: npmEnv });

  const binExtension = process.platform === "win32" ? ".cmd" : "";
  for (const name of ["asl", "agent-sync"]) {
    const binary = join(consumer, "node_modules", ".bin", `${name}${binExtension}`);
    if (!existsSync(binary)) throw new Error(`installed package is missing the ${name} bin`);
    const result = run(binary, [], { cwd: consumer });
    if (!result.stdout.includes("Usage: asl")) throw new Error(`${name} did not print the ASL usage text`);
  }

  const runtimeCheck = `
    const root = await import("agent-sync-layer");
    const config = await import("agent-sync-layer/config");
    const server = await import("agent-sync-layer/server");
    const mcp = await import("agent-sync-layer/mcp");
    const fuse = await import("agent-sync-layer/fuse");
    for (const [label, value] of Object.entries({
      SyncClient: root.SyncClient,
      SyncFileOps: root.SyncFileOps,
      parseAgentSyncConfig: config.parseAgentSyncConfig,
      SyncServer: server.SyncServer,
      McpSyncProxy: mcp.McpSyncProxy,
      mountSyncFs: fuse.mountSyncFs,
    })) if (typeof value !== "function") throw new Error(label + " was not exported");
  `;
  run(process.execPath, ["--input-type=module", "--eval", runtimeCheck], { cwd: consumer });

  writeFileSync(join(consumer, "consumer.ts"), `
import { SyncClient, SyncFileOps, type SyncClientOptions } from "agent-sync-layer";
import { parseAgentSyncConfig, type AgentSyncConfig } from "agent-sync-layer/config";
import { SyncServer, type ServerStatus } from "agent-sync-layer/server";
import { McpSyncProxy, type MappingConfig } from "agent-sync-layer/mcp";
import { mountSyncFs, type MountOptions } from "agent-sync-layer/fuse";

const clientOptions: SyncClientOptions = { serverUrl: "ws://localhost:4600", docName: "file.txt" };
const config: AgentSyncConfig = parseAgentSyncConfig("");
const mapping: MappingConfig = { mappings: [] };
const mount: MountOptions = { mountPath: "/tmp/asl", config };
const status = null as ServerStatus | null;
void [SyncClient, SyncFileOps, SyncServer, McpSyncProxy, mountSyncFs, clientOptions, mapping, mount, status];
  `.trimStart());
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      typeRoots: [join(root, "node_modules", "@types")],
    },
    files: ["consumer.ts"],
  }, null, 2));
  run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: consumer });

  console.log(`Verified ${manifest.id}: ${manifest.entryCount} files, both bins, five export paths, and declarations.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
