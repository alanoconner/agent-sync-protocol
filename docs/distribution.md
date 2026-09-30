# Maintainer release guide

Agent Sync Layer is distributed through npm and GitHub Release archives. This guide is for maintainers publishing a new version, not for end users installing ASL.

## Release outputs

Every public version should provide:

- the `agent-sync-layer` npm package;
- Linux x64 standalone archive and checksum;
- Windows x64 standalone archive and checksum;
- macOS x64 standalone archive and checksum;
- macOS ARM64 standalone archive and checksum;
- release notes describing behavior changes, limitations, and upgrade considerations.

The npm package exposes the `asl` and `agent-sync` binaries plus five ESM entry points. Standalone executables contain the managed hook workflow and omit optional FUSE support.

## Before publishing

1. Confirm the working tree is clean and the release commit is pushed.
2. Update `version` in `package.json` and `package-lock.json` together.
3. Update `CHANGELOG.md`.
4. Confirm the license and public package metadata.
5. Verify that README installation commands match the intended release channels.
6. Run the complete verification suite from a clean dependency installation.

```bash
npm ci
npm run typecheck
npm run typecheck:examples
npm test
npm run build
npm run verify:package
npm publish --dry-run
```

Inspect `npm publish --dry-run` output for secrets, source files, tests, local configuration, or generated artifacts that should not ship.

## Verify the npm package

`npm run verify:package` creates a temporary tarball and consumer project. It verifies:

- the expected allowlisted files;
- both CLI command names;
- all package export paths;
- emitted TypeScript declarations;
- absence of source, tests, examples, scripts, and CI configuration.

To retain a local tarball for manual inspection:

```bash
npm run pack:package
```

This writes the package to `artifacts/npm/` without publishing it.

## Build standalone archives

Build on each target operating system and architecture. The SEA build copies and injects the current platform's Node.js executable, so it is not a cross-compilation command.

```bash
npm ci
npm run build:binary
npm run smoke:binary
node scripts/archive-binary.mjs
```

The archive and adjacent SHA-256 file appear under `artifacts/`.

Expected names for version `X.Y.Z`:

```text
agent-sync-layer-vX.Y.Z-linux-x64.tar.gz
agent-sync-layer-vX.Y.Z-linux-x64.tar.gz.sha256
agent-sync-layer-vX.Y.Z-windows-x64.zip
agent-sync-layer-vX.Y.Z-windows-x64.zip.sha256
agent-sync-layer-vX.Y.Z-macos-x64.tar.gz
agent-sync-layer-vX.Y.Z-macos-x64.tar.gz.sha256
agent-sync-layer-vX.Y.Z-macos-arm64.tar.gz
agent-sync-layer-vX.Y.Z-macos-arm64.tar.gz.sha256
```

The lifecycle smoke test creates a disposable Git repository and proves that the executable can start its daemon, launch a fake agent, report status, and reset the session.

macOS outputs are ad-hoc signed after SEA injection so the modified Mach-O can execute, but they are not Developer ID signed or notarized. Windows outputs are not Authenticode signed. Treat trusted signing as a release-readiness decision, not as something the checksum replaces.

## Create a GitHub Release

Create and push an annotated version tag only after verification succeeds:

```bash
git tag -a vX.Y.Z -m "Agent Sync Layer vX.Y.Z"
git push origin vX.Y.Z
```

Create a draft release so all assets can be checked before publication:

```bash
gh release create vX.Y.Z \
  --verify-tag \
  --draft \
  --title "Agent Sync Layer vX.Y.Z" \
  --generate-notes
```

Upload every platform archive and checksum:

```bash
gh release upload vX.Y.Z artifacts/*.tar.gz artifacts/*.zip artifacts/*.sha256
```

Inspect the draft in GitHub, download at least one asset through the release page, verify its checksum, and confirm the archive layout. Then publish:

```bash
gh release edit vX.Y.Z --draft=false
```

Do not move a published version tag or silently replace release assets. Publish a new patch version for corrections.

## Publish to npm

For an interactive first publication:

```bash
npm login
npm whoami
npm publish --access public
```

After publication, test from a directory outside the repository:

```bash
npm install --global agent-sync-layer@X.Y.Z
asl
```

For automated releases, prefer npm trusted publishing with a GitHub-hosted runner and OIDC instead of a long-lived write token. Restrict the workflow to version tags or published GitHub Releases, grant only `contents: read` and `id-token: write`, and ensure the npm trusted-publisher configuration exactly matches the repository and workflow filename.

## CI release matrix

A release workflow should use native jobs for:

- Linux x64;
- Windows x64;
- macOS x64;
- macOS ARM64;
- one Linux npm verification and publication job.

Recommended flow:

1. Test once on each supported operating system.
2. Build and smoke-test each native executable.
3. Upload intermediate artifacts to a release aggregation job.
4. Attach archives and checksums to a draft release.
5. Publish npm only after package verification succeeds.
6. Publish the GitHub Release after every expected asset is present.

## Post-release checklist

- Confirm `npm view agent-sync-layer version` reports the new version.
- Install the package in a clean environment and run `asl`.
- Download and checksum each GitHub Release asset.
- Confirm README links resolve from both GitHub and the npm package page.
- Confirm the GitHub Release is marked latest when appropriate.
- Create an issue or follow-up release for any signing or platform gap discovered after publication.
