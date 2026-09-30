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
npm run release:check
npm publish --dry-run
```

`release:check` validates the package metadata and release tag, type-checks the library and examples, runs the test suite, builds and tests an isolated package consumer, and audits production dependencies. `npm publish` and `npm publish --dry-run` run the same checks automatically through `prepublishOnly`.

Inspect the dry-run output for secrets, source files, tests, local configuration, or generated artifacts that should not ship.

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

## First npm publication

The trusted-publishing workflow cannot publish a package that does not exist on npm yet. Publish the first version interactively from the release commit:

```bash
npm login
npm whoami
ASL_RELEASE_TAG=v0.1.0 npm run release:check
npm publish --access public
```

Replace `v0.1.0` with `vX.Y.Z` for the version in `package.json`. npm package names are first-come, first-served, so confirm the name immediately before publication:

```bash
npm view agent-sync-layer
```

The `publishConfig` in `package.json` restricts publication to the public npm registry and public access. Never publish with `--force`, and do not reuse a released version number.

After the first publication, test from a directory outside the repository:

```bash
npm install --global agent-sync-layer@X.Y.Z
asl --help
```

## Configure trusted publishing

After the package exists, open its settings on npm and add a GitHub Actions trusted publisher with these exact values:

| npm setting | Value |
| --- | --- |
| Organization or user | `alanoconner` |
| Repository | `agent-sync-protocol` |
| Workflow filename | `publish-npm.yml` |
| Environment | `npm` |

Then create a GitHub environment named `npm`. Optional environment protection rules, such as required reviewers, provide a manual approval gate before publication.

The workflow at `.github/workflows/publish-npm.yml` runs when a GitHub Release is published. It checks out that release's tag, uses a GitHub-hosted runner with Node.js 24 and npm 11.5 or newer, requests only `contents: read` and `id-token: write`, reruns the full release checks, and publishes with a short-lived OIDC credential. It does not store an npm token.

The npm trusted-publisher settings must match the repository, workflow filename, and environment exactly. The package version must also match the GitHub Release tag (`1.2.3` and `v1.2.3`, respectively), or the release check fails before publication.

Trusted publishing works from a private GitHub repository, but npm cannot generate provenance attestations for private source repositories. Make the repository public before publishing if public provenance is a release requirement.

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
- Confirm the npm version displays trusted-publisher provenance when the repository is public.
- Confirm the GitHub Release is marked latest when appropriate.
- Create an issue or follow-up release for any signing or platform gap discovered after publication.
