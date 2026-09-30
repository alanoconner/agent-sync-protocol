# Install Agent Sync Layer

Agent Sync Layer provides two end-user distributions:

1. An npm package containing the `asl` CLI and the TypeScript/JavaScript SDK.
2. Standalone operating-system archives containing an `asl` executable with Node.js embedded.

Choose the npm package when Node.js is already part of your development environment or when you need the SDK. Choose a standalone archive when you only need the CLI.

## Prerequisites

Every installation requires:

- Git on `PATH`.
- Git author identity configured through `git config user.name` and `git config user.email`.
- Codex CLI or Claude Code on `PATH`, depending on which agent you launch.
- A normal Git checkout. ASL does not start managed sessions from bare repositories, detached `HEAD`, or dirty source checkouts.

The npm package additionally requires Node.js 20.12 or newer.

Native Windows installations require Git for Windows. ASL supports PowerShell, Command Prompt, and Git Bash. Claude Code hook commands run through Git Bash; set `CLAUDE_CODE_GIT_BASH_PATH` only when Git is installed in a nonstandard location that ASL cannot discover.

## Install with npm

Install globally:

```bash
npm install --global agent-sync-layer
```

Confirm the CLI is available:

```bash
asl
```

The package installs two equivalent command names:

```bash
asl
agent-sync
```

It also exposes the SDK entry points documented in the [README](../README.md#library-and-integration-apis).

### Upgrade or uninstall the npm package

```bash
npm install --global agent-sync-layer@latest
npm uninstall --global agent-sync-layer
```

ASL session state is stored separately under `~/.asl` and is not automatically removed by uninstalling the package. Finish, clean, or reset active sessions before uninstalling.

## Install a standalone release

Open the [latest GitHub Release](https://github.com/alanoconner/agent-sync-protocol/releases/latest) and download the archive matching your system:

| System | Release asset |
|---|---|
| Linux x64 | `agent-sync-layer-v<VERSION>-linux-x64.tar.gz` |
| Windows x64 | `agent-sync-layer-v<VERSION>-windows-x64.zip` |
| macOS Intel | `agent-sync-layer-v<VERSION>-macos-x64.tar.gz` |
| macOS Apple silicon | `agent-sync-layer-v<VERSION>-macos-arm64.tar.gz` |

Download the adjacent `.sha256` file too.

### Verify the checksum

Linux:

```bash
sha256sum --check agent-sync-layer-v<VERSION>-linux-x64.tar.gz.sha256
```

macOS:

```bash
shasum -a 256 --check agent-sync-layer-v<VERSION>-macos-arm64.tar.gz.sha256
```

Windows PowerShell:

```powershell
Get-FileHash .\agent-sync-layer-v<VERSION>-windows-x64.zip -Algorithm SHA256
Get-Content .\agent-sync-layer-v<VERSION>-windows-x64.zip.sha256
```

The computed hexadecimal hashes must match exactly before you extract or run the executable.

### Install on Linux

```bash
tar -xzf agent-sync-layer-v<VERSION>-linux-x64.tar.gz
sudo install -m 0755 agent-sync-layer-v<VERSION>-linux-x64/asl /usr/local/bin/asl
asl
```

For a user-only installation, copy `asl` to a directory already present on your personal `PATH`, such as `~/.local/bin`.

### Install on macOS

Choose the archive that matches the output of `uname -m`:

- `arm64` means Apple silicon.
- `x86_64` means Intel.

Then extract and install:

```bash
tar -xzf agent-sync-layer-v<VERSION>-macos-arm64.tar.gz
sudo install -m 0755 agent-sync-layer-v<VERSION>-macos-arm64/asl /usr/local/bin/asl
asl
```

Current macOS builds are ad-hoc signed rather than Developer ID signed and notarized. macOS may identify the binary as coming from an unknown developer. Verify the checksum and inspect the release before deciding whether to run it.

### Install on Windows

1. Verify the checksum in PowerShell.
2. Extract the ZIP file.
3. Move `asl.exe` to a stable directory, for example `%LOCALAPPDATA%\Programs\ASL`.
4. Add that directory to your user `PATH`.
5. Open a new terminal and run `asl`.

Current Windows builds are not Authenticode signed and may display an unknown-publisher warning. Verify the checksum before deciding whether to run the executable.

### Upgrade or uninstall a standalone release

To upgrade, verify and extract the new release, then replace the existing executable. To uninstall, remove the executable from the directory on your `PATH`. Session data under `~/.asl` or the Windows home-directory equivalent remains until you finish or reset those sessions.

## Install from source

Source installation is intended for contributors and unreleased builds:

```bash
git clone https://github.com/alanoconner/agent-sync-protocol.git
cd agent-sync-protocol
npm ci
npm run build
npm link
asl
```

To remove the link later:

```bash
npm unlink --global agent-sync-layer
```

## Optional FUSE support

The npm package declares `fuse-native` as an optional dependency. The managed `asl codex` and `asl claude` workflow does not use FUSE.

Install macFUSE on macOS or libfuse on Linux only if you are intentionally developing against the experimental FUSE adapter. The standalone executable omits FUSE, and there is no WinFsp implementation.

## Next step

Continue with [Your first synchronized session](getting-started.md).
