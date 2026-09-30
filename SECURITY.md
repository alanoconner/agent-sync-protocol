# Security policy

## Supported versions

Until the first stable release, security fixes target the latest published version only. Users should upgrade to the newest release before reporting a problem that may already be fixed.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting feature for the repository when available. If private reporting is not enabled, contact the repository owner privately through their GitHub profile and request a secure reporting channel. Do not include exploit details or sensitive repository content in a public message.

Please include:

- the affected ASL version and installation method;
- operating system and Node.js version, when applicable;
- the affected command, protocol path, or adapter;
- reproduction steps or a minimal proof of concept;
- expected impact and any known mitigation;
- whether the issue has been disclosed elsewhere.

You should receive an acknowledgement within seven days. A remediation timeline depends on severity, reproducibility, and release-signing requirements.

## Security boundaries

Agent Sync Layer is local developer tooling with deliberate access to source repositories and Git metadata. Its trust model includes these boundaries:

- The managed synchronization daemon and control API bind to loopback.
- Repository-defined setup and validation commands execute shell code only after ASL displays them and records first-use trust.
- Codex independently requires users to review and trust non-managed project hooks.
- Hook coverage is not a general operating-system sandbox. Background processes, ignored files, binary files, and specialized tool paths may bypass synchronization.
- The optional validation command is supplied by the repository and runs with the invoking user's permissions.
- Standalone release checksums establish file integrity but are not a substitute for trusted code signing.
- The experimental FUSE adapter expands the local attack surface and should not be exposed to untrusted users or repositories.

Review `.agent-sync.yml`, the Git repository, and all hook/setup commands before approving them. Use ASL only with repositories and coding-agent executables you trust.
