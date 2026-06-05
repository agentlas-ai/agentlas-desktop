# Security Policy

## Supported versions

We ship security fixes for the latest stable release only. There's no LTS branch — please upgrade to the most recent version listed on the [Releases page](https://github.com/agentlas-ai/agentlas-desktop/releases/latest) before reporting.

The in-app "Check for Updates…" menu item (under the **Agentlas** application menu on macOS) verifies whether you're current.

## Reporting a vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.** Public reports give attackers a head start while we work on a fix.

Instead, email **appbridge@appbridge.co.kr** with:

- A description of the issue and its impact (what an attacker could do)
- Steps to reproduce — ideally a minimal proof-of-concept
- The version of Agentlas Desktop you're running (visible in the sidebar footer or **About Agentlas**)
- Your macOS version
- (Optional) Whether you want to be credited in the release notes

We'll acknowledge receipt within **3 business days** and provide a substantive response within **10 business days**, including a rough timeline for a fix.

## What's in scope

- Remote code execution via the desktop app
- Privilege escalation, sandbox escape, or arbitrary file access beyond what the user explicitly granted
- Exfiltration of API keys, session cookies, or other credentials stored in the macOS Keychain
- Auto-updater attacks (e.g., serving a tampered DMG that passes notarization checks)
- IPC vulnerabilities that let renderer code call privileged main-process APIs it shouldn't have access to
- Cryptographic weaknesses (weak hashes, predictable randomness, missing signature checks)

## What's out of scope

- Vulnerabilities in third-party services that Agentlas connects to (Anthropic API, OpenAI API, Google API, agentlas.cloud) — please report those upstream.
- Issues that require the user to install a malicious binary or grant elevated OS-level permissions to an attacker.
- Bugs that aren't security-relevant — those should be regular GitHub issues.
- Social engineering, phishing, or attacks that depend on a compromised macOS / iCloud account.

## Coordinated disclosure

Once a fix is ready we'll:

1. Cut a new release with the patch.
2. Wait at least 72 hours after the release to let users auto-update.
3. Publish a security advisory on the GitHub repo with credit to the reporter (unless you ask to remain anonymous).

If you discover that someone is actively exploiting an issue, let us know in the same email — we'll move faster.

## Known boundaries

A few things are intentional design choices, not vulnerabilities:

- **The app talks to agentlas.cloud over HTTPS to fetch the marketplace catalog and (optionally) to sign you in.** This traffic is not anonymized.
- **API keys you enter under Settings → BYOK are stored in the macOS Keychain.** If your Mac is compromised, those keys are at risk — like any other app.
- **Auto-update downloads happen over HTTPS from GitHub Releases**, verified by the signature in `latest-mac.yml`. We trust GitHub's HTTPS and Apple's notarization chain.
