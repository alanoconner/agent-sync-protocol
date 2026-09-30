import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const expectedRepository = "git+https://github.com/alanoconner/agent-sync-protocol.git";
const expectedRegistry = "https://registry.npmjs.org/";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

requireValue(packageJson.name === "agent-sync-layer", `unexpected package name: ${packageJson.name}`);
requireValue(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version), `invalid release version: ${packageJson.version}`);
requireValue(packageJson.private !== true, "package.json is private");
requireValue(packageJson.license === "MIT", `unexpected license: ${packageJson.license}`);
requireValue(packageJson.repository?.url === expectedRepository, `repository.url must be ${expectedRepository}`);
requireValue(packageJson.publishConfig?.registry === expectedRegistry, `publishConfig.registry must be ${expectedRegistry}`);
requireValue(packageJson.publishConfig?.access === "public", "publishConfig.access must be public");
requireValue(Array.isArray(packageJson.files) && packageJson.files.includes("dist/"), "package files must include dist/");

const releaseTag = process.env.GITHUB_REF_NAME || process.env.ASL_RELEASE_TAG;
const expectedTag = `v${packageJson.version}`;
if (releaseTag) requireValue(releaseTag === expectedTag, `release tag ${releaseTag} does not match package version ${expectedTag}`);

console.log(`Release metadata is valid for ${packageJson.name}@${packageJson.version}${releaseTag ? ` (${releaseTag})` : ""}.`);
