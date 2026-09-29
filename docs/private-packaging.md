# Private packaging and installation

The distributable package is named `agent-sync-layer`, but it is deliberately private. `package.json` retains `"private": true`; this repository contains no npm publication or GitHub Release workflow. The procedures below create local files for private distribution among trusted collaborators.

## Private npm tarball

Build and verify a tarball from a clean checkout:

```bash
npm ci
npm run verify:package
npm run pack:private
```

Install the resulting package on a machine with Node.js 20.12 or newer:

```bash
npm install -g ./artifacts/npm/agent-sync-layer-0.1.0.tgz
asl
```

The tarball exposes both `asl` and `agent-sync`. It also provides the ESM SDK entry points `agent-sync-layer`, `agent-sync-layer/config`, `agent-sync-layer/server`, `agent-sync-layer/mcp`, and `agent-sync-layer/fuse`.

## Standalone executable

Build, exercise, and archive the executable for the current machine:

```bash
npm ci
npm run build:binary
npm run smoke:binary
node scripts/archive-binary.mjs
```

The archive appears under `artifacts/` with an adjacent `.sha256` file. Extract it and place `asl` (`asl.exe` on Windows) somewhere on `PATH`. The executable embeds Node.js, so the destination machine does not need Node.js or npm. Managed sessions still require Git and the selected `codex` or `claude` CLI on `PATH`.

Verify a downloaded archive before extracting it. Run `sha256sum -c <archive>.sha256` on Linux or `shasum -a 256 -c <archive>.sha256` on macOS from the directory containing both files. In PowerShell, compare `(Get-FileHash <archive> -Algorithm SHA256).Hash` with the first value in the `.sha256` file.

The standalone executable contains the managed hook workflow only. The optional FUSE adapter remains available through the npm package and still requires macFUSE or libfuse on the host; there is no WinFsp adapter.

macOS artifacts receive an ad-hoc signature so the injected executable can run, but they are not Developer ID signed or notarized. Windows artifacts are not Authenticode signed. Verify the SHA-256 file before trusting an archive and expect the operating system to identify it as coming from an unknown publisher.

## CI status

The GitHub Actions workflow is intentionally not checked in yet. The first attempt to push it was rejected because the repository's HTTPS Personal Access Token did not have GitHub's `workflow` scope. Keeping the workflow out of `master` allows the other private packaging changes to be pushed without broadening that token's permissions.

Until CI is restored, run the verification and packaging commands above on each target platform. The intended private CI matrix remains:

- `agent-sync-layer-linux-x64`
- `agent-sync-layer-windows-x64`
- `agent-sync-layer-macos-x64`
- `agent-sync-layer-macos-arm64`
- `agent-sync-layer-npm`

When CI is restored, it should run the build, full test suite, linked CLI smoke test, package verification, native lifecycle smoke test, archive step, and checksum step. Artifacts should remain private and expire after 14 days. Restoring `.github/workflows/ci.yml` requires pushing with a GitHub credential authorized to create or update workflow files, or committing through an approved GitHub interface.

Public npm metadata, licensing, signing identities, permanent GitHub Releases, and package-manager manifests are intentionally deferred until the repository owner chooses to publish.
